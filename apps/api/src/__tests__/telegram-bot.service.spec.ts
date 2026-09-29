// Пункт [job-domain-v2] К-20 — входящий вебхук бота: разбор update'а и путь
// «переслал → вакансия в проекте → ответ, куда сохранено».
//
// Главное здесь — не «работает ли», а ЧТО ИМЕННО НЕ ПОПАДАЕТ В СИСТЕМУ:
// личность автора пересланного сообщения (третье лицо, не дававшее нам
// согласия) и решения за пользователя.
import { ProjectMode } from '@prisma/client';
import { TelegramBotService } from '../telegram-bot/telegram-bot.service';
import { parseUpdate, MIN_FORWARD_TEXT_CHARS } from '../telegram-bot/telegram-update';
import { VacancyIntakeService, FORWARD_RETRY_WINDOW_MS } from '../vacancy-intake/vacancy-intake.service';
import { createHiringFakePrisma } from './fake-prisma';

// Отправку наружу перехватываем: тест не ходит в Telegram, но проверяет
// ТЕКСТ ответа — обещания продукта живут именно в нём.
jest.mock('../common/telegram-bot-client', () => {
  const outbox: Array<{ chatId: string; text: string }> = [];
  return {
    __outbox: outbox,
    TelegramSendError: class TelegramSendError extends Error {},
    sendTelegramMessage: jest.fn(async (_token: string, chatId: string, text: string) => {
      outbox.push({ chatId, text });
    }),
  };
});
const sent: Array<{ chatId: string; text: string }> = require('../common/telegram-bot-client').__outbox;
// Сеть не нужна: пересылка приходит текстом. Мокаем только загрузку,
// остальное модуля (классы ошибок, проверка адреса) оставляем настоящим —
// иначе ломается импорт в самом сервисе.
jest.mock('../common/safe-url-fetch', () => ({
  ...jest.requireActual('../common/safe-url-fetch'),
  fetchUrlText: jest.fn(async () => ''),
}));

const VACANCY_TEXT =
  'Ищем Node.js-разработчика в продуктовую команду. Удалённо, оплата 2500–3000 USD, испытательный срок два месяца. Откликаться по ссылке https://work.ua/jobs/1';

function setup() {
  const prisma = createHiringFakePrisma();
  const intake = new VacancyIntakeService(prisma as any);
  const secrets = { resolve: async (ref: string) => (ref === 'TELEGRAM_BOT_TOKEN' ? 'bot-token' : 'secret') };
  const bot = new TelegramBotService(prisma as any, secrets as any, intake);
  sent.length = 0;
  return { prisma, bot, intake };
}

function seedUserWithProject(prisma: any, telegramId = '777', question = 'Ищу работу backend') {
  const user = prisma.seed('user', { telegramId });
  const project = prisma.seed('project', { ownerId: user.id, mode: ProjectMode.JOB_SEARCH, question, frozenAt: null });
  const config = prisma.seed('jobSearchConfig', { projectId: project.id, desiredRole: 'Backend', cvDraft: null });
  return { user, project, config };
}

const forwardedUpdate = (text: string, telegramId = '777') => ({
  update_id: 1,
  message: {
    chat: { id: 555, type: 'private' },
    from: { id: Number(telegramId), is_bot: false },
    text,
    // Telegram присылает автора исходного сообщения — мы его не читаем.
    forward_origin: { type: 'user', sender_user: { id: 42, first_name: 'Мария', username: 'maria_hr' } },
    forward_from: { id: 42, first_name: 'Мария', username: 'maria_hr' },
    forward_sender_name: 'Мария',
    forward_date: 1_700_000_000,
  },
});

describe('parseUpdate — граница приватности и что мы вообще обрабатываем', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: из пересланного сообщения наружу выходит только текст и id нашего пользователя — ни одного поля об авторе', () => {
    const parsed = parseUpdate(forwardedUpdate(VACANCY_TEXT) as any);
    expect(parsed).toEqual({ kind: 'forwarded', telegramId: '777', chatId: '555', text: VACANCY_TEXT });
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain('maria');
    expect(serialized).not.toContain('Мария');
    expect(serialized).not.toContain('42');
    expect(serialized).not.toMatch(/forward_/i);
  });

  it('не-пересланный текст не считается вакансией; /start отдаёт нагрузку; чужое и групповое — игнорируется с причиной', () => {
    const plain = parseUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 777 }, text: 'привет, а как это работает?' } } as any);
    expect(plain.kind).toBe('plain_text');

    expect(parseUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 777 }, text: '/start preq_abc' } } as any)).toMatchObject({ kind: 'start', payload: 'preq_abc' });
    expect(parseUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 777 }, text: '/start' } } as any)).toMatchObject({ kind: 'start', payload: null });

    expect(parseUpdate({ message: { chat: { id: 1, type: 'supergroup' }, from: { id: 777 }, text: 'x' } } as any).kind).toBe('ignored');
    expect(parseUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 9, is_bot: true }, text: 'x' } } as any).kind).toBe('ignored');
    expect(parseUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 777 } } } as any).kind).toBe('ignored'); // фото без текста
    expect(parseUpdate(undefined).kind).toBe('ignored');
  });
});

describe('TelegramBotService — путь пересланной вакансии', () => {
  it('вакансия сохраняется в проект поиска работы, ссылка вытаскивается из текста, ответ называет проект и не обещает решения за человека', async () => {
    const s = setup();
    const { project, config } = seedUserWithProject(s.prisma);

    const res = await s.bot.handleUpdate(forwardedUpdate(VACANCY_TEXT) as any);
    expect(res).toMatchObject({ ok: true, handled: 'forwarded' });

    const vacancies = s.prisma.rows('jobVacancy');
    expect(vacancies).toHaveLength(1);
    expect(vacancies[0]).toMatchObject({ configId: config.id, intakeSource: 'TELEGRAM_FORWARD', sourceUrl: 'https://work.ua/jobs/1' });
    expect(vacancies[0].rawText).toContain('Node.js-разработчика');
    // личность автора не сохранена нигде
    expect(JSON.stringify(vacancies[0])).not.toMatch(/maria|Мария|forward_origin/i);

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe('555');
    expect(sent[0].text).toContain(project.question);
    expect(sent[0].text).toMatch(/сам за вас ничего не решаю/);
    expect(sent[0].text).not.toMatch(/подходит|не подходит|балл/i);
  });

  it('повторная доставка того же update (ретрай Telegram) не создаёт вторую вакансию', async () => {
    const s = setup();
    seedUserWithProject(s.prisma);
    await s.bot.handleUpdate(forwardedUpdate(VACANCY_TEXT) as any);
    await s.bot.handleUpdate(forwardedUpdate(VACANCY_TEXT) as any);
    expect(s.prisma.rows('jobVacancy')).toHaveLength(1);
    // а за пределами окна ретрая та же пересылка — уже осознанное действие
    s.prisma.rows('jobVacancy')[0].createdAt = new Date(Date.now() - FORWARD_RETRY_WINDOW_MS - 1000);
    await s.bot.handleUpdate(forwardedUpdate(VACANCY_TEXT) as any);
    expect(s.prisma.rows('jobVacancy')).toHaveLength(2);
  });

  it('без пользователя и без проекта поиска работы бот НЕ создаёт их сам, а объясняет, чего не хватает', async () => {
    const s = setup();
    // незнакомый пользователь
    await s.bot.handleUpdate(forwardedUpdate(VACANCY_TEXT, '999') as any);
    expect(s.prisma.rows('jobVacancy')).toHaveLength(0);
    expect(sent[sent.length - 1].text).toMatch(/не открывали приложение/);

    // пользователь есть, проекта поиска работы нет
    s.prisma.seed('user', { telegramId: '888' });
    await s.bot.handleUpdate(forwardedUpdate(VACANCY_TEXT, '888') as any);
    expect(s.prisma.rows('project')).toHaveLength(0);
    expect(s.prisma.rows('jobVacancy')).toHaveLength(0);
    expect(sent[sent.length - 1].text).toMatch(/такого проекта у вас пока нет/);
  });

  it('пересылка идёт в последний проект, с которым человек работал, и ответ это называет', async () => {
    const s = setup();
    const first = seedUserWithProject(s.prisma, '777', 'Старый поиск');
    const user = s.prisma.rows('user')[0];
    const second = s.prisma.seed('project', { ownerId: user.id, mode: ProjectMode.JOB_SEARCH, question: 'Новый поиск', frozenAt: null });
    s.prisma.seed('jobSearchConfig', { projectId: second.id, desiredRole: 'Backend', cvDraft: null });
    first.project.updatedAt = new Date(Date.now() - 86_400_000);
    second.updatedAt = new Date();

    await s.bot.handleUpdate(forwardedUpdate(VACANCY_TEXT) as any);
    expect(sent[sent.length - 1].text).toContain('Новый поиск');
    const vacancy = s.prisma.rows('jobVacancy')[0];
    expect(vacancy.configId).toBe(s.prisma.rows('jobSearchConfig').find((c: any) => c.projectId === second.id)!.id);
  });

  it('короткая пересылка и обычное сообщение вакансией не становятся — бот подсказывает действие, а не угадывает', async () => {
    const s = setup();
    seedUserWithProject(s.prisma);
    await s.bot.handleUpdate(forwardedUpdate('спасибо!') as any);
    expect(s.prisma.rows('jobVacancy')).toHaveLength(0);
    expect(sent[sent.length - 1].text).toMatch(/слишком мало текста/);
    expect('спасибо!'.length).toBeLessThan(MIN_FORWARD_TEXT_CHARS);

    const res = await s.bot.handleUpdate({ message: { chat: { id: 555, type: 'private' }, from: { id: 777 }, text: VACANCY_TEXT } } as any);
    expect(res.handled).toBe('plain_text');
    expect(s.prisma.rows('jobVacancy')).toHaveLength(0);
    expect(sent[sent.length - 1].text).toMatch(/перешлите исходное сообщение/i);
  });

  it('сбой обработки не роняет вебхук: ответ всегда ok, иначе Telegram будет повторять доставку бесконечно', async () => {
    const s = setup();
    seedUserWithProject(s.prisma);
    jest.spyOn(s.intake, 'fromForwardedMessage').mockRejectedValueOnce(new Error('база недоступна'));
    const res = await s.bot.handleUpdate(forwardedUpdate(VACANCY_TEXT) as any);
    expect(res.ok).toBe(true);
    expect(sent[sent.length - 1].text).toMatch(/Не удалось обработать сообщение/);
  });

  it('/start с нагрузкой возвращает ссылку запуска, без нагрузки — приветствие', async () => {
    process.env.TELEGRAM_BOT_USERNAME = 'devils_advocate_test_bot';
    const s = setup();
    seedUserWithProject(s.prisma);
    await s.bot.handleUpdate({ message: { chat: { id: 555, type: 'private' }, from: { id: 777 }, text: '/start preq_abc' } } as any);
    expect(sent[sent.length - 1].text).toContain('preq_abc');
    await s.bot.handleUpdate({ message: { chat: { id: 555, type: 'private' }, from: { id: 777 }, text: '/start' } } as any);
    expect(sent[sent.length - 1].text).toMatch(/пересылать сообщения с вакансиями/);
  });
});

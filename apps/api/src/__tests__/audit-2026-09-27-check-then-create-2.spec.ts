// Пункт [check-then-create-2] 2026-09-27 — поведенческая половина.
//
// Каждое лечение проверяется ВЫЗОВОМ: фейковая база отдаёт P2002 ровно
// там, где его отдала бы настоящая, и спрашивается, что после этого
// получит человек. Проверка «в файле есть слово isUniqueViolation»
// доказывала бы только то, что слово написано; первая сверка именно так
// и мерила, и потому не заметила девятого места.
//
// Файл намеренно не читает исходники: замкнутость населения — вопрос
// другой, и она проверяется `audit-2026-09-27-race-population.spec.ts`.

import { BadRequestException, ConflictException, Logger } from '@nestjs/common';

import { LibraryService } from '../library/library.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TextToSpeechService } from '../text-to-speech/text-to-speech.service';
import { WorkingMaterialsService } from '../working-materials/working-materials.service';
import { ClientBriefService } from '../client-brief/client-brief.service';
import { EvaluationService } from '../evaluation/evaluation.service';
import { EmployerHiringService } from '../employer-hiring/employer-hiring.service';

/** Отказ базы ровно той формы, какую даёт Prisma. */
const P2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

const noAudit = { record: async () => undefined } as never;

describe('Пункт [check-then-create-2] 2026-09-27: что получит человек, проигравший гонку', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: отправка в библиотеку отвечает ТЕМ ЖЕ текстом, что и проверка до вставки', async () => {
    // Раньше проигравший гонку получал пятисотку вместо честного
    // объяснения — и терял разницу между «ждёт модерации» и «отклонена»,
    // а это разные вещи: в одном случае решение ещё впереди, в другом
    // оно уже принято.
    // Состояние победителя РАЗНОЕ у проверки и у гонки нарочно: если
    // отдать одно и то же, тест зеленел бы от ПРЕД-проверки, а ветка
    // гонки осталась бы непроверенной. Эта ловушка сработала на первой
    // версии теста — мутация «выдумать состояние победителя вместо
    // прочитанного» её пережила.
    let reads = 0;
    const prisma: any = {
      // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05:
      // счётчик расходов работает интерактивной формой `$transaction`.
      $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
      $executeRaw: async () => 1,
      project: { findFirst: async () => ({ id: 'p1', ownerId: 'u1' }) },
      libraryEntry: {
        // Первое чтение — пред-проверка: записи ещё нет.
        // Второе — уже после P2002: запись успел создать чужой вызов.
        findFirst: async () => (++reads === 1 ? null : { id: 'e1', status: 'REJECTED' }),
        create: async () => {
          throw P2002();
        },
      },
      argument: { findMany: async () => [{ text: 'аргумент', stance: 'PRO' }] },
    };
    const svc = new LibraryService(prisma, noAudit);
    await expect(svc.submitProject('u1', 'p1', 'заголовок', 'категория')).rejects.toThrow(BadRequestException);
    expect(reads).toBe(2);
    // Текст — про ОТКЛОНЁННУЮ запись, то есть прочитанный у победителя, а
    // не подставленный по умолчанию.
    reads = 0;
    await expect(svc.submitProject('u1', 'p1', 'заголовок', 'категория')).rejects.toThrow(/отклонили/);
  });

  it('обратная проба: состояние победителя не выдумывается — другое состояние даёт другой текст', async () => {
    // Иначе тест выше проходил бы и в мире, где текст один на все случаи,
    // то есть где отказ снова перестал называть настоящее состояние.
    const prisma: any = {
      // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05:
      // счётчик расходов работает интерактивной формой `$transaction`.
      $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
      $executeRaw: async () => 1,
      project: { findFirst: async () => ({ id: 'p1', ownerId: 'u1' }) },
      libraryEntry: {
        findFirst: async () => ({ id: 'e1', status: 'ACCEPTED' }),
        create: async () => {
          throw new Error('до вставки дело не доходит: запись видна сразу');
        },
      },
      argument: { findMany: async () => [{ text: 'аргумент', stance: 'PRO' }] },
    };
    const svc = new LibraryService(prisma, noAudit);
    await expect(svc.submitProject('u1', 'p1', 'заголовок', 'категория')).rejects.toThrow(/уже опубликован/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: проигравший гонку за лист условий получает ИДЕНТИФИКАТОР чужого листа', async () => {
    // Без него «лист уже открыт» — тупик: экран не может отправить
    // человека туда, где лист есть.
    let created = false;
    const prisma: any = {
      // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05:
      // счётчик расходов работает интерактивной формой `$transaction`.
      $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
      $executeRaw: async () => 1,
      jobVacancy: {
        findUnique: async () => ({
          id: 'v1', duplicateOfId: null, title: 'Вакансия', siteHost: null,
          config: { projectId: 'p1', project: { id: 'p1', ownerId: 'u1', mode: 'JOB_SEARCH' }, criteria: [] },
        }),
      },
      termsSheet: {
        findUnique: async () => null,
        findFirst: async () => (created ? { id: 'sheet-чужой' } : null),
        create: async () => {
          created = true;
          throw P2002();
        },
      },
      termsClause: { create: async () => ({ id: 'c1' }) },
    };
    const svc = new TermsSheetService(prisma, { proposeClauses: async () => ({ created: [], skipped: {} }) } as never, noAudit);
    await expect(svc.openForVacancy('u1', 'v1')).rejects.toThrow(ConflictException);
    try {
      await svc.openForVacancy('u1', 'v1');
      throw new Error('отказа не было');
    } catch (err) {
      const body = (err as ConflictException).getResponse() as { existingSheetId?: string };
      expect(body.existingSheetId).toBe('sheet-чужой');
    }
  });

  it('обратная проба: чужого листа не видно — пробрасывается исходный отказ, а не выдуманный id', async () => {
    const prisma: any = {
      // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05:
      // счётчик расходов работает интерактивной формой `$transaction`.
      $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
      $executeRaw: async () => 1,
      jobVacancy: {
        findUnique: async () => ({
          id: 'v1', duplicateOfId: null, title: 'Вакансия', siteHost: null,
          config: { projectId: 'p1', project: { id: 'p1', ownerId: 'u1', mode: 'JOB_SEARCH' }, criteria: [] },
        }),
      },
      termsSheet: {
        findUnique: async () => null,
        findFirst: async () => null,
        create: async () => {
          throw P2002();
        },
      },
      termsClause: { create: async () => ({ id: 'c1' }) },
    };
    const svc = new TermsSheetService(prisma, { proposeClauses: async () => ({ created: [], skipped: {} }) } as never, noAudit);
    await expect(svc.openForVacancy('u1', 'v1')).rejects.toThrow(/Unique constraint/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: версия материала сохраняется под ПЕРЕСЧИТАННЫМ номером, а разбор не теряется', async () => {
    // Окно здесь — весь вызов модели. Падение приходило после того, как
    // разбор уже сделан и оплачен, и человек терял готовую работу.
    const saved: Array<{ versionNumber: number; critique: string }> = [];
    let firstTry = true;
    const prisma: any = {
      // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05:
      // счётчик расходов работает интерактивной формой `$transaction`.
      $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
      $executeRaw: async () => 1,
      project: { findFirst: async () => ({ id: 'p1', ownerId: 'u1', question: 'вопрос', goal: 'цель' }) },
      workingMaterial: { findFirst: async () => ({ id: 'm1', projectId: 'p1' }) },
      materialVersion: {
        findFirst: async () => ({ versionNumber: firstTry ? 1 : 2 }),
        create: async ({ data }: any) => {
          if (firstTry) {
            firstTry = false;
            throw P2002(); // номер 2 занял параллельный вызов
          }
          saved.push({ versionNumber: data.versionNumber, critique: data.critique });
          return { id: 'ver', ...data };
        },
      },
      promptVersion: { findFirst: async () => null },
    };
    const router = { execute: async () => ({ text: JSON.stringify({ critique: 'разбор', editPrompt: 'правка' }), aiInferenceId: 'inf' }) };
    const svc = new WorkingMaterialsService(prisma, router as never);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const out = await svc.submitVersion('u1', 'p1', 'текст материала', 'm1');
      expect(saved).toEqual([{ versionNumber: 3, critique: 'разбор' }]);
      expect(out.version.versionNumber).toBe(3);
      // И оператору сказано, что номер сдвинулся: молча переставленная
      // нумерация выглядела бы как потерянная версия.
      expect(warn.mock.calls.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('обратная проба: без гонки номер не сдвигается и в лог ничего не идёт', async () => {
    const saved: number[] = [];
    const prisma: any = {
      // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05:
      // счётчик расходов работает интерактивной формой `$transaction`.
      $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
      $executeRaw: async () => 1,
      project: { findFirst: async () => ({ id: 'p1', ownerId: 'u1', question: 'вопрос', goal: null }) },
      workingMaterial: { findFirst: async () => ({ id: 'm1', projectId: 'p1' }) },
      materialVersion: {
        findFirst: async () => ({ versionNumber: 4 }),
        create: async ({ data }: any) => {
          saved.push(data.versionNumber);
          return { id: 'ver', ...data };
        },
      },
      promptVersion: { findFirst: async () => null },
    };
    const router = { execute: async () => ({ text: JSON.stringify({ critique: 'разбор', editPrompt: 'правка' }), aiInferenceId: 'inf' }) };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await new WorkingMaterialsService(prisma, router as never).submitVersion('u1', 'p1', 'текст', 'm1');
      expect(saved).toEqual([5]);
      expect(warn.mock.calls.length).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: номер версии обязан ВЫРАСТИ, даже если чужой записи ещё не видно', () => {
    // Перечитанный максимум может оказаться прежним: реплика отстала,
    // чужая строка ещё не видна. Без требования «номер должен вырасти»
    // повторная попытка вставила бы ТОТ ЖЕ номер, получила бы тот же
    // отказ и сожгла бы все попытки впустую — а разбор уже оплачен.
    const saved: number[] = [];
    let attempts = 0;
    const prisma: any = {
      // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05:
      // счётчик расходов работает интерактивной формой `$transaction`.
      $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
      $executeRaw: async () => 1,
      project: { findFirst: async () => ({ id: 'p1', ownerId: 'u1', question: 'вопрос', goal: null }) },
      workingMaterial: { findFirst: async () => ({ id: 'm1', projectId: 'p1' }) },
      materialVersion: {
        // Максимум ВСЕГДА прежний — чужую версию отсюда не видно.
        findFirst: async () => ({ versionNumber: 1 }),
        create: async ({ data }: any) => {
          attempts++;
          if (data.versionNumber <= 2) throw P2002(); // номер 2 занят
          saved.push(data.versionNumber);
          return { id: 'ver', ...data };
        },
      },
      promptVersion: { findFirst: async () => null },
    };
    const router = { execute: async () => ({ text: JSON.stringify({ critique: 'разбор', editPrompt: 'правка' }), aiInferenceId: 'inf' }) };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    return new WorkingMaterialsService(prisma, router as never)
      .submitVersion('u1', 'p1', 'текст', 'm1')
      .then((out) => {
        expect(saved).toEqual([3]);
        expect(out.version.versionNumber).toBe(3);
        // Попыток ровно столько, сколько нужно: 2 (занят) и 3 (записан).
        expect(attempts).toBe(2);
      })
      .finally(() => warn.mockRestore());
  });

  it('обратная проба: попытки не бесконечны — на вечно занятом номере отказ виден', async () => {
    // Иначе лечение превратило бы потерю разбора в зависший запрос, а это
    // хуже: человек не узнает даже того, что не получилось.
    let attempts = 0;
    const prisma: any = {
      // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05:
      // счётчик расходов работает интерактивной формой `$transaction`.
      $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
      $executeRaw: async () => 1,
      project: { findFirst: async () => ({ id: 'p1', ownerId: 'u1', question: 'вопрос', goal: null }) },
      workingMaterial: { findFirst: async () => ({ id: 'm1', projectId: 'p1' }) },
      materialVersion: {
        findFirst: async () => ({ versionNumber: 1 }),
        create: async () => {
          attempts++;
          // Четвёртая попытка отвечает ДРУГИМ отказом. Это сделано
          // нарочно: пропади предел попыток — тест упадёт сразу и с
          // внятным текстом, а не повиснет. Мутацию «сделать попытки
          // бесконечными» иначе нечем поймать: она не роняет набор, а
          // подвешивает его, и стенд такой исход не различает.
          if (attempts > 3) throw new Error('предел попыток снят: четвёртая вставка');
          throw P2002();
        },
      },
      promptVersion: { findFirst: async () => null },
    };
    const router = { execute: async () => ({ text: JSON.stringify({ critique: 'разбор', editPrompt: 'правка' }), aiInferenceId: 'inf' }) };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(new WorkingMaterialsService(prisma, router as never).submitVersion('u1', 'p1', 'текст', 'm1')).rejects.toThrow(/Unique constraint/);
      expect(attempts).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: сбой записи в кэш TTS больше не выглядит промахом кэша', async () => {
    // Голый `catch {}` глотал ЛЮБОЙ отказ: перестань кэш писаться вовсе,
    // продукт платил бы за каждый повтор синтеза и не сказал бы никому.
    const base = (createFails: () => never) => {
      // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05: потолок
      // озвучки считается и отмечается ОДНОЙ транзакцией под замком, и
      // заглушка обязана знать интерактивную форму `$transaction`.
      const prisma: any = {
        ttsCache: { findUnique: async () => null, create: async () => createFails() },
        auditLogEntry: { create: async () => ({ id: 'a' }), count: async () => 0 },
        $transaction: async (arg: any): Promise<any> => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
        $executeRaw: async () => 1,
      };
      return {
      prisma,
      consent: { requireConsent: async () => undefined },
      secrets: { resolve: async () => 'key' },
      };
    };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      // Гонка — молча: аудио у человека уже есть.
      const race = base(() => {
        throw P2002();
      });
      const svcRace = new TextToSpeechService(race.prisma as never, race.consent as never, race.secrets as never);
      jest.spyOn(svcRace as never as { callElevenLabs: () => Promise<string> }, 'callElevenLabs').mockResolvedValue('AAA');
      await expect(svcRace.synthesize('u1', 'текст')).resolves.toEqual({ audioBase64: 'AAA', cached: false });
      expect(warn.mock.calls.length).toBe(0);

      // Любой другой отказ — в лог, но человеку аудио всё равно отдаём.
      const broken = base(() => {
        throw new Error('column "audio_base64" does not exist');
      });
      const svcBroken = new TextToSpeechService(broken.prisma as never, broken.consent as never, broken.secrets as never);
      jest.spyOn(svcBroken as never as { callElevenLabs: () => Promise<string> }, 'callElevenLabs').mockResolvedValue('BBB');
      await expect(svcBroken.synthesize('u1', 'текст')).resolves.toEqual({ audioBase64: 'BBB', cached: false });
      expect(warn.mock.calls.length).toBe(1);
      expect(String(warn.mock.calls[0][0]).includes('оплачен заново')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: идемпотентные места зовут upsert, а не пару «прочитал — создал»', async () => {
    // Фейк НЕ УМЕЕТ ни `findUnique`, ни `create`: если код вернётся к
    // паре, тест упадёт на отсутствующем методе. Это проверка поведения,
    // а не наличия слова в файле.
    const calls: string[] = [];
    const onlyUpsert = (name: string) => ({
      upsert: async ({ create }: any) => {
        calls.push(name);
        return { id: `${name}-1`, ...create };
      },
    });

    const briefPrisma: any = { interviewPoolConfig: onlyUpsert('config') };
    const brief = new ClientBriefService(briefPrisma, {} as never, {} as never, {} as never);
    await (brief as never as { ensureConfig: (id: string) => Promise<unknown> })['ensureConfig']('p1');

    const evalPrisma: any = { evaluationMetric: onlyUpsert('metric') };
    const evaluation = new EvaluationService(evalPrisma, {} as never);
    await (evaluation as never as { findOrCreateMetric: (n: string) => Promise<unknown> })['findOrCreateMetric']('precision');

    expect(calls).toEqual(['config', 'metric']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: конфиг работодателя отвечает ОДНОЙ формой — с вопросами и стадиями', async () => {
    // Было две ветки: создание возвращало конфиг БЕЗ вопросов и стадий,
    // обновление — с ними. То есть форма ответа зависела от того, первый
    // это вызов или второй, и экран, разбирающий ответ, видел разное на
    // одно и то же действие. `upsert` убрал и гонку, и эту разницу —
    // значит `include` обязан быть запрошен в единственной ветке.
    let seen: { include?: unknown } = {};
    const prisma: any = {
      // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05:
      // счётчик расходов работает интерактивной формой `$transaction`.
      $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
      $executeRaw: async () => 1,
      project: { findUnique: async () => ({ id: 'p1', ownerId: 'u1', mode: 'EMPLOYER_HIRING', recruitingTeamId: null }) },
      interviewPoolConfig: {
        upsert: async (args: any) => {
          seen = args;
          return { id: 'c1', questions: [], interviewStages: [] };
        },
      },
      employerDossier: { findFirst: async () => ({ id: 'd1', registryCode: '123' }) },
    };
    const svc = new EmployerHiringService(prisma, {} as never);
    const out = await svc.updateConfig('u1', 'p1', { jobTitle: 'Менеджер' } as never);
    expect(Object.keys(seen.include as object).sort()).toEqual(['interviewStages', 'questions']);
    expect(Object.keys(out as object).sort()).toEqual(['id', 'interviewStages', 'questions']);
  });
});

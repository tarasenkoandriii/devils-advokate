// Пункт [job-domain-v2] — связка П, приёмка 42–43 + инструменты соискателя.
import { BadRequestException } from '@nestjs/common';
import { VacancyIntakeService, extractSearchResults, contentHashOf, titleSimilarity, vacancyTextDiff, parseResponsesExport, sanitizeForwardedText, MAX_CANDIDATES_PER_CONFIG, MAX_VACANCIES_PER_CONFIG } from '../vacancy-intake/vacancy-intake.service';
import { JobSearchToolsService, coverLetterRespectsCv, parseSalary, BATCH_MATCH_TASK_TYPE } from '../vacancy-intake/job-search-tools.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService } from '../terms-sheet/terms-matching.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';

const fetched: Array<{ url: string; text: string }> = [];
let nextFetch: (url: string) => string = () => 'Вакансия: Backend. Оплата 2000 USD. Удалённо.';
jest.mock('../common/safe-url-fetch', () => {
  const actual = jest.requireActual('../common/safe-url-fetch');
  return {
    ...actual,
    fetchUrlText: async (url: string) => {
      const text = nextFetch(url);
      fetched.push({ url, text });
      if (text === '__404__') throw new actual.UrlFetchError(`Не удалось загрузить ${url}: HTTP 404`);
      // Пункт [stored-text-cut] 2026-09-06: загрузчик отдаёт текст
      // ВМЕСТЕ с отчётом о том, сколько его вошло.
      return { text, intake: { used: text.length, total: text.length, limit: 12_000 } };
    },
  };
});

function setup(handler: (req: any) => string = () => '{}') {
  const prisma = createHiringFakePrisma();
  const router = createFakeRouter(handler);
  const matching = new TermsMatchingService(prisma as any, router as any);
  const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
  const intake = new VacancyIntakeService(prisma as any);
  const tools = new JobSearchToolsService(prisma as any, router as any, sheets);
  const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
  const config = prisma.seed('jobSearchConfig', { projectId: project.id, desiredRole: 'Backend', city: 'Київ', cvText: 'CV', cvDraft: { headline: 'Backend', summary: 's', skills: ['Node.js', 'PostgreSQL'], experience: [], education: [] } });
  prisma.seed('jobSearchCriterion', { configId: config.id, text: 'Удалёнка', category: 'LOCATION', isRequired: true, orderIndex: 0 });
  prisma.seed('user', { id: 'u1', telegramId: '777' });
  return { prisma, router, sheets, intake, tools, project, config };
}

describe('приток — чистые функции', () => {
  it('extractSearchResults: ссылки на вакансии без содержимого, дубли и небезопасные отброшены', () => {
    const html = `<a href="/jobs/123-backend/">Backend developer (Node.js)</a><a href="/jobs/123-backend/">Backend developer (Node.js)</a>
      <a href="http://127.0.0.1/jobs/1">Внутренняя</a><a href="/about">О нас</a><a href="/jobs/777/">Менеджер по продажам B2B</a>`;
    const items = extractSearchResults(html, 'https://www.work.ua/jobs-kyiv/');
    expect(items.map((i) => i.title)).toEqual(['Backend developer (Node.js)', 'Менеджер по продажам B2B']);
    expect(items[0].url).toBe('https://www.work.ua/jobs/123-backend/');
  });
  it('contentHash нормализует пробелы/регистр/даты; titleSimilarity; диф текста; история откликов; пересылка', () => {
    expect(contentHashOf('Backend  DEV, 01.09.2026')).toBe(contentHashOf('backend dev 02.09.2026'));
    expect(titleSimilarity('Backend developer Node.js', 'Node.js backend developer')).toBeGreaterThan(0.8);
    expect(titleSimilarity('Backend developer', 'Sales manager')).toBe(0);
    const d = vacancyTextDiff('Оплата 2000 USD. Удалённо.', 'Удалённо. Нужен Kubernetes.');
    expect(d.salaryRemoved).toBe(true);
    expect(d.added).toEqual(['Нужен Kubernetes.']);
    const rows = parseResponsesExport('Backend developer;отклик отправлен;2026-08-20\nSales manager | отказ | 21.08.2026\nмусор без статуса');
    expect(rows.map((r) => r.status)).toEqual(['APPLIED', 'REJECTED']);
    expect(rows[1].at?.toISOString().slice(0, 10)).toBe('2026-08-21');
    const fwd = sanitizeForwardedText('Вакансия! https://jobs.dou.ua/vacancies/1 подробности внутри');
    expect(fwd.sourceUrl).toBe('https://jobs.dou.ua/vacancies/1');
    expect(fwd).not.toHaveProperty('forward_origin');
  });
  it('coverLetterRespectsCv: навык вне CV — отказ; parseSalary', () => {
    const cv = new Set(['node.js', 'postgresql']);
    expect(coverLetterRespectsCv('Работал с Node.js и PostgreSQL', ['Node.js'], cv).ok).toBe(true);
    expect(coverLetterRespectsCv('Знаю Kubernetes и Node.js', ['Node.js'], cv)).toEqual({ ok: false, foreign: ['kubernetes'] });
    expect(coverLetterRespectsCv('текст', ['Docker'], cv).foreign).toEqual(['Docker']);
    expect(parseSalary('2000-3000 USD')).toBe(3000);
    expect(parseSalary(null)).toBeNull();
  });
});

describe('VacancyIntakeService', () => {
  beforeEach(() => {
    fetched.length = 0;
    nextFetch = () => 'Вакансия: Backend. Оплата 2000 USD. Удалённо.';
  });

  it('приёмка 42: кандидаты без содержимого; потолок 200; загрузка → JobVacancy; 51-я загруженная → 400 с текстом про потолок', async () => {
    const s = setup();
    const html = Array.from({ length: 205 }, (_, i) => `<a href="/jobs/${i}/">Вакансия номер ${i} backend</a>`).join('');
    const res = await s.intake.fromSearchPage('u1', s.project.id, { html, url: 'https://www.work.ua/' });
    expect(res.created).toHaveLength(MAX_CANDIDATES_PER_CONFIG);
    expect(s.prisma.rows('jobVacancy')).toHaveLength(0); // содержимое не сохранено
    await expect(s.intake.fromEmailAlert('u1', s.project.id, [{ url: 'https://djinni.co/jobs/1' }])).rejects.toThrow(/Потолок 200/);
    const cand = res.created[0];
    const vacancy = await s.intake.fetchCandidate('u1', cand.id);
    expect(vacancy).toMatchObject({ intakeSource: 'SEARCH_PAGE', siteHost: 'work.ua', title: cand.title });
    expect(vacancy!.contentHash).toBeTruthy();
    expect(fetched).toHaveLength(1);
    // повторная загрузка того же кандидата — та же вакансия, без второго fetch
    expect((await s.intake.fetchCandidate('u1', cand.id))!.id).toBe(vacancy!.id);
    expect(fetched).toHaveLength(1);
    // потолок загруженных — 50
    for (let i = 0; i < MAX_VACANCIES_PER_CONFIG - 1; i++) s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: `https://x/${i}`, siteHost: 'x', rawText: `t${i}`, intakeSource: 'MANUAL_URL' });
    await expect(s.intake.fetchCandidate('u1', res.created[1].id)).rejects.toThrow(/Потолок 50 вакансий/);
    await expect(s.intake.fromPastedText('u1', s.project.id, { text: 'Вакансия текстом, длинный текст объявления' })).rejects.toThrow(/Потолок 50/);
  });

  it('приёмка 43: вставка текста и пересылка — вакансия без ссылки (sourceUrl null); forward_origin не доходит; дубли по хэшу и по заголовку с другой площадки', async () => {
    const s = setup();
    const pasted = await s.intake.fromPastedText('u1', s.project.id, { text: 'Ищем Backend developer. Оплата 2000 USD. Удалённо. Node.js.' });
    expect(pasted).toMatchObject({ sourceUrl: null, siteHost: null, intakeSource: 'PASTED_TEXT', duplicateOfId: null });
    const fwd = await s.intake.fromForwardedMessage('777', s.project.id, 'Ищем Backend developer. Оплата 2000 USD. Удалённо. Node.js. https://jobs.dou.ua/vacancies/9');
    expect(fwd.intakeSource).toBe('TELEGRAM_FORWARD');
    expect(fwd.sourceUrl).toBe('https://jobs.dou.ua/vacancies/9');
    expect(fwd.rawText).not.toMatch(/forward_origin|forward_from/);
    expect(fwd.duplicateOfId).toBe(pasted.id); // тот же текст → дубль по хэшу, главная — первая
    await expect(s.sheets.openForVacancy('u1', fwd.id)).rejects.toMatchObject({ response: { primaryVacancyId: pasted.id } });
    const unlinked = await s.intake.unlinkDuplicate('u1', fwd.id);
    expect(unlinked.duplicateOfId).toBeNull();
    // дубль по заголовку с другой площадки
    s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: 'https://work.ua/1', siteHost: 'work.ua', rawText: 'A', title: 'Senior Backend Developer Node.js', intakeSource: 'MANUAL_URL' });
    s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: 'https://robota.ua/1', siteHost: 'robota.ua', rawText: 'B', title: 'Senior Backend Developer (Node.js)', intakeSource: 'MANUAL_URL' });
    const groups = await s.intake.dedupe('u1', s.project.id);
    expect(groups.groups.some((g) => g.duplicateIds.length === 1)).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ [freeze-stopped-only-the-hands]: замороженный проект фоновый тик не перечитывает', async () => {
    // Заморозка отвечает человеку «изменения недоступны», а фоновая
    // работа про неё не знала: вакансии продолжали перечитываться и
    // приносить в остановленный проект новые данные.
    const s = setup();
    nextFetch = () => 'новый текст';
    const frozenProject = s.prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH', frozenAt: new Date('2026-09-04T00:00:00Z') });
    const frozenConfig = s.prisma.seed('jobSearchConfig', { projectId: frozenProject.id, desiredRole: 'Backend', city: 'Київ', cvText: 'CV' });
    const frozenVacancy = s.prisma.seed('jobVacancy', {
      configId: frozenConfig.id, sourceUrl: 'https://frozen/1', siteHost: 'f', rawText: 'старый текст',
      watchEnabled: true, lastRefetchedAt: null, intakeSource: 'MANUAL_URL',
    });
    // И живая вакансия рядом — ОБРАТНАЯ ПРОБА: тик вообще работает.
    const liveVacancy = s.prisma.seed('jobVacancy', {
      configId: s.config.id, sourceUrl: 'https://live/1', siteHost: 'l', rawText: 'старый текст',
      watchEnabled: true, lastRefetchedAt: null, intakeSource: 'MANUAL_URL',
    });

    const tick = await s.intake.refetchDue(new Date('2026-09-05T00:00:00Z'), 10);
    expect(tick.processed).toBe(1);

    const rows = s.prisma.rows('jobVacancy');
    expect(rows.find((x: any) => x.id === frozenVacancy.id)!.rawText).toBe('старый текст');
    expect(rows.find((x: any) => x.id === frozenVacancy.id)!.lastRefetchedAt).toBeNull();
    expect(rows.find((x: any) => x.id === liveVacancy.id)!.rawText).toBe('новый текст');
  });

  it('приёмка 43 (К-16): слежение per-вакансия; повторная загрузка чаще суток → 429; 404 источника — отдельное состояние (колонка), не изменение текста и не ошибка; диф; тик refetchDue порцией', async () => {
    const s = setup();
    const v = s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: 'https://work.ua/1', siteHost: 'work.ua', rawText: 'Вакансия: Backend. Оплата 2000 USD. Удалённо.', intakeSource: 'MANUAL_URL' });
    const noUrl = s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: null, siteHost: null, rawText: 'x', intakeSource: 'PASTED_TEXT' });
    await expect(s.intake.setWatch('u1', noUrl.id, true)).rejects.toBeInstanceOf(BadRequestException);
    await s.intake.setWatch('u1', v.id, true);

    nextFetch = () => 'Вакансия: Backend. Удалённо. Нужен Kubernetes.';
    const r1 = await s.intake.refetch('u1', v.id, new Date('2026-09-02T10:00:00Z'));
    expect(r1.changed).toBe(true);
    expect(r1.diff!.salaryRemoved).toBe(true);
    await expect(s.intake.refetch('u1', v.id, new Date('2026-09-02T20:00:00Z'))).rejects.toMatchObject({ status: 429 });
    expect((await s.intake.changes('u1', v.id)).diff!.salaryRemoved).toBe(true);

    /** ПЕРЕПИСАН, Пункт [state-not-sent] 2026-09-06. Тест ТРЕБОВАЛ,
     * чтобы снятие с публикации было дописано в `rawText`
     * (`toMatch(/Снята с публикации/)`) и чтобы это считалось
     * изменением (`changed: true`). То есть закреплял ровно то
     * поведение, из-за которого текст источника содержал наши слова, а
     * плановый тик каждые сутки объявлял вакансию изменившейся. Изменён
     * код, а не ослаблено требование: факт снятия по-прежнему обязан
     * фиксироваться — но колонкой, и текст обязан остаться нетронутым. */
    nextFetch = () => '__404__';
    const textBefore = s.prisma.rows('jobVacancy').find((x) => x.id === v.id)!.rawText;
    const r2 = await s.intake.refetch('u1', v.id, new Date('2026-09-03T11:00:00Z'));
    expect(r2).toMatchObject({ changed: false, removed: true, alreadyKnown: false });
    const afterRemoval = s.prisma.rows('jobVacancy').find((x) => x.id === v.id)!;
    expect(afterRemoval.rawText).toBe(textBefore);
    expect(afterRemoval.rawText).not.toMatch(/Снята с публикации/);
    expect(afterRemoval.removedFromSourceAt).toEqual(new Date('2026-09-03T11:00:00Z'));

    /** КЛЮЧЕВОЙ ТЕСТ [state-not-sent] 2026-09-06 — ПОВТОРНОЕ 404.
     * Именно оно и было дефектом: плановый тик приходит каждые сутки,
     * снятая вакансия подходит под его условие всегда, и прежний код
     * каждый раз дописывал метку заново — текст рос на строку в день,
     * а «Изменения» показывали свежий diff о вакансии, которая не
     * менялась с момента снятия. Дата снятия обязана остаться первой,
     * текст — нетронутым, изменением это не считается. */
    const r3 = await s.intake.refetch('u1', v.id, new Date('2026-09-04T11:00:00Z'));
    expect(r3).toMatchObject({ changed: false, removed: true, alreadyKnown: true });
    const afterSecond = s.prisma.rows('jobVacancy').find((x) => x.id === v.id)!;
    expect(afterSecond.rawText).toBe(textBefore);
    expect(afterSecond.removedFromSourceAt).toEqual(new Date('2026-09-03T11:00:00Z'));
    expect(afterSecond.lastRefetchedAt).toEqual(new Date('2026-09-04T11:00:00Z'));

    /** И возвращение на площадку: отметка снимается, об этом сказано
     * отдельным признаком, а не молча. Проверять снятую вакансию
     * продолжаем именно ради этого случая. */
    nextFetch = () => 'Вакансия: Backend. Удалённо. Нужен Kubernetes. Вернули.';
    const r4 = await s.intake.refetch('u1', v.id, new Date('2026-09-05T11:00:00Z'));
    expect(r4).toMatchObject({ changed: true, republished: true });
    expect(s.prisma.rows('jobVacancy').find((x) => x.id === v.id)!.removedFromSourceAt).toBeNull();

    /** Мутация «возвращение не снимает отметку» сначала УШЛА: выше
     * вакансия вернулась С ДРУГИМ текстом, а это другая ветка записи.
     * Вакансию возвращают и НЕИЗМЕНЁННОЙ — тогда отметка обязана
     * сняться в ветке «текст тот же». */
    nextFetch = () => '__404__';
    await s.intake.refetch('u1', v.id, new Date('2026-09-06T11:00:00Z'));
    expect(s.prisma.rows('jobVacancy').find((x) => x.id === v.id)!.removedFromSourceAt).not.toBeNull();
    nextFetch = () => 'Вакансия: Backend. Удалённо. Нужен Kubernetes. Вернули.';
    const r5 = await s.intake.refetch('u1', v.id, new Date('2026-09-07T11:00:00Z'));
    expect(r5).toMatchObject({ changed: false, republished: true });
    expect(s.prisma.rows('jobVacancy').find((x) => x.id === v.id)!.removedFromSourceAt).toBeNull();

    // тик: только watchEnabled со загрузкой старше суток, порция
    nextFetch = () => 'новый текст';
    for (let i = 0; i < 3; i++) s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: `https://w/${i}`, siteHost: 'w', rawText: 'old', watchEnabled: true, lastRefetchedAt: null, intakeSource: 'MANUAL_URL' });
    const tick = await s.intake.refetchDue(new Date('2026-09-05T00:00:00Z'), 2);
    expect(tick.processed).toBe(2);
    expect(tick.changed).toBe(2);

    /** [state-not-sent] 2026-09-06: снятие больше не считается
     * изменением, поэтому тик обязан отчитаться о нём отдельной
     * строкой. Иначе в сводке останется «processed: 20, changed: 0», и
     * отличить «ничего не поменялось» от «двадцать вакансий сняли с
     * публикации» будет нечем — то самое молчание, из которого эта
     * сверка и выросла. */
    nextFetch = () => '__404__';
    for (let i = 0; i < 2; i++) {
      s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: `https://gone/${i}`, siteHost: 'gone', rawText: 'old', watchEnabled: true, lastRefetchedAt: null, intakeSource: 'MANUAL_URL' });
    }
    const goneTick = await s.intake.refetchDue(new Date('2026-09-08T00:00:00Z'), 2);
    expect(goneTick.removed).toBe(2);
    expect(goneTick.changed).toBe(0);
  });

  /** КЛЮЧЕВОЙ ТЕСТ [stored-text-cut] 2026-09-06 — НА ПОВЕДЕНИИ.
   * Валидатор запроса пропускает 20 000 знаков, запись режет до
   * 12 000 — и делала это молча: человек вставлял объявление на 15 000
   * знаков и нигде не узнавал, что три тысячи в продукт не попали. */
  it('[stored-text-cut]: вставленный текст длиннее потолка хранится обрезанным, но длина ДО обрезки записана', async () => {
    const s = setup();
    const long = `Вакансия: Backend. ${'подробности '.repeat(1500)}`;
    expect(long.length).toBeGreaterThan(12_000);

    const v = await s.intake.fromPastedText('u1', s.project.id, { text: long, title: 'Backend' });

    const row = s.prisma.rows('jobVacancy').find((x: any) => x.id === v.id)!;
    expect(row.rawText.length).toBe(12_000);
    expect(row.rawTextTotalChars).toBe(long.length);
    // Хеш дублей считается по тому, что реально сохранено, а не по
    // тексту, которого в базе нет.
    expect(row.contentHash).toBeTruthy();
  });

  it('[stored-text-cut]: текст короче потолка хранится целиком, и длина совпадает с ним', async () => {
    const s = setup();
    const short = 'Вакансия: Backend. Оплата 2000 USD. Удалённо. Нужен Node.js и Postgres.';
    const v = await s.intake.fromPastedText('u1', s.project.id, { text: short, title: null });
    const row = s.prisma.rows('jobVacancy').find((x: any) => x.id === v.id)!;
    expect(row.rawText).toBe(short);
    expect(row.rawTextTotalChars).toBe(short.length);
  });

  it('К-29: история откликов сопоставляется по заголовку; «молчат N дней»', async () => {
    const s = setup();
    const v = s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: 'https://w/1', siteHost: 'w', rawText: 'x', title: 'Backend developer Node.js', intakeSource: 'MANUAL_URL' });
    const res = await s.intake.importResponses('u1', s.project.id, 'Backend developer Node.js; отклик отправлен; 2026-08-01\nНеизвестная вакансия; отказ; 2026-08-02');
    expect(res.matched).toHaveLength(1);
    expect(res.unmatched).toHaveLength(1);
    expect(s.prisma.rows('jobVacancy').find((x) => x.id === v.id)).toMatchObject({ responseStatus: 'APPLIED' });
    const silent = await s.intake.silence('u1', s.project.id, 7, new Date('2026-08-20'));
    expect(silent[0]).toMatchObject({ id: v.id, silentDays: 19 });
  });
});

describe('JobSearchToolsService', () => {
  it('К-14: пакетная сверка ставит джобы в фон, помечает вакансии, дубли пропускает; результат пишет completion handler; потолок суточный', async () => {
    const s = setup();
    const v1 = s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: 'https://w/1', siteHost: 'w', rawText: 'Удалённо.', intakeSource: 'MANUAL_URL' });
    const v2 = s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: 'https://w/2', siteHost: 'w', rawText: 'Удалённо.', intakeSource: 'MANUAL_URL', duplicateOfId: v1.id });
    const res = await s.tools.enqueueBatch('u1', s.project.id, [v1.id, v2.id]);
    expect(res.queued).toBe(1);
    expect(s.router.queued[0].taskType).toBe(BATCH_MATCH_TASK_TYPE);
    expect(s.router.queued[0].systemPrompt).toMatch(/ЗАПРЕЩЕНО/);
    const marked = s.prisma.rows('jobVacancy').find((x) => x.id === v1.id)!;
    expect(marked.batchMatchJobId).toBe('job-1');

    const criterionId = s.prisma.rows('jobSearchCriterion')[0].id;
    s.prisma.seed('aIInference', { id: 'inf-1', output: JSON.stringify({ title: 'Backend', locationMatch: 'MATCHES', salaryMentioned: null, matchBreakdown: [{ criterionId, coverage: 'covered', note: 'удалённо' }, { criterionId: 'fake', coverage: 'covered', note: '' }], notes: 'ok' }) });
    await s.router.completionHandlers.get(BATCH_MATCH_TASK_TYPE)!({ kind: 'completed', jobId: 'job-1', aiInferenceId: 'inf-1' });
    const done = s.prisma.rows('jobVacancy').find((x) => x.id === v1.id)!;
    expect(done.matchedAt).toBeInstanceOf(Date);
    expect(done.matchBreakdown).toEqual([{ criterionId, coverage: 'covered', note: 'удалённо' }]);
    expect(done.batchMatchJobId).toBeNull();

    process.env.AI_BATCH_MATCH_PER_USER_PER_DAY = '1';
    try {
      const v3 = s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: 'https://w/3', siteHost: 'w', rawText: 'x', intakeSource: 'MANUAL_URL' });
      await expect(s.tools.enqueueBatch('u1', s.project.id, [v3.id])).rejects.toMatchObject({ status: 429 });
    } finally {
      delete process.env.AI_BATCH_MATCH_PER_USER_PER_DAY;
    }
    const matrix = await s.tools.matrix('u1', s.project.id, { filter: 'required_covered', sort: true });
    expect(matrix.rows.map((r) => r.vacancyId)).toEqual([v1.id]);
    expect(JSON.stringify(matrix)).not.toMatch(/"(score|rank)"/);
  });

  it('К-13/К-18/К-27: запросы под площадки — шаблоны без сети; карта пробелов по своей базе с рамкой; похожие — по словам', async () => {
    const s = setup(() => JSON.stringify({ roleSynonyms: ['Node.js developer'], skillQueries: ['PostgreSQL'] }));
    const qb = await s.tools.queryBuilder('u1', s.project.id);
    expect(qb.boards.length).toBeGreaterThan(3);
    expect(qb.boards[0].queries[0].url).toContain('work.ua');
    expect(qb.boards[0].queries.map((q) => q.role)).toContain('Node.js developer');
    expect(qb.note).toMatch(/копировать руками/);
    // [not-checked-looks-clean] 2026-09-06: удачный разбор не помечается.
    expect(qb.synonymsNotChecked).toBeNull();

    const gap = await s.tools.gapMap('u1', s.project.id);
    expect(gap.frame).toMatch(/не рынок/);
    expect(gap.items).toEqual([]);

    const a = s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: 'https://w/1', siteHost: 'w', rawText: 'Backend developer Node.js PostgreSQL Docker Kubernetes microservices team remote', intakeSource: 'MANUAL_URL' });
    s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: 'https://w/2', siteHost: 'w', rawText: 'Backend developer Node.js PostgreSQL Docker Kubernetes microservices office', title: 'B', intakeSource: 'MANUAL_URL' });
    s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: 'https://w/3', siteHost: 'w', rawText: 'Sales manager cold calls CRM', title: 'C', intakeSource: 'MANUAL_URL' });
    const sim = await s.tools.similar('u1', s.project.id, a.id);
    expect(sim.similar.map((x) => x.title)).toEqual(['B']);
    expect(sim.frame).toMatch(/не рекомендации/);
  });

  // ── Пункт [job-died-quietly] 2026-09-06 ──
  //
  // У обработчика пакетной сверки ТРИ выхода, и третий молчал. Ветка
  // `failed` снимала `batchMatchJobId` и писала причину в `matchNotes`
  // — правильно. Ветка разбора ответа при ошибке JSON писала только в
  // лог: поле оставалось заполненным, а матрица считает `queued:
  // !!batchMatchJobId` и печатает «· в очереди». Джоба на стороне
  // роутера уже COMPLETED, обработчик больше никто не позовёт — значит
  // строка говорила «в очереди» НАВСЕГДА.
  it('КЛЮЧЕВОЙ ТЕСТ [job-died-quietly]: неразборчивый ответ модели не оставляет вакансию «в очереди» навсегда', async () => {
    const s = setup();
    const v1 = s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: 'https://w/9', siteHost: 'w', rawText: 'Удалённо.', intakeSource: 'MANUAL_URL' });
    await s.tools.enqueueBatch('u1', s.project.id, [v1.id]);
    expect(s.prisma.rows('jobVacancy').find((x) => x.id === v1.id)!.batchMatchJobId).toBe('job-1');

    // Ответ прошёл валидатор роутера, но JSON.parse на нём падает.
    s.prisma.seed('aIInference', { id: 'inf-9', output: 'не json вовсе' });
    await s.router.completionHandlers.get(BATCH_MATCH_TASK_TYPE)!({ kind: 'completed', jobId: 'job-1', aiInferenceId: 'inf-9' });

    const row = s.prisma.rows('jobVacancy').find((x) => x.id === v1.id)!;
    // Главное: ожидание кончилось. Иначе «· в очереди» стояло бы вечно.
    expect(row.batchMatchJobId).toBeNull();
    // И пустые заметки не выдаются за результат сверки.
    expect(row.matchNotes).toContain('не проверялись');
    expect(row.matchedAt ?? null).toBeNull();
  });

  // ── Пункт [not-checked-looks-clean] 2026-09-06 ──
  //
  // Решение «не ронять запросы из-за синонимов» верное: шаблоны площадок
  // работают и без них. Неверным было молчание — пустой `skillQueries`
  // человек читает как «по навыкам искать нечего», а значит он
  // «спросить не вышло».
  it('[not-checked-looks-clean]: сбой подбора синонимов назван, а запросы всё равно отдаются', async () => {
    const s = setup(() => {
      throw new Error('провайдер недоступен');
    });
    const qb = await s.tools.queryBuilder('u1', s.project.id);
    expect(qb.boards.length).toBeGreaterThan(3);
    expect(qb.skillQueries).toEqual([]);
    expect(qb.synonymsNotChecked).toBe('provider-failed');
  });

  it('К-19: письмо только из CV — навык вне словаря отвергается детерминированно до выдачи; К-25: признаки без вердикта, зарплатный выброс только при ≥ 3 в базе', async () => {
    let attempt = 0;
    const s = setup((req) => {
      if (req.taskType === 'job-search-cover-letter') {
        attempt++;
        return attempt === 1 ? JSON.stringify({ text: 'Владею Kubernetes и Node.js', skillsUsed: ['Node.js'] }) : JSON.stringify({ text: 'Работал с Node.js и PostgreSQL', skillsUsed: ['Node.js', 'PostgreSQL'] });
      }
      if (req.taskType === 'vacancy-scam-signals') return JSON.stringify({ signals: [{ kind: 'payment_request', quote: 'оплатите обучение', note: 'просят оплату' }, { kind: 'x', quote: 'нет такого', note: '' }] });
      return JSON.stringify({ clauses: [] });
    });
    const v = s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: 'https://w/1', siteHost: 'w', rawText: 'Работа мечты! Сначала оплатите обучение. Пишите в Telegram @hr', salaryMentioned: '9000 USD', intakeSource: 'MANUAL_URL' });
    const sheet = await s.sheets.openForVacancy('u1', v.id);
    // первый ответ модели содержит Kubernetes, которого нет в CV → фейк-роутер отвергает по validateOutput, как это сделал бы роутер
    await expect(s.tools.coverLetter('u1', s.project.id, sheet.id, { notCoveredHandling: 'name_honestly' })).rejects.toThrow(/без выхода за пределы CV/);
    const letter = await s.tools.coverLetter('u1', s.project.id, sheet.id, { notCoveredHandling: 'skip' });
    expect(letter.text).toContain('PostgreSQL');
    expect(letter.reviewRequired).toBe(true);

    const scam = await s.tools.scamSignals('u1', v.id);
    const kinds = scam.signals.map((x) => x.kind);
    expect(kinds).toContain('company_not_identified');
    expect(kinds).toContain('messenger_only_no_entity');
    expect(kinds).toContain('payment_request');
    expect(kinds).not.toContain('x'); // цитата не из текста
    expect(kinds).not.toContain('salary_outlier_in_own_base'); // в базе нет 3 вакансий с зарплатой
    for (let i = 0; i < 3; i++) s.prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: `https://w/s${i}`, siteHost: 'w', rawText: 'x', salaryMentioned: '2000 USD', intakeSource: 'MANUAL_URL' });
    expect((await s.tools.scamSignals('u1', v.id)).signals.map((x) => x.kind)).toContain('salary_outlier_in_own_base');
    expect(JSON.stringify(scam)).not.toMatch(/мошенники|обман/);
  });
});

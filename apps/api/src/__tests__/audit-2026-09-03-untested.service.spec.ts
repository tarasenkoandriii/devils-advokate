// Пункт [job-domain-v2] — второй заход аудита 2026-09-03: К-5 и шесть методов,
// которые были написаны, но не вызывались ни одним тестом.
//
// Почему это не «тесты ради покрытия». Все шесть — AI-вызовы с разбором JSON и
// фильтрами по цитатам и известным id. Ровно там регрессия проходит молча:
// промпт поменяли, модель стала возвращать другое поле, фильтр перестал
// отсекать выдуманное — и продукт начинает показывать человеку то, чего в
// источнике не было. Каждый тест ниже проверяет ИМЕННО фильтр, а не то, что
// «функция что-то вернула».
import { BadRequestException } from '@nestjs/common';
import { TermsSheetService, CLARIFY_QUESTIONS_TASK_TYPE, CLARIFY_QUESTIONS_PROMPT } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService, TERMS_COUNTERPARTS_TASK_TYPE } from '../terms-sheet/terms-matching.service';
import { CvVariantService, HIGHLIGHT_MAP_TASK_TYPE, CONSISTENCY_TASK_TYPE } from '../terms-sheet/cv-variant.service';
import { VacancyPostingService, POSTING_READER_TASK_TYPE } from '../vacancy-posting/vacancy-posting.service';
import { EmployerDossierService, DOSSIER_DISCREPANCIES_TASK_TYPE } from '../employer-dossier/employer-dossier.service';
import { OfferExchangeService } from '../employer-hiring/offer-exchange.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';

jest.mock('../common/safe-url-fetch', () => ({
  ...jest.requireActual('../common/safe-url-fetch'),
  fetchUrlText: jest.fn(async () => ({ text: '', intake: { used: 0, total: 0, limit: 8000 } })),
}));

const CV_DRAFT = {
  headline: 'Backend-разработчик',
  summary: 'Пишу сервисы на Node.js.',
  skills: ['Node.js', 'PostgreSQL'],
  experience: [{ period: '2021–2024', place: 'ООО Ромашка', role: 'разработчик', highlights: ['Перевёл биллинг на очереди'] }],
  education: [],
};

function base(handler: (req: any) => string) {
  const prisma = createHiringFakePrisma();
  const router = createFakeRouter(handler);
  const matching = new TermsMatchingService(prisma as any, router as any);
  const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
  return { prisma, router, matching, sheets };
}

function jobSearchSheet(prisma: any, opts: { cvDraft?: unknown } = {}) {
  const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
  const config = prisma.seed('jobSearchConfig', { projectId: project.id, desiredRole: 'Backend', city: 'Киев', cvDraft: opts.cvDraft ?? null });
  const vacancy = prisma.seed('jobVacancy', { configId: config.id, sourceUrl: 'https://work.ua/1', siteHost: 'work.ua', rawText: 'текст вакансии', title: 'Backend', duplicateOfId: null });
  const sheet = prisma.seed('termsSheet', { projectId: project.id, kind: 'VACANCY_RESPONSE', vacancyId: vacancy.id, title: 'Backend', status: 'DRAFT' });
  return { project, config, vacancy, sheet };
}

describe('К-5 — «что уточнить»: вопросы, а не «красные флаги»', () => {
  it('открытые пункты превращаются в вопросы; выдуманный clauseId отбрасывается; в промпте прямо запрещены предупреждения о работодателе', async () => {
    const s = base((req) => {
      if (req.taskType !== CLARIFY_QUESTIONS_TASK_TYPE) return '{}';
      const ids = [...req.userPrompt.matchAll(/\[id=([^\]]+)\]/g)].map((m: any) => m[1]);
      return JSON.stringify({
        questions: [
          { clauseId: ids[0], question: 'Какой график работы в команде?' },
          { clauseId: ids[0], question: 'дубль по тому же пункту' },
          { clauseId: 'выдуманный-id', question: 'Вопрос ни к чему не привязанный' },
        ],
      });
    });
    const { sheet } = jobSearchSheet(s.prisma);
    s.prisma.seed('termsClause', { sheetId: sheet.id, side: 'CANDIDATE', kind: 'CONDITION', text: 'График работы', category: 'условия', isRequired: false, orderIndex: 0, confirmedAt: new Date() });

    const res = await s.sheets.clarifyingQuestions('u1', sheet.id);
    expect(res.questions).toHaveLength(1);
    expect(res.questions[0]).toMatchObject({ question: 'Какой график работы в команде?', clauseText: 'График работы' });
    expect(res.note).toMatch(/не «красные флаги»/);
    expect(CLARIFY_QUESTIONS_PROMPT).toMatch(/ЗАПРЕЩЕНО: любые предупреждения и «красные флаги»/);
    expect(CLARIFY_QUESTIONS_PROMPT).toMatch(/подозрительно/);
  });

  it('когда открытых пунктов нет — AI не вызывается вовсе', async () => {
    const s = base(() => '{}');
    const { sheet } = jobSearchSheet(s.prisma);
    const res = await s.sheets.clarifyingQuestions('u1', sheet.id);
    expect(res.questions).toEqual([]);
    expect(s.router.calls).toHaveLength(0);
  });
});

describe('Методы, которые были без единого теста', () => {
  it('proposeCounterparts: пара с выдуманным id отбрасывается, сбой AI не роняет лист (пары — подсказка, не данные)', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const s = base((req) => {
      if (req.taskType !== TERMS_COUNTERPARTS_TASK_TYPE) return '{}';
      if (mode === 'fail') throw new Error('провайдер недоступен');
      const emp = /Пункты EMPLOYER:\n\[id=([^\]]+)\]/.exec(req.userPrompt)?.[1];
      const cand = /Пункты CANDIDATE:\n\[id=([^\]]+)\]/.exec(req.userPrompt)?.[1];
      return JSON.stringify({
        pairs: [
          { employerClauseId: emp, candidateClauseId: cand },
          { employerClauseId: emp, candidateClauseId: 'нет-такого' },
        ],
      });
    });
    const { sheet } = jobSearchSheet(s.prisma);
    const emp = s.prisma.seed('termsClause', { sheetId: sheet.id, side: 'EMPLOYER', kind: 'CONDITION', text: 'Удалённо', isRequired: false, orderIndex: 0, confirmedAt: new Date() });
    const cand = s.prisma.seed('termsClause', { sheetId: sheet.id, side: 'CANDIDATE', kind: 'CONDITION', text: 'Удалённая работа', isRequired: true, orderIndex: 1, confirmedAt: new Date() });

    const ok = await s.matching.proposeCounterparts({ userId: 'u1', projectId: sheet.projectId, sheetId: sheet.id });
    expect(ok.pairs).toEqual([{ employerClauseId: emp.id, candidateClauseId: cand.id }]);
    expect(ok.outcome).toBe('ok');

    // Пункт [failure-looks-empty] 2026-09-05: здесь стояло
    // `resolves.toEqual([])` — тест ЗАКРЕПЛЯЛ изъян. Он требовал, чтобы
    // сбой модели выглядел ровно так же, как честный ответ «совпадений
    // нет»: тот же пустой массив, ни слова о том, что разбора не было.
    // Тест переписан, а не код подогнан под него.
    mode = 'fail';
    const failed = await s.matching.proposeCounterparts({ userId: 'u1', projectId: sheet.projectId, sheetId: sheet.id });
    expect(failed.pairs).toEqual([]);
    expect(failed.outcome).toBe('failed');
    expect(failed.note).toMatch(/не состоялся/);
  });

  it('proposeHighlightMap: ссылка на несуществующий фрагмент CV и на чужой пункт отбрасывается; без подтверждённых пунктов — 400', async () => {
    const s = base((req) => {
      if (req.taskType !== HIGHLIGHT_MAP_TASK_TYPE) return '{}';
      const clauseId = /\[id=([^\]]+)\]/.exec(req.userPrompt.split('Пункты')[1] ?? req.userPrompt)?.[1];
      return JSON.stringify({
        map: [
          { highlightRef: 'skills[0]', clauseId },
          { highlightRef: 'skills[99]', clauseId }, // такого фрагмента в CV нет
          { highlightRef: 'summary', clauseId: 'чужой-пункт' },
        ],
      });
    });
    const cv = new CvVariantService(s.prisma as any, s.router as any, s.sheets);
    const { sheet } = jobSearchSheet(s.prisma, { cvDraft: CV_DRAFT });

    await expect(cv.proposeHighlightMap('u1', sheet.id)).rejects.toBeInstanceOf(BadRequestException);

    s.prisma.seed('termsClause', { sheetId: sheet.id, side: 'EMPLOYER', kind: 'REQUIREMENT', text: 'Node.js', isRequired: true, orderIndex: 0, confirmedAt: new Date() });
    const map = await cv.proposeHighlightMap('u1', sheet.id);
    expect(map.map((m) => m.highlightRef)).toEqual(['skills[0]']);
  });

  it('consistency (К-23): расхождение с неизвестным variantId отбрасывается; меньше двух вариантов — сравнивать нечего', async () => {
    const s = base((req) => {
      if (req.taskType !== CONSISTENCY_TASK_TYPE) return '{}';
      // Порядок вариантов в промпте задаёт сервис (по compiledAt), поэтому
      // цитату берём ИЗ САМОГО блока этого варианта — иначе тест проверял
      // бы не барьер, а совпадение с порядком сортировки.
      const blocks = req.userPrompt.split('---').map((b: string) => ({
        id: (b.match(/\[variantId=([^\]]+)\]/) ?? [])[1],
        period: (b.match(/\d{4}[–-]\d{4}/) ?? [])[0],
      })).filter((b: any) => b.id);
      const ids = blocks.map((b: any) => b.id);
      return JSON.stringify({
        discrepancies: [
          { topic: 'период работы', a: { variantId: ids[0], quote: blocks[0].period }, b: { variantId: ids[1], quote: blocks[1].period } },
          { topic: 'выдумка', a: { variantId: 'нет-такого', quote: 'x' }, b: { variantId: ids[1], quote: 'y' } },
          // Аудит 2026-09-03: цитата, которой нет в самом варианте, —
          // расхождение, построенное на фразе, которую человек не писал.
          { topic: 'цитата из ниоткуда', a: { variantId: ids[0], quote: 'руководил отделом из 20 человек' }, b: { variantId: ids[1], quote: '2020–2024' } },
        ],
      });
    });
    const cv = new CvVariantService(s.prisma as any, s.router as any, s.sheets);
    const { project, sheet } = jobSearchSheet(s.prisma, { cvDraft: CV_DRAFT });

    // Тексты вариантов содержат сами цитаты: с аудита 2026-09-03 цитата
    // обязана дословно встречаться в том варианте, на который ссылается.
    const one = s.prisma.seed('cvVariant', { sheetId: sheet.id, lang: 'ru', cvText: 'Вариант 1. Период работы 2021–2024.', highlightMap: [], compiledAt: new Date() });
    expect(await cv.consistency('u1', project.id)).toMatchObject({ discrepancies: [], variantsCompared: 1 });

    s.prisma.seed('cvVariant', { sheetId: sheet.id, lang: 'en', cvText: 'Variant 2. Период работы 2020–2024.', highlightMap: [], compiledAt: new Date() });
    const res = await cv.consistency('u1', project.id);
    expect(res.variantsCompared).toBe(2);
    expect(res.discrepancies).toHaveLength(1);
    expect(res.discrepancies[0]).toMatchObject({ topic: 'период работы' });
    // Отброшены оба негодных: с чужим variantId и с цитатой, которой нет.
    expect(res.droppedUnverifiable).toBe(2);
    void one;
  });

  it('readerQuestions (А-16): вопросы читателя приходят парами «тема — вопрос» и не содержат вердиктов о вакансии', async () => {
    const s = base((req) => {
      if (req.taskType !== POSTING_READER_TASK_TYPE) return '{}';
      return JSON.stringify({ questions: [{ topic: 'оплата', question: 'Указан ли диапазон и от чего он зависит?' }] });
    });
    const postings = new VacancyPostingService(s.prisma as any, s.router as any, s.sheets);
    const project = s.prisma.seed('project', { ownerId: 'u2', mode: 'INTERVIEW_POOL', recruitingTeamId: null });
    s.prisma.seed('interviewPoolConfig', { projectId: project.id, jobTitle: 'Sales' });
    const posting = s.prisma.seed('vacancyPosting', { projectId: project.id });
    const revision = s.prisma.seed('vacancyPostingRevision', { postingId: posting.id, text: 'Текст вакансии для читателя', checks: null });

    const res = await postings.readerQuestions('u2', revision.id);
    expect(res.questions).toEqual([{ topic: 'оплата', question: 'Указан ли диапазон и от чего он зависит?' }]);
    expect(JSON.stringify(res)).not.toMatch(/плохая вакансия|не стоит|рекомендую/i);
  });

  it('discrepancies (А-26/Р-6): расхождение без цитаты ИЗ ДОСЬЕ и ИЗ ДОКУМЕНТА не показывается; без фактов — честная причина, а не пустой список', async () => {
    const s = base((req) => {
      if (req.taskType !== DOSSIER_DISCREPANCIES_TASK_TYPE) return '{}';
      return JSON.stringify({
        // Пункт [finding-without-substance-2] 2026-09-26: `note` заполнен
        // НАРОЧНО. Раньше во всех трёх стояла пустая строка, и это было
        // безразлично; после того как пустое пояснение стало причиной
        // отбрасывания, годное расхождение отбрасывалось бы вместе с
        // выдуманными, и тест зеленел бы по не той причине.
        discrepancies: [
          { topic: 'адрес', factQuote: 'зареєстровано у Львові', documentQuote: 'офис в Киеве', note: 'в реестре Львов, в брифе Киев' },
          { topic: 'выдумка', factQuote: 'этого в фактах нет', documentQuote: 'офис в Киеве', note: 'цитата не из досье' },
          { topic: 'вторая выдумка', factQuote: 'зареєстровано у Львові', documentQuote: 'такого в брифе нет', note: 'цитата не из документа' },
        ],
      });
    });
    const dossiers = new EmployerDossierService(s.prisma as any, s.router as any, fakeAudit as any);
    const project = s.prisma.seed('project', { ownerId: 'u2', mode: 'INTERVIEW_POOL', recruitingTeamId: null });
    const dossier = s.prisma.seed('employerDossier', { projectId: project.id, legalName: 'ТОВ Ромашка', registryCode: '1', jurisdiction: 'UA' });
    const brief = s.prisma.seed('clientBrief', { projectId: project.id, rawText: 'Нужен продажник, офис в Киеве', origin: 'EXTERNAL' });

    const empty = await dossiers.discrepancies('u2', dossier.id, { briefId: brief.id });
    expect(empty.discrepancies).toEqual([]);
    expect(empty.reason).toMatch(/нет фактов/i);

    s.prisma.seed('employerDossierFact', { dossierId: dossier.id, category: 'REGISTRY', quote: 'зареєстровано у Львові', sourceUrl: 'https://registry.ua/1', fetchedAt: new Date() });
    const res = await dossiers.discrepancies('u2', dossier.id, { briefId: brief.id });
    expect(res.discrepancies).toHaveLength(1);
    expect(res.discrepancies[0]).toMatchObject({ topic: 'адрес', factQuote: 'зареєстровано у Львові', documentQuote: 'офис в Киеве' });
  });

  it('history (К-30): по компании собираются её вакансии, листы, офферы — и ничего из чужих проектов', async () => {
    const s = base(() => '{}');
    const dossiers = new EmployerDossierService(s.prisma as any, s.router as any, fakeAudit as any);
    const { config, sheet, vacancy } = jobSearchSheet(s.prisma);
    const project = s.prisma.rows('project')[0];
    const dossier = s.prisma.seed('employerDossier', { projectId: project.id, legalName: 'ТОВ Ромашка', registryCode: '1', jurisdiction: 'UA' });
    s.prisma.rows('jobVacancy')[0].employerDossierId = dossier.id;
    s.prisma.seed('offerDocument', { sheetId: sheet.id, rawText: 'оффер', source: null });
    // чужая вакансия той же конфигурации, но без привязки к компании
    s.prisma.seed('jobVacancy', { configId: config.id, sourceUrl: 'https://other/1', siteHost: 'other', rawText: 'чужая', title: 'Other', duplicateOfId: null });

    const res = await dossiers.history('u1', dossier.id);
    expect(res.vacancies.map((v: any) => v.id)).toEqual([vacancy.id]);
    expect(res.sheets.map((x: any) => x.id)).toEqual([sheet.id]);
    expect(res.offers).toHaveLength(1);
  });

  it('оффер соискателю без готовой вакансии этой компании: создаются JobVacancy(EMPLOYER_SHARE) и лист — копия не повисает в воздухе', async () => {
    const s = base(() => '{}');
    const offers = new OfferExchangeService(s.prisma as any, fakeAudit as any);
    // проект работодателя с кандидатом и его листом
    const employerProject = s.prisma.seed('project', { ownerId: 'emp', mode: 'EMPLOYER_HIRING', recruitingTeamId: null });
    s.prisma.seed('interviewPoolConfig', { projectId: employerProject.id, jobTitle: 'Sales' });
    s.prisma.seed('employerDossier', { projectId: employerProject.id, legalName: 'ТОВ Ромашка', registryCode: '1', jurisdiction: 'UA' });
    const profile = s.prisma.seed('candidateProfile', { ownerUserId: 'emp', displayName: 'Иван' });
    const status = s.prisma.seed('candidatePipelineStatus', { projectId: employerProject.id, candidateProfileId: profile.id, stage: 'SCHEDULED' });
    const employerSheet = s.prisma.seed('termsSheet', { projectId: employerProject.id, kind: 'INTERVIEW', pipelineStatusId: status.id, title: 'Иван', status: 'DRAFT' });
    const offer = s.prisma.seed('offerDocument', { sheetId: employerSheet.id, rawText: 'Оффер: 2500 USD', source: null, reviewedAt: new Date() });

    // у соискателя — проект и самошеринг БЕЗ листа-источника
    const candidateProject = s.prisma.seed('project', { ownerId: 'cand', mode: 'JOB_SEARCH' });
    s.prisma.seed('jobSearchConfig', { projectId: candidateProject.id, desiredRole: 'Sales', cvDraft: null });
    s.prisma.seed('candidateShare', {
      shareToken: 'tok',
      sourceCandidateId: null,
      createdCandidateProfileId: profile.id,
      sharedByUserId: 'cand',
      consentSource: 'CANDIDATE_SELF',
      sourceSheetId: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
    });

    const res = await offers.shareToCandidate('emp', offer.id, { token: 'tok' });
    const created = s.prisma.rows('jobVacancy').find((v: any) => v.intakeSource === 'EMPLOYER_SHARE');
    expect(created).toBeTruthy();
    expect(created!.sourceUrl).toBeNull();
    const candidateSheet = s.prisma.rows('termsSheet').find((x: any) => x.vacancyId === created!.id);
    expect(candidateSheet).toBeTruthy();
    expect(res.copy.sheetId).toBe(candidateSheet!.id);
    expect(res.copy.sharedFromProjectId).toBe(employerProject.id);
    // Копия досье компании у соискателя создалась — она и есть предмет
    // следующего теста.
    expect(s.prisma.rows('employerDossier').filter((d: any) => d.projectId === candidateProject.id)).toHaveLength(1);
  });

  // ── Пункт [same-answer-either-way] 2026-09-24 ──
  //
  // `own ?? create` для копии досье у соискателя: замысел идемпотентный,
  // а гонка между чтением и вставкой упиралась в `@@unique([projectId,
  // registryCode])`. `upsert` здесь не подходит — ищут по ИЛИ (код
  // реестра или домен), а уникальность только по коду; поэтому второй
  // приём того же лекарства: поймать P2002 и перечитать.
  it('КЛЮЧЕВОЙ ТЕСТ [same-answer-either-way]: гонка за копией досье не роняет отправку оффера', async () => {
    const s = base(() => '{}');
    const offers = new OfferExchangeService(s.prisma as any, fakeAudit as any);
    const employerProject = s.prisma.seed('project', { ownerId: 'emp', mode: 'EMPLOYER_HIRING', recruitingTeamId: null });
    s.prisma.seed('interviewPoolConfig', { projectId: employerProject.id, jobTitle: 'Sales' });
    s.prisma.seed('employerDossier', { projectId: employerProject.id, legalName: 'ТОВ Ромашка', registryCode: '77', jurisdiction: 'UA' });
    const profile = s.prisma.seed('candidateProfile', { ownerUserId: 'emp', displayName: 'Иван' });
    const status = s.prisma.seed('candidatePipelineStatus', { projectId: employerProject.id, candidateProfileId: profile.id, stage: 'SCHEDULED' });
    const employerSheet = s.prisma.seed('termsSheet', { projectId: employerProject.id, kind: 'INTERVIEW', pipelineStatusId: status.id, title: 'Иван', status: 'DRAFT' });
    const offer = s.prisma.seed('offerDocument', { sheetId: employerSheet.id, rawText: 'Оффер: 2500 USD', source: null, reviewedAt: new Date() });
    const candidateProject = s.prisma.seed('project', { ownerId: 'cand', mode: 'JOB_SEARCH' });
    s.prisma.seed('jobSearchConfig', { projectId: candidateProject.id, desiredRole: 'Sales', cvDraft: null });
    s.prisma.seed('candidateShare', {
      shareToken: 'tok2', sourceCandidateId: null, createdCandidateProfileId: profile.id,
      sharedByUserId: 'cand', consentSource: 'CANDIDATE_SELF', sourceSheetId: null,
      expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null,
    });
    // Конкурент уже записал копию — но чтение её «не увидит».
    const конкурент = s.prisma.seed('employerDossier', { projectId: candidateProject.id, legalName: 'ТОВ Ромашка', registryCode: '77', jurisdiction: 'UA' });

    const делегат = (s.prisma as any).employerDossier;
    let бросили = false;
    Object.defineProperty(s.prisma, 'employerDossier', {
      configurable: true,
      value: {
        ...делегат,
        findFirst: async (args: any) => (args?.where?.projectId === candidateProject.id ? null : делегат.findFirst(args)),
        create: async (args: any) => {
          if (args?.data?.projectId !== candidateProject.id) return делегат.create(args);
          бросили = true;
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        },
      },
    });

    const res = await offers.shareToCandidate('emp', offer.id, { token: 'tok2' });
    delete (s.prisma as any).employerDossier;

    expect(бросили).toBe(true); // перехват сработал, иначе тест пуст
    // Отправка прошла, и вакансия привязана к досье конкурента — то есть
    // проигравший гонку не упал, а подобрал уже созданное.
    expect(res.copy).toBeTruthy();
    const created = s.prisma.rows('jobVacancy').find((v: any) => v.intakeSource === 'EMPLOYER_SHARE' && v.configId);
    expect(s.prisma.rows('jobVacancy').some((v: any) => v.employerDossierId === конкурент.id)).toBe(true);
    void created;
  });
});

// Пункт [job-domain-v2] — приёмка ядра (§11, п. 1–16) на общем фейке Prisma.
import { BadRequestException, ConflictException } from '@nestjs/common';
import { TermsSheetService, coverageCounters, FORBIDDEN_SHEET_KEYS } from '../terms-sheet/terms-sheet.service';
import {
  TermsMatchingService,
  CLAUSES_SYSTEM_PROMPT,
  POSITIONS_SYSTEM_PROMPT,
  MAX_CLAUSES_PER_TEXT,
  sanitizePositionDraft,
  quoteIsFromSource,
} from '../terms-sheet/terms-matching.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';

const VACANCY_TEXT = 'Ищем Backend-разработчика. Требуется опыт с Node.js от 3 лет и знание PostgreSQL. Формат: удалённо. Зарплата до 3000 USD. Испытательный срок 3 месяца.';

function seedJobSearch(prisma: ReturnType<typeof createHiringFakePrisma>) {
  const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
  const config = prisma.seed('jobSearchConfig', { projectId: project.id, desiredRole: 'Backend', city: 'Киев', region: null, cvDraft: null });
  const c1 = prisma.seed('jobSearchCriterion', { configId: config.id, text: 'Удалённая работа', category: 'LOCATION', isRequired: true, orderIndex: 0 });
  const c2 = prisma.seed('jobSearchCriterion', { configId: config.id, text: 'Зарплата от 2500 USD', category: 'COMPENSATION', isRequired: false, orderIndex: 1 });
  const vacancy = prisma.seed('jobVacancy', { configId: config.id, sourceUrl: 'https://work.ua/1', siteHost: 'work.ua', rawText: VACANCY_TEXT, title: 'Backend', duplicateOfId: null });
  return { project, config, c1, c2, vacancy };
}

function seedAgency(prisma: ReturnType<typeof createHiringFakePrisma>, mode = 'INTERVIEW_POOL') {
  const project = prisma.seed('project', { ownerId: 'u2', mode, recruitingTeamId: null });
  const config = prisma.seed('interviewPoolConfig', { projectId: project.id, jobTitle: 'Sales', salaryRange: '1000-1500', workArrangement: 'HYBRID', employmentLoad: null, officeLocation: 'Львов', employmentFormat: null });
  const q1 = prisma.seed('questionnaireItem', { configId: config.id, text: 'Опыт B2B-продаж?', category: 'опыт', isRequired: true, orderIndex: 0 });
  const q2 = prisma.seed('questionnaireItem', { configId: config.id, text: 'Английский B2?', category: 'язык', isRequired: false, orderIndex: 1 });
  const candidate = prisma.seed('candidateProfile', { ownerUserId: 'u2', displayName: 'Иван' });
  const status = prisma.seed('candidatePipelineStatus', { projectId: project.id, candidateProfileId: candidate.id, stage: 'SCHEDULED' });
  return { project, config, q1, q2, candidate, status };
}

const clausesFromVacancy = JSON.stringify({
  clauses: [
    { kind: 'REQUIREMENT', text: 'Опыт Node.js от 3 лет', category: 'роль', isRequired: true, quote: 'опыт с Node.js от 3 лет' },
    { kind: 'REQUIREMENT', text: 'PostgreSQL', category: 'роль', isRequired: false, quote: 'знание PostgreSQL' },
    { kind: 'CONDITION', text: 'Удалённо', category: 'условия', isRequired: false, quote: 'Формат: удалённо' },
    { kind: 'CONDITION', text: 'Зарплата до 3000 USD', category: 'оплата', isRequired: false, quote: 'Зарплата до 3000 USD' },
    { kind: 'CONDITION', text: 'Выдуманный пункт', category: null, isRequired: false, quote: 'этого в тексте нет' },
  ],
});

function makeServices(router: ReturnType<typeof createFakeRouter>) {
  const prisma = createHiringFakePrisma();
  const matching = new TermsMatchingService(prisma as any, router as any);
  const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
  return { prisma, matching, sheets };
}

describe('TermsSheetService — ядро (§11 п. 1–16)', () => {
  it('п.1/п.11: лист по вакансии — CANDIDATE-пункты ровно из критериев с их isRequired и kind=REQUIREMENT; EMPLOYER — черновики из текста, выдуманная цитата отброшена', async () => {
    const router = createFakeRouter(() => clausesFromVacancy);
    const { prisma, sheets } = makeServices(router);
    const s = seedJobSearch(prisma);

    const sheet = await sheets.openForVacancy('u1', s.vacancy.id);

    const candidate = sheet.clauses.filter((c) => c.side === 'CANDIDATE');
    expect(candidate.map((c) => [c.text, c.isRequired, c.kind, c.confirmedAt !== null])).toEqual([
      ['Удалённая работа', true, 'REQUIREMENT', true],
      ['Зарплата от 2500 USD', false, 'REQUIREMENT', true],
    ]);
    const employer = sheet.clauses.filter((c) => c.side === 'EMPLOYER');
    expect(employer).toHaveLength(4); // пятый — цитата не из текста
    expect(employer.every((c) => c.confirmedAt === null)).toBe(true);
    expect(employer.map((c) => c.kind)).toEqual(['REQUIREMENT', 'REQUIREMENT', 'CONDITION', 'CONDITION']);
    expect(employer.every((c) => c.sourceQuote && VACANCY_TEXT.toLowerCase().includes(c.sourceQuote.toLowerCase()))).toBe(true);
    expect(sheet.kind).toBe('VACANCY_RESPONSE');
    expect(sheet.status).toBe('DRAFT');
  });

  it('п.12/п.16: второй лист на ту же вакансию — 409 с existingSheetId; дубль вакансии — 409 с главной', async () => {
    const router = createFakeRouter(() => clausesFromVacancy);
    const { prisma, sheets } = makeServices(router);
    const s = seedJobSearch(prisma);
    const first = await sheets.openForVacancy('u1', s.vacancy.id);
    await expect(sheets.openForVacancy('u1', s.vacancy.id)).rejects.toMatchObject({ response: { existingSheetId: first.id } });
    // закрытый лист — тоже 409, новый не открывается
    await sheets.setStatus('u1', first.id, 'DECLINED' as any);
    await expect(sheets.openForVacancy('u1', s.vacancy.id)).rejects.toBeInstanceOf(ConflictException);

    const dup = prisma.seed('jobVacancy', { configId: s.config.id, sourceUrl: 'https://robota.ua/1', siteHost: 'robota.ua', rawText: VACANCY_TEXT, duplicateOfId: s.vacancy.id });
    await expect(sheets.openForVacancy('u1', dup.id)).rejects.toMatchObject({ response: { primaryVacancyId: s.vacancy.id } });
  });

  it('п.2/п.11: позиция без цитаты → 400; REQUIREMENT не принимает stance, CONDITION — coverage', async () => {
    const router = createFakeRouter(() => clausesFromVacancy);
    const { prisma, sheets } = makeServices(router);
    const s = seedJobSearch(prisma);
    const sheet = await sheets.openForVacancy('u1', s.vacancy.id);
    const req = sheet.clauses.find((c) => c.side === 'CANDIDATE')!;
    const cond = sheet.clauses.find((c) => c.kind === 'CONDITION')!;
    await sheets.confirmClauses('u1', sheet.id, [cond.id]);

    await expect(sheets.addPosition('u1', sheet.id, { clauseId: req.id, bySide: 'EMPLOYER' as any, coverage: 'covered' as any, evidenceQuote: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(sheets.addPosition('u1', sheet.id, { clauseId: req.id, bySide: 'EMPLOYER' as any, stance: 'offered' as any, evidenceQuote: 'удалённо' })).rejects.toThrow(/не принимает stance/);
    await expect(sheets.addPosition('u1', sheet.id, { clauseId: cond.id, bySide: 'CANDIDATE' as any, coverage: 'covered' as any, evidenceQuote: 'ок' })).rejects.toThrow(/не принимает coverage/);
    const ok = await sheets.addPosition('u1', sheet.id, { clauseId: cond.id, bySide: 'CANDIDATE' as any, stance: 'accepted' as any, evidenceQuote: 'меня устраивает удалёнка' });
    expect(ok.find((c) => c.id === cond.id)!.current.CANDIDATE?.stance).toBe('accepted');
  });

  it('п.3/п.15: черновики не влияют на счётчики и повестку; единственный автопереход DRAFT → IN_NEGOTIATION при первом подтверждении; отклонённый остаётся с rejectedAt', async () => {
    const router = createFakeRouter(() => clausesFromVacancy);
    const { prisma, sheets } = makeServices(router);
    const s = seedJobSearch(prisma);
    const sheet = await sheets.openForVacancy('u1', s.vacancy.id);
    const req = sheet.clauses.find((c) => c.side === 'CANDIDATE')!;

    const draft = await prisma.clausePosition.create({
      data: { clauseId: req.id, bySide: 'EMPLOYER', coverage: 'covered', evidenceKind: 'VACANCY_TEXT', evidenceRef: s.vacancy.id, evidenceQuote: 'удалённо', confirmedAt: null },
    });
    let view = await sheets.get('u1', sheet.id);
    expect(view.counters.total.covered).toBe(0);
    expect(view.counters.total.unknown).toBe(2);
    expect(view.status).toBe('DRAFT');
    expect((await sheets.agenda('u1', sheet.id)).map((a) => a.clauseId)).toContain(req.id);

    await sheets.confirmPositions('u1', sheet.id, [draft.id]);
    view = await sheets.get('u1', sheet.id);
    expect(view.counters.total.covered).toBe(1);
    expect(view.status).toBe('IN_NEGOTIATION');
    expect((await sheets.agenda('u1', sheet.id)).map((a) => a.clauseId)).not.toContain(req.id);

    const draft2 = await prisma.clausePosition.create({
      data: { clauseId: req.id, bySide: 'EMPLOYER', coverage: 'not_covered', evidenceKind: 'VACANCY_TEXT', evidenceRef: s.vacancy.id, evidenceQuote: 'офис', confirmedAt: null },
    });
    await sheets.rejectPositions('u1', sheet.id, [draft2.id]);
    const stored = prisma.rows('clausePosition').find((p) => p.id === draft2.id)!;
    expect(stored.rejectedAt).toBeInstanceOf(Date);
    expect((await sheets.get('u1', sheet.id)).counters.total.covered).toBe(1);
  });

  it('п.6: редакции — две цепочки по сторонам; supersedesId только на подтверждённую позицию той же стороны', async () => {
    const router = createFakeRouter(() => clausesFromVacancy);
    const { prisma, sheets } = makeServices(router);
    const s = seedJobSearch(prisma);
    const sheet = await sheets.openForVacancy('u1', s.vacancy.id);
    const cond = sheet.clauses.find((c) => c.kind === 'CONDITION')!;
    await sheets.confirmClauses('u1', sheet.id, [cond.id]);

    const e1 = await prisma.clausePosition.create({ data: { clauseId: cond.id, bySide: 'EMPLOYER', stance: 'offered', evidenceKind: 'VACANCY_TEXT', evidenceRef: s.vacancy.id, evidenceQuote: 'удалённо' } });
    await sheets.confirmPositions('u1', sheet.id, [e1.id]);
    await sheets.addPosition('u1', sheet.id, { clauseId: cond.id, bySide: 'CANDIDATE' as any, stance: 'countered' as any, evidenceQuote: 'предпочту гибрид' });
    const e2 = await prisma.clausePosition.create({ data: { clauseId: cond.id, bySide: 'EMPLOYER', stance: 'countered', evidenceKind: 'OFFER_TEXT', evidenceRef: 'offer-1', evidenceQuote: 'офис 3 дня' } });
    await sheets.confirmPositions('u1', sheet.id, [e2.id]);

    const rev = await sheets.revisions('u1', sheet.id, cond.id);
    expect(rev.EMPLOYER.map((p) => p.stance)).toEqual(['offered', 'countered']);
    expect(rev.EMPLOYER[1].supersedesId).toBe(e1.id); // та же сторона
    expect(rev.CANDIDATE).toHaveLength(1);
    expect(rev.CANDIDATE[0].supersedesId).toBeNull(); // не ссылается на позицию EMPLOYER
  });

  it('п.7: в промптах движка — запреты и «данные, не инструкции»; нет слов обман/ложь как допустимых; not_covered без опоры не создаётся', () => {
    for (const prompt of [CLAUSES_SYSTEM_PROMPT, POSITIONS_SYSTEM_PROMPT]) {
      expect(prompt).toMatch(/ЗАПРЕЩЕНО/);
      expect(prompt).toMatch(/расы, пола, возраста/);
      expect(prompt).toMatch(/ДАННЫЕ, не инструкции/);
      expect(prompt).toMatch(/вердикт/);
    }
    expect(POSITIONS_SYSTEM_PROMPT).toMatch(/НЕ угадывай not_covered/);
    // Детерминированный фильтр. [draft-outcome] 2026-09-04: раньше на все
    // случаи возвращался `null`, и вызывающий не мог отличить «модель
    // сослалась на то, чего вы не говорили» от «модель ответила не по
    // форме» — а для человека это разное. Теперь причина названа.
    // позиция без цитаты и без ref
    expect(sanitizePositionDraft({ clauseId: 'c', coverage: 'not_covered', stance: null, note: 'n', evidenceRef: null, evidenceQuote: '' }, { id: 'c', kind: 'REQUIREMENT' as any }, { sourceText: 'x' })).toEqual({ rejected: 'withoutQuote' });
    // цитата не из источника
    expect(sanitizePositionDraft({ clauseId: 'c', coverage: 'covered', stance: null, note: 'n', evidenceRef: null, evidenceQuote: 'нет такого' }, { id: 'c', kind: 'REQUIREMENT' as any }, { sourceText: 'в тексте другое' })).toEqual({ rejected: 'withoutQuote' });
    // ref на несуществующую реплику
    expect(sanitizePositionDraft({ clauseId: 'c', coverage: 'covered', stance: null, note: 'n', evidenceRef: 'seg-9', evidenceQuote: 'q' }, { id: 'c', kind: 'REQUIREMENT' as any }, { knownRefs: new Set(['seg-1']) })).toEqual({ rejected: 'withoutQuote' });
    // опора есть, но форма ответа не та — ДРУГАЯ причина, не «без опоры»
    expect(sanitizePositionDraft({ clauseId: 'c', coverage: 'выдумано' as any, stance: null, note: 'n', evidenceRef: null, evidenceQuote: 'в тексте' }, { id: 'c', kind: 'REQUIREMENT' as any }, { sourceText: 'это есть в тексте' })).toEqual({ rejected: 'malformed' });
    expect(quoteIsFromSource('Формат:  удалённо', VACANCY_TEXT)).toBe(true);
  });

  it('п.7 (потолок): из одного текста создаётся не больше 40 пунктов; сверка транскрипта пишет ref реплики', async () => {
    const many = JSON.stringify({ clauses: Array.from({ length: 60 }, (_, i) => ({ kind: 'CONDITION', text: `Пункт ${i}`, category: null, isRequired: false, quote: 'Формат: удалённо' })) });
    const router = createFakeRouter((req) => (req.taskType === 'terms-clauses-extract' ? many : JSON.stringify({ positions: [] })));
    const { prisma, sheets } = makeServices(router);
    const s = seedJobSearch(prisma);
    const sheet = await sheets.openForVacancy('u1', s.vacancy.id);
    expect(sheet.clauses.filter((c) => c.side === 'EMPLOYER')).toHaveLength(MAX_CLAUSES_PER_TEXT);
  });

  it('п.10: в DTO листа нет score/rank/probability и нет числовых полей, кроме orderIndex и счётчиков', async () => {
    const router = createFakeRouter(() => clausesFromVacancy);
    const { prisma, sheets } = makeServices(router);
    const s = seedJobSearch(prisma);
    const sheet = await sheets.openForVacancy('u1', s.vacancy.id);
    const json = JSON.stringify(sheet);
    for (const key of FORBIDDEN_SHEET_KEYS) expect(json).not.toContain(`"${key}"`);
    const numericKeys = new Set<string>();
    const walk = (v: any, path: string) => {
      if (typeof v === 'number') numericKeys.add(path);
      else if (Array.isArray(v)) v.forEach((x) => walk(x, path));
      else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, path === 'counters' || path.startsWith('counters.') ? 'counters' : k));
    };
    walk(sheet, '');
    expect([...numericKeys].sort()).toEqual(['counters', 'orderIndex']);
  });

  it('п.13: INTERVIEW-лист наследует подтверждённые пункты VACANCY (вопросы → REQUIREMENT, конфиг → CONDITION); новый подтверждённый пункт VACANCY появляется в открытых INTERVIEW-листах', async () => {
    const router = createFakeRouter(() => JSON.stringify({ clauses: [] }));
    const { prisma, sheets } = makeServices(router);
    const a = seedAgency(prisma);

    const interview = await sheets.openForCandidate('u2', a.status.id);
    expect(interview.kind).toBe('INTERVIEW');
    const inherited = interview.clauses;
    expect(inherited.filter((c) => c.kind === 'REQUIREMENT').map((c) => c.text)).toEqual(['Опыт B2B-продаж?', 'Английский B2?']);
    expect(inherited.filter((c) => c.kind === 'CONDITION').map((c) => c.text)).toEqual(['Оплата: 1000-1500', 'Формат работы: HYBRID', 'Локация: Львов']);
    expect(inherited.every((c) => c.sourceClauseId && c.confirmedAt)).toBe(true);
    expect(inherited.filter((c) => c.side === 'CANDIDATE')).toHaveLength(0);

    const vacancySheet = prisma.rows('termsSheet').find((s) => s.kind === 'VACANCY')!;
    await sheets.addClause('u2', vacancySheet.id, { side: 'EMPLOYER' as any, kind: 'REQUIREMENT' as any, text: 'Готовность к командировкам', isRequired: false });
    const after = await sheets.get('u2', interview.id);
    expect(after.clauses.map((c) => c.text)).toContain('Готовность к командировкам');
    // повторный вызов «без кнопки» возвращает тот же лист, с кнопкой — 409
    expect((await sheets.openForCandidate('u2', a.status.id, { silent: true })).id).toBe(interview.id);
    await expect(sheets.openForCandidate('u2', a.status.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('п.12 (XOR по режиму): лист VACANCY в проекте соискателя → 400; проект работодателя открывает VACANCY так же, как агентство', async () => {
    const router = createFakeRouter(() => JSON.stringify({ clauses: [] }));
    const { prisma, sheets } = makeServices(router);
    const s = seedJobSearch(prisma);
    await expect(sheets.openVacancySheet('u1', s.project.id)).rejects.toBeInstanceOf(BadRequestException);
    const e = seedAgency(prisma, 'EMPLOYER_HIRING');
    const sheet = await sheets.openVacancySheet('u2', e.project.id);
    expect(sheet.kind).toBe('VACANCY');
    expect(sheet.clauses).toHaveLength(5);
  });

  it('п.15: в терминальный статус — только явно; закрытый лист сначала возобновляют; DRAFT руками не вернуть', async () => {
    const router = createFakeRouter(() => JSON.stringify({ clauses: [] }));
    const { prisma, sheets } = makeServices(router);
    const a = seedAgency(prisma);
    const sheet = await sheets.openVacancySheet('u2', a.project.id);
    await expect(sheets.setStatus('u2', sheet.id, 'DRAFT' as any)).rejects.toBeInstanceOf(BadRequestException);
    await sheets.setStatus('u2', sheet.id, 'AGREED' as any);
    await expect(sheets.setStatus('u2', sheet.id, 'DECLINED' as any)).rejects.toBeInstanceOf(BadRequestException);
    await sheets.setStatus('u2', sheet.id, 'IN_NEGOTIATION' as any);
    const reopened = await sheets.setStatus('u2', sheet.id, 'DECLINED' as any);
    expect(reopened.status).toBe('DECLINED');
  });

  it('оффер-конструктор (А-1): детерминированный черновик из accepted/covered с цитатами, без чисел по человеку', async () => {
    const router = createFakeRouter(() => JSON.stringify({ clauses: [] }));
    const { prisma, sheets } = makeServices(router);
    const a = seedAgency(prisma);
    const interview = await sheets.openForCandidate('u2', a.status.id);
    const req = interview.clauses.find((c) => c.text === 'Опыт B2B-продаж?')!;
    const cond = interview.clauses.find((c) => c.text === 'Оплата: 1000-1500')!;
    await sheets.addPosition('u2', interview.id, { clauseId: req.id, bySide: 'CANDIDATE' as any, coverage: 'covered' as any, evidenceQuote: 'пять лет в B2B' });
    await sheets.addPosition('u2', interview.id, { clauseId: cond.id, bySide: 'CANDIDATE' as any, stance: 'accepted' as any, evidenceQuote: 'вилка устраивает' });
    const draft = await sheets.offerDraft('u2', interview.id);
    expect(draft.text).toContain('«пять лет в B2B»');
    expect(draft.text).toContain('«вилка устраивает»');
    expect(draft.text).toContain('не оффер');
    expect(draft.agreedCount).toBe(2);
    expect(draft.openCount).toBeGreaterThan(0);
  });

  it('пара «одно условие с двух сторон»: подтверждает человек; два пункта одной стороны парой быть не могут', async () => {
    const router = createFakeRouter(() => clausesFromVacancy);
    const { prisma, sheets } = makeServices(router);
    const s = seedJobSearch(prisma);
    const sheet = await sheets.openForVacancy('u1', s.vacancy.id);
    const mine = sheet.clauses.find((c) => c.text === 'Удалённая работа')!;
    const theirs = sheet.clauses.find((c) => c.text === 'Удалённо')!;
    const other = sheet.clauses.find((c) => c.text === 'Зарплата от 2500 USD')!;
    await expect(sheets.setCounterpart('u1', sheet.id, mine.id, other.id)).rejects.toBeInstanceOf(BadRequestException);
    const clauses = await sheets.setCounterpart('u1', sheet.id, mine.id, theirs.id);
    expect(clauses.find((c) => c.id === mine.id)!.counterpartClauseId).toBe(theirs.id);
    expect(clauses.find((c) => c.id === theirs.id)!.counterpartClauseId).toBe(mine.id);
    expect(clauses.find((c) => c.id === theirs.id)!.counterpartConfirmedAt).toBeInstanceOf(Date);
  });

  it('coverageCounters: считает только подтверждённые требования по позиции ДРУГОЙ стороны', () => {
    const base = { category: 'x', isRequired: true, orderIndex: 0, sourceEvidence: null, sourceRef: null, sourceQuote: null, sourceClauseId: null, rejectedAt: null, counterpartClauseId: null, counterpartConfirmedAt: null, drafts: [] } as any;
    const pos = (coverage: string) => ({ coverage, stance: null, bySide: 'EMPLOYER' } as any);
    const counters = coverageCounters([
      { ...base, id: '1', side: 'CANDIDATE', kind: 'REQUIREMENT', text: 'a', confirmedAt: new Date(), current: { EMPLOYER: pos('covered'), CANDIDATE: null } },
      { ...base, id: '2', side: 'CANDIDATE', kind: 'REQUIREMENT', text: 'b', confirmedAt: new Date(), current: { EMPLOYER: null, CANDIDATE: pos('covered') } }, // своя позиция не считается
      { ...base, id: '3', side: 'CANDIDATE', kind: 'REQUIREMENT', text: 'c', confirmedAt: null, current: { EMPLOYER: pos('covered'), CANDIDATE: null } }, // черновик пункта
      { ...base, id: '4', side: 'EMPLOYER', kind: 'CONDITION', text: 'd', confirmedAt: new Date(), current: { EMPLOYER: null, CANDIDATE: null } }, // условие — не покрытие
    ]);
    expect(counters.total).toEqual({ covered: 1, partial: 0, not_covered: 0, unknown: 1 });
  });
});

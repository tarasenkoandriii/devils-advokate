// Пункт [job-domain-v2] — остальные функции этапа 2 парами (К-2/А-8, К-4, К-6,
// К-9/А-5, К-10, А-2, А-3, А-7, А-9, А-10, Р-8, Р-10, Р-12, Р-14) на общем фейке.
import { CONSENT_REVOKED_MESSAGE } from '../interview-pool/consent-revocation';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  HiringExtrasService,
  AI_NOTICE_VERSION,
  DEBRIEF_COMPLIANCE_TASK_TYPE,
  PRE_QUESTIONNAIRE_TTL_MS,
  SALARY_SCENARIOS_TASK_TYPE,
  SALARY_SCENARIOS_PROMPT,
  SHEET_LIVE_HINT_TASK_TYPE,
  SHEET_LIVE_HINT_PROMPT,
  TEST_ASSIGNMENT_CATEGORY,
} from '../hiring-extras/hiring-extras.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService, TERMS_MATCH_TASK_TYPE, TERMS_CLAUSES_EXTRACT_TASK_TYPE } from '../terms-sheet/terms-matching.service';
import { createHiringFakePrisma, createFakeRouter } from './fake-prisma';

process.env.TELEGRAM_BOT_USERNAME = 'devils_advocate_test_bot';

/** Роутер-фейк: сверка «каждый пункт из промпта — covered с цитатой из источника»,
 * извлечение — один пункт на строку задания, остальное — по taskType. */
function smartHandler(overrides: Record<string, (req: any) => string> = {}) {
  return (req: any) => {
    if (overrides[req.taskType]) return overrides[req.taskType](req);
    if (req.taskType === TERMS_MATCH_TASK_TYPE) {
      const ids = [...req.userPrompt.matchAll(/\[id=([^\]]+)\] \((EMPLOYER|CANDIDATE), (REQUIREMENT|CONDITION)/g)].map((m) => [m[1], m[3]] as [string, string]);
      const seg = /\[id=([^\]]+)\] ([^\n]+)$/m.exec(req.userPrompt.split('Транскрипт:\n')[1] ?? '');
      const textSrc = req.userPrompt.split('Текст источника')[1]?.split(':\n')[1] ?? '';
      const quote = seg ? seg[2].trim() : textSrc.trim().split(/\s+/).slice(0, 2).join(' ');
      return JSON.stringify({
        positions: ids.map(([id, kind]) => ({ clauseId: id, coverage: kind === 'REQUIREMENT' ? 'covered' : null, stance: kind === 'CONDITION' ? 'accepted' : null, note: 'из слов источника', evidenceRef: seg ? seg[1] : null, evidenceQuote: quote })),
      });
    }
    if (req.taskType === TERMS_CLAUSES_EXTRACT_TASK_TYPE) {
      const text = req.userPrompt.split('\n').filter((l: string) => l.startsWith('- ')).map((l: string) => l.slice(2));
      return JSON.stringify({ clauses: text.map((t: string) => ({ kind: 'REQUIREMENT', text: t, category: 'задание', isRequired: true, quote: t })) });
    }
    return '{}';
  };
}

function setup(overrides: Record<string, (req: any) => string> = {}) {
  const prisma = createHiringFakePrisma();
  const router = createFakeRouter(smartHandler(overrides));
  const audit = {
    records: [] as any[],
    record: async (r: any) => {
      audit.records.push(r);
      prisma.seed('auditLogEntry', { actorId: r.actorId, action: r.action, resource: r.resource, resourceId: r.resourceId, after: r.after ?? null });
      return r;
    },
  };
  const matching = new TermsMatchingService(prisma as any, router as any);
  const sheets = new TermsSheetService(prisma as any, matching, audit as any);
  const extras = new HiringExtrasService(prisma as any, router as any, audit as any, sheets, matching);
  return { prisma, router, audit, sheets, matching, extras };
}

function seedJobSearch(prisma: any) {
  const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
  const config = prisma.seed('jobSearchConfig', { projectId: project.id, desiredRole: 'Backend', cvDraft: null });
  prisma.seed('jobSearchCriterion', { configId: config.id, text: 'Удалённая работа', category: 'LOCATION', isRequired: true, orderIndex: 0 });
  const vacancy = prisma.seed('jobVacancy', { configId: config.id, sourceUrl: 'https://work.ua/1', siteHost: 'work.ua', rawText: 'Backend. Удалённо. Зарплата до 3000 USD.', title: 'Backend', duplicateOfId: null });
  return { project, config, vacancy };
}

function seedTeamProject(prisma: any, userId: string, mode: 'INTERVIEW_POOL' | 'EMPLOYER_HIRING') {
  const project = prisma.seed('project', { ownerId: userId, mode, recruitingTeamId: null });
  const config = prisma.seed('interviewPoolConfig', { projectId: project.id, jobTitle: 'Sales', salaryRange: '1000-1500', workArrangement: 'HYBRID', employmentLoad: null, officeLocation: 'Львов', employmentFormat: null });
  const q1 = prisma.seed('questionnaireItem', { configId: config.id, text: 'Опыт B2B-продаж?', category: 'опыт', isRequired: true, orderIndex: 0 });
  const q2 = prisma.seed('questionnaireItem', { configId: config.id, text: 'Английский B2?', category: 'язык', isRequired: false, orderIndex: 1 });
  return { project, config, q1, q2 };
}

function seedCandidate(prisma: any, projectId: string, userId: string, displayName: string, extra: Record<string, any> = {}) {
  const profile = prisma.seed('candidateProfile', { ownerUserId: userId, displayName, ...extra });
  const status = prisma.seed('candidatePipelineStatus', { projectId, candidateProfileId: profile.id, stage: 'SCHEDULED' });
  return { profile, status };
}

/** Лист соискателя по вакансии без AI-извлечения: EMPLOYER-пункты сеем руками. */
async function candidateSheetWithEmployerClauses(s: ReturnType<typeof setup>) {
  const js = seedJobSearch(s.prisma);
  const sheet = await s.sheets.openForVacancy('u1', js.vacancy.id); // extract → '{}' → 0 черновиков
  const c1 = s.prisma.seed('termsClause', { sheetId: sheet.id, side: 'EMPLOYER', kind: 'CONDITION', text: 'Удалённо', category: 'условия', isRequired: false, orderIndex: 10, confirmedAt: new Date() });
  const c2 = s.prisma.seed('termsClause', { sheetId: sheet.id, side: 'EMPLOYER', kind: 'CONDITION', text: 'Зарплата до 3000 USD', category: 'оплата', isRequired: false, orderIndex: 11, confirmedAt: new Date() });
  return { js, sheet, c1, c2 };
}

describe('HiringExtrasService — К-2 / А-8 / К-4 / К-6 / К-9 / К-10', () => {
  it('К-2: позиции репетиции — только из реплик соискателя (реплики AI-интервьюера в промпт не попадают), USER_STATED со ссылкой на сессию; не тот лист → 400', async () => {
    const s = setup();
    const { js, sheet, c1, c2 } = await candidateSheetWithEmployerClauses(s);
    const session = s.prisma.seed('sparringSession', { projectId: js.project.id, scenario: 'x' });
    s.prisma.seed('sparringMessage', { sessionId: session.id, role: 'OPPONENT', text: 'СЕКРЕТ-ИНТЕРВЬЮЕРА почему вы уходите?' });
    s.prisma.seed('sparringMessage', { sessionId: session.id, role: 'USER', text: 'Мне важна удалёнка и зарплата от 2500' });

    const res = await s.extras.positionsFromRehearsal('u1', sheet.id, session.id);
    const matchCall = s.router.calls.find((c) => c.taskType === TERMS_MATCH_TASK_TYPE);
    expect(matchCall.userPrompt).not.toContain('СЕКРЕТ-ИНТЕРВЬЮЕРА');
    expect(matchCall.userPrompt).toContain('Мне важна удалёнка');
    expect(res.proposedPositions).toHaveLength(2);
    expect(res.proposedPositions.every((p: any) => p.evidenceKind === 'USER_STATED' && p.evidenceRef === session.id && p.bySide === 'CANDIDATE' && p.confirmedAt === null)).toBe(true);
    expect(res.closedByWords.sort()).toEqual([c1.text, c2.text].sort());
    expect(res.frame).toMatch(/правильных ответов/);

    // лист кандидата у агентства — не для репетиции
    const t = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    const cand = seedCandidate(s.prisma, t.project.id, 'u2', 'Иван');
    const interview = await s.sheets.openForCandidate('u2', cand.status.id);
    await expect(s.extras.positionsFromRehearsal('u2', interview.id, session.id)).rejects.toBeInstanceOf(BadRequestException);
    // пустая сессия
    const empty = s.prisma.seed('sparringSession', { projectId: js.project.id, scenario: 'x' });
    await expect(s.extras.positionsFromRehearsal('u1', sheet.id, empty.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('А-8: дебриф — позиции INTERVIEWER_DEBRIEF по EMPLOYER-пунктам, защищённые признаки → ComplianceFlag debrief:*, не позиция; для соискателя → 400', async () => {
    const s = setup({
      [DEBRIEF_COMPLIANCE_TASK_TYPE]: () => JSON.stringify({ flags: [{ category: 'возраст', quotedText: 'слишком молодой', alternativeText: '' }, { category: 'x', quotedText: 'этого нет', alternativeText: '' }] }),
    });
    const t = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    const cand = seedCandidate(s.prisma, t.project.id, 'u2', 'Иван');
    const interview = await s.sheets.openForCandidate('u2', cand.status.id);

    const res = await s.extras.debrief('u2', interview.id, 'Кандидат уверенно рассказал про B2B-продажи, но слишком молодой');
    expect(res.marker).toBe('мнение интервьюера');
    expect(res.proposedPositions.length).toBeGreaterThan(0);
    expect(res.proposedPositions.every((p: any) => p.evidenceKind === 'INTERVIEWER_DEBRIEF' && p.evidenceRef === null)).toBe(true);
    // позиции только по пунктам EMPLOYER
    const employerIds = new Set(s.prisma.rows('termsClause').filter((c) => c.sheetId === interview.id && c.side === 'EMPLOYER').map((c) => c.id));
    expect(res.proposedPositions.every((p: any) => employerIds.has(p.clauseId))).toBe(true);
    expect(res.complianceFlags).toBe(1); // вторая цитата не из текста — отброшена
    // [dropped-quotes] 2026-09-04: и отброшенное теперь СЧИТАЕТСЯ. Экран
    // печатает «compliance-флагов: N» только при N > 0, то есть флаг о
    // защищённом признаке, процитированный неточно, исчезал совсем — а
    // это ровно тот признак, по которому нельзя отбирать.
    expect(res.skippedWithoutQuote).toBe(1);
    expect(s.prisma.rows('complianceFlag')).toHaveLength(1);
    expect(s.prisma.rows('complianceFlag')[0]).toMatchObject({ configId: t.config.id, category: 'debrief:возраст', quotedText: 'слишком молодой' });

    const { sheet } = await candidateSheetWithEmployerClauses(s);
    await expect(s.extras.debrief('u1', sheet.id, 'x')).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.extras.debrief('u2', interview.id, '   ')).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── Пункт [not-checked-looks-clean] 2026-09-06 ──
  //
  // Два соседних пробела в этом же месте уже закрыты: находка без цитаты
  // считается ([dropped-quotes]), непрочитанный хвост назван
  // ([input-truncated]). Оставался третий и самый крупный: проверка могла
  // не выполниться ВООБЩЕ — и тогда `complianceFlags: 0` уходило наружу
  // неотличимым от «проверили, спорного нет». Речь о защищённых
  // признаках, по которым отбирать нельзя.
  it('КЛЮЧЕВОЙ ТЕСТ [not-checked-looks-clean]: сбой провайдера — это не «спорного нет»', async () => {
    const s = setup({
      [DEBRIEF_COMPLIANCE_TASK_TYPE]: () => {
        throw new Error('провайдер недоступен');
      },
    });
    const t = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    const cand = seedCandidate(s.prisma, t.project.id, 'u2', 'Иван');
    const interview = await s.sheets.openForCandidate('u2', cand.status.id);

    const res = await s.extras.debrief('u2', interview.id, 'Кандидат уверенно рассказал про B2B-продажи, но слишком молодой');
    // Ответ по-прежнему не падает — черновики позиций уже созданы, ронять
    // их из-за побочной проверки значит терять сделанную работу.
    expect(res.proposedPositions.length).toBeGreaterThan(0);
    expect(res.complianceFlags).toBe(0);
    // ...но ноль теперь ОБЪЯСНЁН, и это вся суть пункта.
    expect(res.complianceNotChecked).toBe('provider-failed');
    expect(s.prisma.rows('complianceFlag')).toHaveLength(0);
  });

  it('[not-checked-looks-clean]: без конфига проверки ноль тоже ничего не утверждает', async () => {
    const s = setup();
    const t = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    const cand = seedCandidate(s.prisma, t.project.id, 'u2', 'Иван');
    const interview = await s.sheets.openForCandidate('u2', cand.status.id);
    // Конфиг убран уже после открытия листа: ветка `if (config)` молча
    // пропускалась, и это ровно «конфигурационный пробел выглядит как
    // отсутствие находок» — принцип, ради которого он и записан.
    s.prisma.rows('interviewPoolConfig').length = 0;

    const res = await s.extras.debrief('u2', interview.id, 'Кандидат слишком молодой');
    expect(res.complianceFlags).toBe(0);
    expect(res.complianceNotChecked).toBe('not-configured');
  });

  it('[not-checked-looks-clean]: удачная проверка НЕ помечается — иначе пометку перестанут читать', async () => {
    const s = setup({
      [DEBRIEF_COMPLIANCE_TASK_TYPE]: () => JSON.stringify({ flags: [] }),
    });
    const t = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    const cand = seedCandidate(s.prisma, t.project.id, 'u2', 'Иван');
    const interview = await s.sheets.openForCandidate('u2', cand.status.id);
    const res = await s.extras.debrief('u2', interview.id, 'Кандидат рассказал про B2B-продажи');
    expect(res.complianceFlags).toBe(0);
    expect(res.complianceNotChecked).toBeNull();
  });

  it('К-4: без границ → 400; сценарии строятся из границ и пунктов оплаты; промпт запрещает «рыночную» зарплату и вероятности', async () => {
    const s = setup({
      [SALARY_SCENARIOS_TASK_TYPE]: () => JSON.stringify({ scenarios: [{ kind: 'accept', consequences: 'ниже идеала, выше точки отказа', script: null }, { kind: 'counter', consequences: 'x', script: 'Мне важно 2800' }, { kind: 'decline', consequences: 'BATNA', script: null }] }),
    });
    const { js, sheet } = await candidateSheetWithEmployerClauses(s);
    await expect(s.extras.salaryScenarios('u1', sheet.id)).rejects.toThrow(/границы переговоров/);
    s.prisma.seed('negotiationBoundaries', { projectId: js.project.id, idealOutcome: '3000', acceptableOutcome: '2500', batna: 'текущая работа', watna: null, walkAwayPoint: '2200' });

    const res = await s.extras.salaryScenarios('u1', sheet.id);
    expect(res.scenarios.map((x: any) => x.kind)).toEqual(['accept', 'counter', 'decline']);
    const call = s.router.calls.find((c) => c.taskType === SALARY_SCENARIOS_TASK_TYPE);
    expect(call.userPrompt).toContain('Идеал: 3000');
    expect(call.userPrompt).toContain('Зарплата до 3000 USD');
    expect(call.userPrompt).not.toContain('Удалённо'); // только пункты оплаты
    expect(SALARY_SCENARIOS_PROMPT).toMatch(/ЗАПРЕЩЕНО: называть «рыночную» зарплату/);
    expect(res.frame).toMatch(/confidence не заполняется/);

    // у агентства — не применимо
    const t = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    const cand = seedCandidate(s.prisma, t.project.id, 'u2', 'Иван');
    const interview = await s.sheets.openForCandidate('u2', cand.status.id);
    await expect(s.extras.salaryScenarios('u2', interview.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('К-6: подсказка только по ещё не обсуждённым пунктам своего листа; уже подсказанный пункт не повторяется; когда открытых нет — null без AI-вызова', async () => {
    const s = setup({ [SHEET_LIVE_HINT_TASK_TYPE]: () => JSON.stringify({ suggestedClauseIndex: 0, hintText: 'Пункт про удалёнку ещё не обсуждён' }) });
    const { sheet, c1, c2 } = await candidateSheetWithEmployerClauses(s);
    // c2 уже закрыт позицией соискателя; свой пункт «Удалённая работа» закрыт позицией работодателя
    s.prisma.seed('clausePosition', { clauseId: c2.id, bySide: 'CANDIDATE', stance: 'accepted', coverage: null, evidenceKind: 'USER_STATED', evidenceRef: null, evidenceQuote: 'ок', confirmedAt: new Date() });
    const own = s.prisma.rows('termsClause').find((c) => c.sheetId === sheet.id && c.side === 'CANDIDATE')!;
    s.prisma.seed('clausePosition', { clauseId: own.id, bySide: 'EMPLOYER', coverage: 'covered', stance: null, evidenceKind: 'VACANCY_TEXT', evidenceRef: 'v', evidenceQuote: 'Удалённо', confirmedAt: new Date() });

    const hint = await s.extras.liveHint('u1', sheet.id, 'Интервьюер: расскажите о себе');
    expect(hint).toMatchObject({ hintType: 'UNASKED_QUESTION', clauseId: c1.id, projectId: sheet.projectId });
    const call = s.router.calls.find((c) => c.taskType === SHEET_LIVE_HINT_TASK_TYPE);
    expect(call.userPrompt).toContain('[0] Удалённо');
    expect(call.userPrompt).not.toContain('Зарплата до 3000');
    expect(SHEET_LIVE_HINT_PROMPT).toMatch(/ЗАПРЕЩЕНО: любые оценки собеседника/);

    const before = s.router.calls.length;
    expect(await s.extras.liveHint('u1', sheet.id, 'дальше')).toBeNull();
    expect(s.router.calls.length).toBe(before); // открытых не осталось — AI не вызывается
    await expect(s.extras.liveHint('u1', sheet.id, '  ')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('К-9/А-5: требования задания → подтверждённые пункты EMPLOYER/REQUIREMENT категории «тестовое задание», ответ → покрытие по пунктам без «правильно/неправильно»', async () => {
    const s = setup();
    const { sheet } = await candidateSheetWithEmployerClauses(s);
    const res = await s.extras.testAssignment('u1', sheet.id, { assignmentText: '- Написать REST API\n- Покрыть тестами', answerText: 'Сделал REST API на Nest, тесты написал на jest' });
    expect(res.requirements).toHaveLength(2);
    expect(res.requirements.map((r: any) => r.text)).toEqual(['Написать REST API', 'Покрыть тестами']);
    expect(res.requirements.every((r: any) => r.coverage === 'covered' && r.quote)).toBe(true);
    const clauses = s.prisma.rows('termsClause').filter((c) => c.category === TEST_ASSIGNMENT_CATEGORY);
    expect(clauses).toHaveLength(2);
    expect(clauses.every((c) => c.side === 'EMPLOYER' && c.kind === 'REQUIREMENT' && c.confirmedAt)).toBe(true);
    expect(res.frame).toMatch(/не «правильно \/ неправильно»/);
    await expect(s.extras.testAssignment('u1', sheet.id, { assignmentText: '', answerText: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('К-10: прогноз по процессу пишется в Prediction проекта с заголовком листа; у агентства — 400', async () => {
    const s = setup();
    const { js, sheet } = await candidateSheetWithEmployerClauses(s);
    const p = await s.extras.createPrediction('u1', sheet.id, 'Предложат 2600');
    expect(p).toMatchObject({ projectId: js.project.id, predictedOutcome: `[${sheet.title}] Предложат 2600` });
    await expect(s.extras.createPrediction('u1', sheet.id, '  ')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('HiringExtrasService — А-2 преданкета по ссылке', () => {
  it('КЛЮЧЕВОЙ ТЕСТ [one-of-several-spoke-for-all]: две компании — кандидату не называют одну из них наугад', async () => {
    // Это экран, на котором кандидат видит, КТО его пригласил, перед
    // тем как отвечать на вопросы. Неверное имя компании здесь — не
    // косметика: человек решает, отдавать ли свои данные.
    const s = setup();
    const t = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    const cand = seedCandidate(s.prisma, t.project.id, 'u2', 'Иван');
    s.prisma.seed('employerDossier', { projectId: t.project.id, legalName: 'ТОВ Ромашка', registryCode: '111', jurisdiction: 'UA' });
    s.prisma.seed('employerDossier', { projectId: t.project.id, legalName: 'ТОВ Василёк', registryCode: '222', jurisdiction: 'UA' });

    const inv = await s.extras.createPreQuestionnaire('u2', cand.status.id);
    const form = await s.extras.preQuestionnaireForm(inv.token);
    expect(form.company).toBeNull();
  });

  it('ссылка с TTL; форма — только вопросы и два согласия; без обоих согласий → 403; ответы → сегменты + черновики позиций; повтор → 400; просрочка → 404', async () => {
    const s = setup();
    const t = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    const cand = seedCandidate(s.prisma, t.project.id, 'u2', 'Иван');
    s.prisma.seed('employerDossier', { projectId: t.project.id, legalName: 'ТОВ Ромашка', jurisdiction: 'UA' });

    await expect(s.extras.createPreQuestionnaire('stranger', cand.status.id)).rejects.toBeInstanceOf(NotFoundException);
    const inv = await s.extras.createPreQuestionnaire('u2', cand.status.id);
    expect(inv.deepLink).toContain(`preq_${inv.token}`);
    expect(inv.expiresAt.getTime() - Date.now()).toBeGreaterThan(PRE_QUESTIONNAIRE_TTL_MS - 5000);

    const form = await s.extras.preQuestionnaireForm(inv.token);
    expect(form).toMatchObject({ jobTitle: 'Sales', company: 'ТОВ Ромашка', answered: false });
    expect(form.questions.map((q: any) => q.text)).toEqual(['Опыт B2B-продаж?', 'Английский B2?']);
    expect(Object.keys(form)).not.toContain('candidates');
    expect(form.consents.aiNotice).toMatch(/решение принимает человек/);

    await expect(s.extras.submitPreQuestionnaire(inv.token, { aiNoticeAccepted: true, transferConsentAccepted: false, answers: [{ questionId: t.q1.id, text: 'x' }] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.extras.submitPreQuestionnaire(inv.token, { aiNoticeAccepted: true, transferConsentAccepted: true, answers: [] })).rejects.toBeInstanceOf(BadRequestException);

    const res = await s.extras.submitPreQuestionnaire(inv.token, { aiNoticeAccepted: true, transferConsentAccepted: true, answers: [{ questionId: t.q1.id, text: 'Три года B2B в SaaS' }, { questionId: 'нет-такого', text: 'Свободно говорю' }] });
    expect(res).toMatchObject({ ok: true, answers: 2 });
    expect(res.proposedPositions).toBeGreaterThan(0);
    expect(res.note).toMatch(/не оцениваются числом/);
    const segments = s.prisma.rows('transcriptSegment');
    expect(segments.map((x) => x.text)).toEqual(['[Опыт B2B-продаж?] Три года B2B в SaaS', 'Свободно говорю']);
    const invite = s.prisma.rows('preQuestionnaireInvite')[0];
    expect(invite.answeredAt).toBeInstanceOf(Date);
    expect(invite.aiNoticeAcceptedAt).toBeInstanceOf(Date);
    expect(invite.transferConsentAcceptedAt).toBeInstanceOf(Date);
    expect(invite.conversationId).toBe(s.prisma.rows('conversation')[0].id);
    // позиции — TRANSCRIPT_SEGMENT со ссылкой на сегмент, черновики, лист кандидата открыт от имени владельца
    const positions = s.prisma.rows('clausePosition');
    expect(positions.every((p) => p.evidenceKind === 'TRANSCRIPT_SEGMENT' && segments.some((g) => g.id === p.evidenceRef) && p.confirmedAt === null)).toBe(true);
    expect(s.prisma.rows('termsSheet').find((x) => x.pipelineStatusId === cand.status.id)).toBeTruthy();

    await expect(s.extras.submitPreQuestionnaire(inv.token, { aiNoticeAccepted: true, transferConsentAccepted: true, answers: [{ questionId: t.q1.id, text: 'x' }] })).rejects.toBeInstanceOf(BadRequestException);
    invite.expiresAt = new Date(Date.now() - 1000);
    await expect(s.extras.preQuestionnaireForm(inv.token)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.extras.preQuestionnaireForm('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('HiringExtrasService — А-3 / А-7 / А-9 / А-10', () => {
  it('А-3: матрица — столбцы = обязательные/необязательные REQUIREMENT листа вакансии, строки = кандидаты с листами, кандидат с отозванным согласием остаётся строкой с отметкой и пустыми клетками, столбца «итог» нет', async () => {
    const s = setup();
    const t = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    const a = seedCandidate(s.prisma, t.project.id, 'u2', 'Иван');
    const b = seedCandidate(s.prisma, t.project.id, 'u2', 'Пётр');
    const c = seedCandidate(s.prisma, t.project.id, 'u2', 'Отозвал', { consentRevokedAt: new Date() });
    const sa = await s.sheets.openForCandidate('u2', a.status.id);
    await s.sheets.openForCandidate('u2', b.status.id);
    await s.sheets.openForCandidate('u2', c.status.id);
    // у Ивана закрыт первый пункт
    const first = s.prisma.rows('termsClause').find((x) => x.sheetId === sa.id && x.side === 'EMPLOYER' && x.kind === 'REQUIREMENT');
    s.prisma.seed('clausePosition', { clauseId: first!.id, bySide: 'CANDIDATE', coverage: 'covered', stance: null, evidenceKind: 'TRANSCRIPT_SEGMENT', evidenceRef: 'seg-1', evidenceQuote: 'три года', confirmedAt: new Date() });

    const m = await s.extras.coverageMatrix('u2', t.project.id);
    expect(m.columns.map((x: any) => [x.text, x.isRequired])).toEqual([['Опыт B2B-продаж?', true], ['Английский B2?', false]]);
    /** ПЕРЕПИСАН, Пункт [revocation-not-one-rule] 2026-09-06. Тест
     * требовал, чтобы кандидат с отозванным согласием ИСЧЕЗАЛ из
     * матрицы. Но границу этого правила `consent-revocation.ts`
     * объявляет прямым текстом: «отзыв НЕ прячет кандидата из
     * внутренних списков рекрутера — исчезнувший без следа человек
     * выглядит как сбой продукта, а не как исполненная воля кандидата;
     * в списке он остаётся с отметкой». Тест закреплял поведение,
     * которое своя же документация запрещает. Требование не ослаблено:
     * покрытие по нему по-прежнему НЕ пересобирается (клетки пусты), и
     * это проверяется ниже. */
    expect(m.rows.map((r: any) => r.displayName)).toEqual(['Иван', 'Пётр', 'Отозвал']);
    /** `as any` намеренно: без него отсутствие полей ловит КОМПИЛЯТОР
     * (тип строки теряет `consentRevoked`/`note`), и проверка
     * превращается в структурную. Компилятор здесь тоже держит
     * контракт — и это сильнее теста, — но ручная сверка мутации
     * показала, что тогда РАНТАЙМ-поведение не проверяется вовсе:
     * строку можно было бы вернуть без отметки, и тест не запустился
     * бы, а не упал. Нужны оба: тип держит форму, тест держит
     * поведение. */
    const revoked = m.rows.find((r: any) => r.displayName === 'Отозвал') as any;
    expect(revoked.consentRevoked).toBe(true);
    expect(Object.keys(revoked.cells)).toEqual([]);
    expect(revoked.openQuestions).toEqual([]);
    expect(revoked.note).toMatch(/отозвал согласие/i);
    expect(m.revokedRows).toBe(1);
    const ivan = m.rows[0];
    expect(ivan.cells[m.columns[0].clauseId]).toMatchObject({ coverage: 'covered', quote: 'три года', evidenceRef: 'seg-1' });
    expect(ivan.cells[m.columns[1].clauseId].coverage).toBe('unknown');
    expect(ivan.openQuestions).toEqual(['Английский B2?']);
    expect(Object.keys(ivan)).not.toEqual(expect.arrayContaining(['score', 'total', 'rank']));
    expect(m.note).toMatch(/Столбца «итог» нет/);

    const js = seedJobSearch(s.prisma);
    await expect(s.extras.coverageMatrix('u1', js.project.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('А-7: обещание кандидату → Commitment с candidateProfileId; сводка — кто ждёт дольше N дней и просроченные обещания, без рейтингов рекрутеров', async () => {
    const s = setup();
    const t = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    const a = seedCandidate(s.prisma, t.project.id, 'u2', 'Иван');
    const b = seedCandidate(s.prisma, t.project.id, 'u2', 'Пётр');
    const sa = await s.sheets.openForCandidate('u2', a.status.id);
    const now = new Date('2026-09-10T00:00:00Z');
    const promise = await s.extras.promiseToCandidate('u2', sa.id, { description: 'Вернуться с ответом', dueDate: '2026-09-05' });
    expect(promise).toMatchObject({ projectId: t.project.id, candidateProfileId: a.profile.id, owner: 'USER', status: 'IN_PROGRESS' });

    a.status.stage = 'AWAITING_FOLLOWUP';
    a.status.updatedAt = new Date('2026-08-20T00:00:00Z');
    b.status.stage = 'AWAITING_FOLLOWUP';
    b.status.updatedAt = new Date('2026-09-09T00:00:00Z');
    const rep = await s.extras.silenceReport('u2', t.project.id, 7, now);
    expect(rep.waiting.map((w: any) => w.displayName)).toEqual(['Иван']);
    expect(rep.overduePromises.map((p: any) => p.id)).toEqual([promise.id]);
    expect(rep.frame).toMatch(/не KPI сотрудников/);

    const vs = await s.sheets.ensureVacancySheet('u2', t.project.id);
    await expect(s.extras.promiseToCandidate('u2', vs!.id, { description: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('А-9: экспорт для bias-аудита — агрегаты по пунктам и этапам без имён, контактов и признаков; фиксируется в аудите', async () => {
    const s = setup();
    const t = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    const a = seedCandidate(s.prisma, t.project.id, 'u2', 'Иван Иванов');
    const b = seedCandidate(s.prisma, t.project.id, 'u2', 'Пётр Петров');
    const sa = await s.sheets.openForCandidate('u2', a.status.id);
    await s.sheets.openForCandidate('u2', b.status.id);
    const first = s.prisma.rows('termsClause').find((x) => x.sheetId === sa.id && x.side === 'EMPLOYER' && x.kind === 'REQUIREMENT');
    s.prisma.seed('clausePosition', { clauseId: first!.id, bySide: 'CANDIDATE', coverage: 'not_covered', stance: null, evidenceKind: 'TRANSCRIPT_SEGMENT', evidenceRef: 'seg-1', evidenceQuote: 'нет', confirmedAt: new Date() });

    const exp = await s.extras.biasExport('u2', t.project.id);
    expect(exp.candidates).toBe(2);
    expect(exp.stages).toEqual([{ stage: 'SCHEDULED', count: 2 }]);
    const b2b = exp.clauses.find((c: any) => c.text === 'Опыт B2B-продаж?');
    expect(b2b).toMatchObject({ total: 2, not_covered: 1, unknown: 1, covered: 0, byStage: { SCHEDULED: 2 } });
    expect(JSON.stringify(exp)).not.toMatch(/Иванов|Петров/);
    expect(exp.excluded).toContain('защищённые признаки');
    expect(s.audit.records.some((r) => r.action === 'bias_export.generated' && r.resourceId === t.project.id)).toBe(true);
  });

  it('А-10: кандидат, уже рассмотренный в другом проекте, добавляется только с повторным подтверждением согласия; отозванное согласие → 403; чужой профиль → 404', async () => {
    const s = setup();
    const t1 = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    const t2 = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    const a = seedCandidate(s.prisma, t1.project.id, 'u2', 'Иван');
    await expect(s.extras.addExistingCandidateToProject('u2', t2.project.id, { candidateProfileId: a.profile.id, candidateConsentReconfirmed: false })).rejects.toBeInstanceOf(ForbiddenException);
    const st = await s.extras.addExistingCandidateToProject('u2', t2.project.id, { candidateProfileId: a.profile.id, candidateConsentReconfirmed: true });
    expect(st).toMatchObject({ projectId: t2.project.id, candidateProfileId: a.profile.id });
    // идемпотентно
    expect((await s.extras.addExistingCandidateToProject('u2', t2.project.id, { candidateProfileId: a.profile.id, candidateConsentReconfirmed: false })).id).toBe(st.id);
    expect(s.audit.records.filter((r) => r.action === 'candidate.added_to_project')).toHaveLength(1);

    // ── Пункт [same-answer-either-way] 2026-09-24 ──
    //
    // Замысел метода идемпотентен и записан в нём своими словами
    // (`if (existing) return existing`). Но между тем чтением и вставкой
    // проходит время: двойное нажатие, повтор при плохой связи, две
    // вкладки. Второй вызов проскакивал проверку, упирался в
    // `@@unique([projectId, candidateProfileId])` и человек получал
    // ПЯТИСОТКУ на действии, которое уже удалось.
    //
    // Гонка воспроизводится честно: строка появляется ПОСЛЕ того, как
    // метод прочитал, что её нет, — ровно порядок, дающий дефект.
    const b = seedCandidate(s.prisma, t1.project.id, 'u2', 'Пётр');
    // Перехват ставится через `defineProperty`, а НЕ присваиванием поля.
    // Фейковая Prisma — Proxy, который собирает делегат модели заново на
    // КАЖДОМ обращении: `s.prisma.candidatePipelineStatus.findFirst = …`
    // молча выбрасывается, и тест про гонку не проверял бы ничего,
    // выглядя при этом рабочим. Отдельно отмечено, потому что это
    // ровно та форма изъяна, которую сверки ищут в продукте, — проверка,
    // которая выглядит существующей.
    const делегат = s.prisma.candidatePipelineStatus;
    let первыйРаз = true;
    Object.defineProperty(s.prisma, 'candidatePipelineStatus', {
      configurable: true,
      value: {
        ...делегат,
        findFirst: async (args: any) => {
          const res = await делегат.findFirst(args);
          if (первыйРаз && !res && args?.where?.candidateProfileId === b.profile.id) {
            первыйРаз = false;
            // конкурент успел записать между чтением и вставкой
            const гонка = s.prisma.seed('candidatePipelineStatus', { projectId: t2.project.id, candidateProfileId: b.profile.id });
            гонка.stage = 'INTERVIEWED';
          }
          return res;
        },
      },
    });
    const race = await s.extras.addExistingCandidateToProject('u2', t2.project.id, { candidateProfileId: b.profile.id, candidateConsentReconfirmed: true });
    delete (s.prisma as any).candidatePipelineStatus;
    // Перехват действительно сработал — иначе гонки не было и тест пуст.
    expect(первыйРаз).toBe(false);

    // Ответ один и тот же, кто бы ни успел раньше: строка возвращается,
    // а не «внутренняя ошибка сервера».
    expect(race.candidateProfileId).toBe(b.profile.id);
    // Дубля нет.
    expect(s.prisma.rows('candidatePipelineStatus').filter((x: any) => x.projectId === t2.project.id && x.candidateProfileId === b.profile.id)).toHaveLength(1);
    // И пустой `update` не сбросил этап, до которого кандидат уже дошёл.
    expect(race.stage).toBe('INTERVIEWED');

    const revoked = s.prisma.seed('candidateProfile', { ownerUserId: 'u2', displayName: 'X', consentRevokedAt: new Date() });
    await expect(s.extras.addExistingCandidateToProject('u2', t2.project.id, { candidateProfileId: revoked.id, candidateConsentReconfirmed: true })).rejects.toBeInstanceOf(ForbiddenException);
    /** КЛЮЧЕВОЙ ТЕСТ [revocation-not-one-rule] 2026-09-06 — текст
     * отказа. Здесь стояло своё короткое сообщение «Согласие кандидата
     * отозвано», без главного: что отчёты по кандидату не формируются и
     * что снять отзыв может ТОЛЬКО САМ КАНДИДАТ. Рекрутер, прочитавший
     * короткую версию, идёт просить коллегу добавить кандидата соседней
     * кнопкой — текст не просто беднее, он ведёт не туда. Проверяется
     * поведением, а не наличием вызова в исходнике. */
    await expect(
      s.extras.addExistingCandidateToProject('u2', t2.project.id, { candidateProfileId: revoked.id, candidateConsentReconfirmed: true }),
    ).rejects.toThrow(CONSENT_REVOKED_MESSAGE);
    const foreign = s.prisma.seed('candidateProfile', { ownerUserId: 'other', displayName: 'Y' });
    await expect(s.extras.addExistingCandidateToProject('u2', t2.project.id, { candidateProfileId: foreign.id, candidateConsentReconfirmed: true })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('HiringExtrasService — Р-8 / Р-10 / Р-12 / Р-14 (работодатель)', () => {
  it('Р-8: слияние двух статусов одного человека — позиции переносятся на общий лист с пометкой источника, второй статус удаляется; у агентства → 400', async () => {
    const s = setup();
    const t = seedTeamProject(s.prisma, 'u3', 'EMPLOYER_HIRING');
    const profile = s.prisma.seed('candidateProfile', { ownerUserId: 'u3', displayName: 'Иван' });
    const direct = s.prisma.seed('candidatePipelineStatus', { projectId: t.project.id, candidateProfileId: profile.id, stage: 'SCHEDULED' });
    const viaAgency = s.prisma.seed('candidatePipelineStatus', { projectId: t.project.id, candidateProfileId: profile.id, stage: 'SCHEDULED' });
    const sheetAgency = await s.sheets.openForCandidate('u3', viaAgency.id);
    const clause = s.prisma.rows('termsClause').find((x) => x.sheetId === sheetAgency.id && x.side === 'EMPLOYER' && x.kind === 'REQUIREMENT');
    s.prisma.seed('clausePosition', { clauseId: clause!.id, bySide: 'CANDIDATE', coverage: 'covered', stance: null, note: 'из отчёта агентства', evidenceKind: 'CLIENT_BRIEF', evidenceRef: 'rep-1', evidenceQuote: 'три года', confirmedAt: new Date() });

    const res = await s.extras.mergeCandidates('u3', t.project.id, { keepStatusId: direct.id, mergeStatusId: viaAgency.id });
    expect(res.positionsMoved).toBe(1);
    expect(s.prisma.rows('candidatePipelineStatus').map((x) => x.id)).toEqual([direct.id]);
    const keepSheet = s.prisma.rows('termsSheet').find((x) => x.pipelineStatusId === direct.id);
    const moved = s.prisma.rows('clausePosition').filter((p) => s.prisma.rows('termsClause').some((c) => c.id === p.clauseId && c.sheetId === keepSheet!.id));
    expect(moved).toHaveLength(1);
    expect(moved[0].note).toBe('[источник: агентство] из отчёта агентства');
    expect(moved[0]).toMatchObject({ evidenceQuote: 'три года', evidenceRef: 'rep-1' });
    expect(res.frame).toMatch(/«кто прав» не решается/);
    await expect(s.extras.mergeCandidates('u3', t.project.id, { keepStatusId: direct.id, mergeStatusId: direct.id })).rejects.toBeInstanceOf(NotFoundException);

    const ag = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    await expect(s.extras.mergeCandidates('u2', ag.project.id, { keepStatusId: 'a', mergeStatusId: 'b' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('КЛЮЧЕВОЙ ТЕСТ [one-of-several-spoke-for-all]: две компании в проекте — продукт не подписывается одной из них наугад', async () => {
    // Подпись письма и подпись AI-уведомления — утверждения о том, КТО
    // пишет кандидату и кто обрабатывает его данные. Раньше бралось
    // `findFirst` без порядка: досье выбиралось произвольно.
    const s = setup();
    const t = seedTeamProject(s.prisma, 'u3', 'EMPLOYER_HIRING');
    s.prisma.seed('employerDossier', { projectId: t.project.id, legalName: 'ТОВ Ромашка', registryCode: '111', jurisdiction: 'UA' });
    s.prisma.seed('employerDossier', { projectId: t.project.id, legalName: 'ТОВ Василёк', registryCode: '222', jurisdiction: 'UA' });
    const a = seedCandidate(s.prisma, t.project.id, 'u3', 'Иван');
    const sa = await s.sheets.openForCandidate('u3', a.status.id);

    // Письмо составляется, но подпись не подставлена, и об этом сказано.
    const letter = await s.extras.statusLetter('u3', sa.id, 'waiting');
    expect(letter.text).not.toContain('ТОВ Ромашка');
    expect(letter.text).not.toContain('ТОВ Василёк');
    expect(letter.text).toContain('Команда найма');
    expect(letter.frame).toContain('ТОВ Василёк');
    expect(letter.frame).toContain('ТОВ Ромашка');

    // Уведомление о применении AI — отказ, а не подпись наугад.
    await expect(s.extras.aiNotice('u3', t.project.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ОБРАТНАЯ ПРОБА [one-of-several-spoke-for-all]: одна компания — подпись на месте, уведомление выдаётся', async () => {
    // Без неё тест выше проходил бы и в мире, где подпись сломана
    // вовсе, а уведомление не выдаётся никогда.
    const s = setup();
    const t = seedTeamProject(s.prisma, 'u3', 'EMPLOYER_HIRING');
    s.prisma.seed('employerDossier', { projectId: t.project.id, legalName: 'ТОВ Ромашка', registryCode: '111', jurisdiction: 'UA' });
    const a = seedCandidate(s.prisma, t.project.id, 'u3', 'Иван');
    const sa = await s.sheets.openForCandidate('u3', a.status.id);

    const letter = await s.extras.statusLetter('u3', sa.id, 'waiting');
    expect(letter.text).toContain('ТОВ Ромашка');
    expect(letter.frame).not.toContain('несколько компаний');

    const notice = await s.extras.aiNotice('u3', t.project.id);
    expect(notice.text).toContain('ТОВ Ромашка');
  });

  it('Р-10: письмо-статус — из пройденных этапов и открытых пунктов, без оценок; «отправлено» пишется в аудит; Р-14: закрытие показывает, кому не ответили, открытые обещания, активные engagement и share', async () => {
    const s = setup();
    const t = seedTeamProject(s.prisma, 'u3', 'EMPLOYER_HIRING');
    s.prisma.seed('employerDossier', { projectId: t.project.id, legalName: 'ТОВ Ромашка', jurisdiction: 'UA' });
    const a = seedCandidate(s.prisma, t.project.id, 'u3', 'Иван');
    const b = seedCandidate(s.prisma, t.project.id, 'u3', 'Пётр');
    const stage = s.prisma.seed('interviewStageDefinition', { configId: t.config.id, name: 'Знакомство', orderIndex: 0 });
    s.prisma.seed('candidateStageProgress', { statusId: a.status.id, stageDefinitionId: stage.id, completedAt: new Date() });
    const sa = await s.sheets.openForCandidate('u3', a.status.id);

    const waiting = await s.extras.statusLetter('u3', sa.id, 'waiting');
    expect(waiting.text).toContain('Здравствуйте, Иван!');
    expect(waiting.text).toContain('Вы прошли этапы: Знакомство.');
    expect(waiting.text).toContain('открытыми остаются вопросы: Опыт B2B-продаж?; Английский B2?');
    expect(waiting.text).toContain('ТОВ Ромашка');
    expect(waiting.text).not.toMatch(/балл|оценк|лучше|хуже/i);
    expect(waiting.reviewRequired).toBe(true);
    const declined = await s.extras.statusLetter('u3', sa.id, 'declined');
    expect(declined.text).toContain('Мы решили не продолжать');
    expect(declined.text).not.toContain('открытыми остаются');

    s.prisma.seed('commitment', { projectId: t.project.id, candidateProfileId: b.profile.id, owner: 'USER', description: 'Позвонить', status: 'IN_PROGRESS' });
    // Пункт [term-never-ends] 2026-09-06: срока у фикстуры не было, и
    // чеклист закрытия это устраивало — он называл заказ «активным» по
    // одному лишь `status`. Теперь срок обязателен и у данных.
    s.prisma.seed('employerAgencyEngagement', { employerProjectId: t.project.id, status: 'ACTIVE', token: 'tok', sharedItems: [], expiresAt: new Date(Date.now() + 30 * 86_400_000) });
    const before = await s.extras.closingChecklist('u3', t.project.id);
    expect(before.candidatesAnswerNotMarked.map((x: any) => x.displayName).sort()).toEqual(['Иван', 'Пётр']);
    expect(before.openCommitments).toHaveLength(1);
    expect(before.activeEngagements).toHaveLength(1);
    // ── Пункт [term-never-ends] 2026-09-06 ──
    //
    // Чеклист называл «активными» заказы по одному лишь `status` —
    // определение слабее того, что об активности думает сам
    // EngagementService. Человеку это не лишняя строка, а просьба
    // развязать то, что развязалось само.
    const заказ = s.prisma.rows('employerAgencyEngagement')[0];
    const былСрок = заказ.expiresAt;
    заказ.expiresAt = new Date(Date.now() - 1000);
    expect((await s.extras.closingChecklist('u3', t.project.id)).activeEngagements).toHaveLength(0);
    заказ.expiresAt = былСрок;
    // То же и о шерингах — второе ослабленное определение в том же
    // списке: они считались активными по одному лишь `revokedAt`.
    s.prisma.seed('candidateShare', {
      acceptedIntoMode: 'EMPLOYER_HIRING',
      revokedAt: null,
      createdCandidateProfileId: b.profile.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect((await s.extras.closingChecklist('u3', t.project.id)).activeShares).toHaveLength(1);
    s.prisma.rows('candidateShare')[0].expiresAt = new Date(Date.now() - 1000);
    expect((await s.extras.closingChecklist('u3', t.project.id)).activeShares).toHaveLength(0);


    // ── Пункт [log-says-we-saw-it] 2026-09-24 ──
    //
    // Продукт письмо НЕ отправляет — рамка самого письма это и говорит:
    // «отправляет человек». Запись называлась `status_letter.sent`, то
    // есть утверждала отправку, а получена была из нажатия кнопки. И
    // читалась обратно КАК ФАКТ: этот самый чеклист собирал из неё
    // «кому ответили», а экран под пустым списком писал «Всем ответили.»
    await expect(s.extras.markStatusLetterSent('u3', sa.id, { recruiterSentIt: false })).rejects.toBeInstanceOf(BadRequestException);
    const marked = await s.extras.markStatusLetterSent('u3', sa.id, { recruiterSentIt: true });
    expect(marked.selfReported).toBe(true);
    expect(marked.note).toMatch(/с ваших слов/);
    // Имя действия говорит, с чьих слов запись.
    expect(s.audit.records.some((r) => r.action === 'status_letter.marked_sent_by_recruiter' && r.resourceId === sa.id)).toBe(true);
    expect(s.audit.records.some((r) => r.action === 'status_letter.sent')).toBe(false);

    const after = await s.extras.closingChecklist('u3', t.project.id);
    expect(after.candidatesAnswerNotMarked.map((x: any) => x.displayName)).toEqual(['Пётр']);
    expect(after.frame).toMatch(/автоматических писем и отзывов нет/);
    expect(after.frame).toMatch(/с ваших слов/);

    // Прежнее имя ЧИТАЕТСЯ: строки за ним в журнале уже есть, и делать
    // вид, что истории нет, — та же неправда, только в другую сторону.
    const b2 = seedCandidate(s.prisma, t.project.id, 'u3', 'Третий');
    const sb2 = s.prisma.seed('termsSheet', { projectId: t.project.id, kind: 'INTERVIEW', pipelineStatusId: b2.status.id, title: 'Третий', status: 'DRAFT' });
    expect((await s.extras.closingChecklist('u3', t.project.id)).candidatesAnswerNotMarked.map((x: any) => x.displayName).sort()).toEqual(['Пётр', 'Третий']);
    s.prisma.seed('auditLogEntry', { action: 'status_letter.sent', resource: 'TermsSheet', resourceId: sb2.id });
    expect((await s.extras.closingChecklist('u3', t.project.id)).candidatesAnswerNotMarked.map((x: any) => x.displayName)).toEqual(['Пётр']);

    const ag = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    await expect(s.extras.closingChecklist('u2', ag.project.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('Р-12: уведомление об AI подписывается реквизитами компании и версией; без компании → 400; показ фиксируется в аудите с версией; у агентства → 400', async () => {
    const s = setup();
    const t = seedTeamProject(s.prisma, 'u3', 'EMPLOYER_HIRING');
    await expect(s.extras.aiNotice('u3', t.project.id)).rejects.toThrow(/Укажите компанию/);
    s.prisma.seed('employerDossier', { projectId: t.project.id, legalName: 'ТОВ Ромашка', registryCode: '12345678', domain: 'romashka.ua', jurisdiction: 'UA' });
    const n = await s.extras.aiNotice('u3', t.project.id);
    expect(n.version).toBe(AI_NOTICE_VERSION);
    expect(n.text).toContain('ТОВ Ромашка, код 12345678, romashka.ua уведомляет');
    expect(n.text).toMatch(/Решения о найме принимают люди; автоматических отказов и ранжирования нет/);
    expect(n.consents.map((c: any) => c.key)).toEqual(['ai_notice', 'transfer']);

    const a = seedCandidate(s.prisma, t.project.id, 'u3', 'Иван');
    await expect(s.extras.recordAiNoticeShown('u3', t.project.id, 'нет', { noticeShownToCandidate: true })).rejects.toBeInstanceOf(NotFoundException);
    // ── Пункт [log-says-we-saw-it] 2026-09-24 ──
    //
    // Из шестнадцати записей журнала эта самая дорогая: именно ею
    // доказывают, что кандидата предупредили об AI. Показывает человек,
    // на своём экране, вне продукта — а запись называлась
    // `ai_notice.shown`, то есть утверждала показ.
    await expect(s.extras.recordAiNoticeShown('u3', t.project.id, a.profile.id, { noticeShownToCandidate: false })).rejects.toBeInstanceOf(BadRequestException);
    const shown = await s.extras.recordAiNoticeShown('u3', t.project.id, a.profile.id, { noticeShownToCandidate: true });
    expect(shown).toMatchObject({ ok: true, version: AI_NOTICE_VERSION, selfReported: true });
    expect(shown.note).toMatch(/с ваших слов/);
    expect(s.audit.records.find((r) => r.action === 'ai_notice.marked_shown_by_recruiter')).toMatchObject({ resourceId: a.profile.id, after: { version: AI_NOTICE_VERSION, projectId: t.project.id, selfReported: true } });
    expect(s.audit.records.some((r) => r.action === 'ai_notice.shown')).toBe(false);

    const ag = seedTeamProject(s.prisma, 'u2', 'INTERVIEW_POOL');
    await expect(s.extras.aiNotice('u2', ag.project.id)).rejects.toBeInstanceOf(BadRequestException);
  });
});

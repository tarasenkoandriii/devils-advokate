// Пункт [job-domain-v2] — остальные функции этапа 2 парами (§9.1, §12):
// К-2/А-8 (репетиция и дебриф → позиции из собственных слов), К-4 (зарплата
// по своим границам), К-6 (live-подсказки для соискателя), К-9/А-5 (тестовое
// задание по пунктам), К-10 (прогноз → факт → урок), А-2 (преданкета по
// ссылке — текстом), А-3 (матрица покрытия), А-7 (кому обещали и молчим),
// А-9 (данные для bias-аудита), А-10 (проектная видимость кандидатов), Р-8
// (единый лист через агентство и напрямую), Р-10 (письмо-статус), Р-12
// (уведомление об AI от имени компании), Р-14 (закрытие вакансии).
//
// Все они стоят на ядре: позиции с опорой, редакции, лист — и ни одна не
// вводит число по человеку. Мнение интервьюера (А-8) маркируется
// INTERVIEWER_DEBRIEF и не смешивается с фактами транскрипта; защищённые
// признаки в дебрифе → ComplianceFlag, не позиция. К-6 — только незакрытые
// пункты своего листа: никакого детектора манипуляций собеседника.

import { assertConsentActive, consentRevoked, revokeConsentCascade, CONSENT_REVOKED_ROW_NOTE } from '../interview-pool/consent-revocation';
import { AUDIT_AI_NOTICE_MARKED_SHOWN, AUDIT_STATUS_LETTER_ANY, AUDIT_STATUS_LETTER_MARKED_SENT } from '../common/audit-claim';
import { NotChecked } from '../common/not-checked';
import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CandidateStage,
  ClauseCoverage,
  ClauseStance,
  CommitmentOwner,
  CommitmentStatus,
  ConversationProcessingStatus,
  ConversationSourceType,
  EvidenceKind,
  LiveHintType,
  ProjectMode,
  SparringMessageRole,
  TermsClauseKind,
  TermsSheetKind,
  TermsSide,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { assertCounterpartyProjectNotFrozen } from '../project-freeze/assert-not-frozen';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService, TERMS_PROHIBITIONS, quoteIsFromSource } from '../terms-sheet/terms-matching.service';
import { keepQuoted } from '../common/kept-with-quote';
import { assertHiringProjectAccess } from '../terms-sheet/terms-access';
import { TEAM_MODES } from '../interview-pool/interview-pool-access';
import { BRIEF_COMPLIANCE_PROMPT } from '../client-brief/client-brief.service';
import { buildStartDeepLink } from '../common/telegram-deep-link';
import { takeSource, promptIntakeNote, AI_PROMPT_CHARS, type SourceIntake } from '../common/source-intake';
import { dossierForProject, manyCompaniesMessage } from '../employer-dossier/single-dossier';
import { revocationAlsoDone, revocationDoesNotUndo } from '../interview-pool/revocation-report';

export const SALARY_SCENARIOS_TASK_TYPE = 'terms-salary-scenarios';
export const SHEET_LIVE_HINT_TASK_TYPE = 'terms-live-hint';
export const DEBRIEF_COMPLIANCE_TASK_TYPE = 'interviewer-debrief-compliance';
export const PRE_QUESTIONNAIRE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Сколько текстов потерянных при слиянии пунктов показать человеку.
 * Не весь список: слияние может задеть десятки пунктов, а сообщение
 * должно читаться. Число потерянных при этом называется точно — усечён
 * только показ примеров, и об усечении сказано. */
export const MERGE_DROPPED_SAMPLE = 5;

/** Что отзыв согласия кандидатом делает и чего НЕ делает.
 *
 * Пункт [candidate-rights] 2026-09-04. Тот же приём, что у отзыва
 * согласий в кабинете владельца (`consent-revocation-effects.ts`):
 * «отозвано» без перечня последствий человек достраивает в свою пользу и
 * решает, что стёрлось всё. Здесь не стирается ничего из того, что уже
 * прочитал человек: ответы стали репликами разговора, а часть рекрутер
 * мог подтвердить как позиции по пунктам — это его рабочие записи, а не
 * наша запись о кандидате. Обещать обратное было бы неправдой, а
 * неправда в тексте о правах хуже отсутствия текста. */
export const CANDIDATE_REVOCATION_EFFECTS = {
  // Пункт [copy-outlived-consent] 2026-09-24: прежний текст обещал
  // ровно то, что маршрут делал, — профиль и ссылки. А про КОПИИ, уже
  // принятые другой стороной, не говорил ничего, и они действительно
  // оставались в работе. Теперь копии гасятся, и текст это называет:
  // для человека «ссылку закрыли» и «у того, кто её открыл, данные
  // больше не в работе» — разные новости, и вторая ему важнее.
  alsoDone:
    'Ваш профиль у получателя помечен как отозванный, ссылки, которыми он мог передать его дальше, закрыты, и копии, которые уже успели принять по этим ссылкам, помечены отозванными тоже — по ним тоже ничего не формируется.',
  doesNotUndo:
    'Ответы, которые вы уже отправили, у получателя останутся: их прочитал человек, и часть могла попасть в его рабочие записи. Отзыв запрещает дальнейшую обработку, но не стирает прочитанное. Полное удаление — по запросу тому, кто прислал ссылку.',
} as const;
export const AI_NOTICE_VERSION = 'v1-2026-09-02';
export const TEST_ASSIGNMENT_CATEGORY = 'тестовое задание';

export const SALARY_SCENARIOS_PROMPT =
  'Тебе даны границы переговоров СОИСКАТЕЛЯ (идеальный исход, приемлемый, BATNA, WATNA, точка отказа) и условия оффера по оплате. ' +
  'Опиши три сценария — принять / встречное предложение / отказаться — с последствиями, сформулированными ТОЛЬКО из его собственных границ, и короткий скрипт разговора его словами для встречного предложения. ' +
  'ЗАПРЕЩЕНО: называть «рыночную» зарплату (у продукта нет рынка), предсказывать реакцию работодателя числом или вероятностью, давать вердикт, что выбрать. ' +
  TERMS_PROHIBITIONS +
  ' Ответь СТРОГО валидным JSON вида {"scenarios": [{"kind": "accept"|"counter"|"decline", "consequences": string, "script": string|null}]}.';

export const SHEET_LIVE_HINT_PROMPT =
  'Тебе дан фрагмент живого транскрипта собеседования и список ЕЩЁ НЕ ОБСУЖДЁННЫХ пунктов листа условий соискателя (с индексами). ' +
  'Если по фрагменту видно уместный момент напомнить об одном пункте («пункт X ещё не обсуждён», «вам обещали Y — уточните срок») — верни его индекс и одну короткую подсказку соискателю. Если момента нет — null. ' +
  'ЗАПРЕЩЕНО: любые оценки собеседника, «детекция манипуляций», советы давить. ' +
  TERMS_PROHIBITIONS +
  ' Ответь СТРОГО валидным JSON: {"suggestedClauseIndex": number, "hintText": string} или null.';

const json = (check: (p: any) => boolean) => (t: string) => {
  try {
    return check(JSON.parse(t));
  } catch {
    return false;
  }
};

@Injectable()
export class HiringExtrasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
    private readonly audit: AuditLogService,
    private readonly sheets: TermsSheetService,
    private readonly matching: TermsMatchingService,
  ) {}

  /** Пункт [input-truncated] 2026-09-05: здесь стоял голый
   * `userPrompt.slice(0, 24_000)`. Тяжелее всего это било по проверке
   * дебрифа: экран под пустым списком пишет утвердительно
   * «Compliance-флагов нет», и это утверждение обо ВСЁМ тексте,
   * сделанное по его началу. Теперь усечение возвращается наружу
   * вместе с ответом, и модели о нём сказано. */
  private async ai(userId: string, projectId: string, taskType: string, systemPrompt: string, userPrompt: string, validate: (t: string) => boolean, maxTokens: number, fail: string): Promise<{ text: string; intake: SourceIntake }> {
    const { text: prompt, intake } = takeSource(userPrompt, AI_PROMPT_CHARS);
    try {
      return { text: (await this.aiRouter.execute({ userId, projectId, taskType, systemPrompt, userPrompt: `${prompt}${promptIntakeNote(intake)}`, jsonMode: true, maxTokens, validateOutput: validate })).text, intake };
    } catch (err) {
      rethrowClientVisibleAiError(err);
      if (err instanceof AIRouterContentBlockedError) throw new BadRequestException(`${fail}: отклонено проверкой безопасности содержимого.`);
      throw new BadGatewayException(`${fail} — AI-провайдер недоступен или вернул некорректный ответ.`);
    }
  }

  // ── К-2: репетиция по листу — позиции из собственных реплик спарринга ──

  async positionsFromRehearsal(userId: string, sheetId: string, sparringSessionId: string) {
    const { sheet } = await this.sheets.assertSheetAccess(userId, sheetId);
    if (sheet.kind !== TermsSheetKind.VACANCY_RESPONSE) throw new BadRequestException('Репетиция по листу — для листа соискателя');
    const session = await this.prisma.sparringSession.findFirst({ where: { id: sparringSessionId, projectId: sheet.projectId }, include: { messages: { where: { role: SparringMessageRole.USER }, orderBy: { createdAt: 'asc' } } } });
    if (!session) throw new NotFoundException(`SparringSession ${sparringSessionId} not found`);
    if (session.messages.length === 0) throw new BadRequestException('В репетиции нет реплик соискателя');
    // только СВОИ реплики — реплики AI-интервьюера позициями не становятся никогда
    const text = session.messages.map((m) => m.text).join('\n');
    const { created: positions, skipped } = await this.matching.proposePositions({
      userId,
      projectId: sheet.projectId,
      sheetId,
      bySide: TermsSide.CANDIDATE,
      input: { text, evidenceKind: EvidenceKind.USER_STATED, evidenceRef: session.id },
      scenario: 'rehearsal-positions',
      clauseFilter: (c) => c.side === TermsSide.EMPLOYER,
    });
    const clauses = await this.sheets.loadClauses(sheetId);
    const employer = clauses.filter((c) => c.side === TermsSide.EMPLOYER && c.confirmedAt && !c.rejectedAt);
    const touched = new Set(positions.map((p) => p.clauseId));
    // [draft-outcome] 2026-09-04: тут «пункт не закрыт вашими словами» и
    // «мы не смогли разобрать ответ модели про этот пункт» попадали в
    // один и тот же список `floating` — то есть недоработка разбора
    // выглядела как факт о человеке.
    return {
      draftSkips: skipped,
      proposedPositions: positions,
      closedByWords: employer.filter((c) => touched.has(c.id)).map((c) => c.text),
      floating: employer.filter((c) => !touched.has(c.id) && (c.current.CANDIDATE?.coverage ?? 'unknown') !== ClauseCoverage.covered).map((c) => c.text),
      frame: 'Позиции — только из ваших слов; «правильных ответов» здесь нет',
    };
  }

  // ── А-8: дебриф интервьюера ──

  async debrief(userId: string, sheetId: string, text: string) {
    const { sheet, project } = await this.sheets.assertSheetAccess(userId, sheetId);
    if (sheet.kind !== TermsSheetKind.INTERVIEW || !TEAM_MODES.has(project.mode)) throw new BadRequestException('Дебриф — по листу кандидата у агентства или работодателя');
    if (!text?.trim()) throw new BadRequestException('Текст дебрифа пуст');
    const { created: positions, skipped: draftSkips } = await this.matching.proposePositions({
      userId,
      projectId: sheet.projectId,
      sheetId,
      bySide: TermsSide.CANDIDATE,
      input: { text, evidenceKind: EvidenceKind.INTERVIEWER_DEBRIEF, evidenceRef: null },
      scenario: 'interviewer-debrief',
      clauseFilter: (c) => c.side === TermsSide.EMPLOYER,
    });
    // защищённые признаки в дебрифе → ComplianceFlag, не позиция
    const config = await this.prisma.interviewPoolConfig.findUnique({ where: { projectId: sheet.projectId } });
    let flags: Array<{ category: string; quotedText: string }> = [];
    // [dropped-quotes] 2026-09-04: экран показывает «compliance-флагов: N»
    // и при нуле не показывает НИЧЕГО — то есть отброшенный флаг о
    // защищённом признаке в дебрифе исчезал совсем. Здесь цена ошибки
    // выше обычной: речь о признаке, по которому нельзя отбирать.
    let skippedWithoutQuote = 0;
    // [input-truncated] 2026-09-05: под пустым списком экран пишет
    // «Compliance-флагов нет». Если проверен не весь дебриф, это
    // утверждение обо всём тексте по его началу — и речь о признаках,
    // по которым нельзя отбирать.
    let complianceIntake: SourceIntake | null = null;
    // [not-checked-looks-clean] 2026-09-06: два случая выше закрыты —
    // отброшенная без цитаты находка и непрочитанный хвост текста. Третий
    // оставался открытым и он крупнее обоих: ПРОВЕРКА МОГЛА НЕ ВЫПОЛНИТЬСЯ
    // ВООБЩЕ. Конфига у проекта нет — ветка молча пропускалась; вызов упал
    // — `catch` глотал всё, кроме отказа по согласию. В обоих случаях
    // наружу уходило `complianceFlags: 0`, неотличимое от «проверили,
    // спорного нет». Это та же проверка о защищённых признаках, чью
    // высокую цену признаёт комментарий пятнадцатью строками выше.
    //
    // ТАК ЖЕ СДЕЛАНО У СОСЕДЕЙ, И ИМЕННО ЭТО БЫЛО РАСХОЖДЕНИЕМ: тот же
    // compliance-разбор брифа (`client-brief.service.ts`) и текста вакансии
    // (`vacancy-posting.service.ts`) при сбое AI БРОСАЮТ BadGateway — там
    // человек узнаёт. Здесь — не узнавал. Бросать в дебрифе нельзя:
    // черновики позиций уже созданы, ронять ответ из-за не удавшейся
    // побочной проверки значит потерять сделанную работу. Поэтому не
    // бросаем, а СООБЩАЕМ — то же решение, что принято в [delete-says-done].
    let complianceNotChecked: NotChecked = null;
    if (!config) {
      complianceNotChecked = 'not-configured';
    } else {
      try {
        const out = await this.ai(userId, sheet.projectId, DEBRIEF_COMPLIANCE_TASK_TYPE, BRIEF_COMPLIANCE_PROMPT, text, json((p) => Array.isArray(p?.flags)), 800, 'Не удалось проверить дебриф');
        complianceIntake = out.intake;
        const picked = keepQuoted(
          (JSON.parse(out.text) as { flags: Array<{ category: string; quotedText: string; alternativeText: string }> }).flags,
          (f) => quoteIsFromSource(f.quotedText, text),
        );
        flags = picked.kept;
        skippedWithoutQuote = picked.skippedWithoutQuote;
        for (const f of flags) {
          await this.prisma.complianceFlag.create({ data: { configId: config.id, category: `debrief:${f.category}`.slice(0, 120), quotedText: f.quotedText.slice(0, 1000) } });
        }
      } catch (err) {
        if (err instanceof ForbiddenException) throw err;
        complianceNotChecked = 'provider-failed';
      }
    }
    return { proposedPositions: positions, marker: 'мнение интервьюера', complianceFlags: flags.length, skippedWithoutQuote, draftSkips, complianceIntake, complianceNotChecked };
  }

  // ── К-4: зарплата по своим границам ──

  async salaryScenarios(userId: string, sheetId: string) {
    const { sheet, project } = await this.sheets.assertSheetAccess(userId, sheetId);
    if (project.mode !== ProjectMode.JOB_SEARCH) throw new BadRequestException('Сценарии по границам — для соискателя');
    const boundaries = await this.prisma.negotiationBoundaries.findUnique({ where: { projectId: sheet.projectId } });
    if (!boundaries) throw new BadRequestException('Сначала заполните границы переговоров проекта (идеал / приемлемо / BATNA / точка отказа)');
    const clauses = (await this.sheets.loadClauses(sheetId)).filter((c) => c.confirmedAt && !c.rejectedAt && /оплат|зарплат|salary|компенсац|бонус/i.test(`${c.category ?? ''} ${c.text}`));
    const offered = clauses.map((c) => `- ${c.text}${c.current.EMPLOYER?.evidenceQuote ? ` — «${c.current.EMPLOYER.evidenceQuote}»` : ''}`).join('\n');
    if (!offered) throw new BadRequestException('В листе нет условий по оплате — нечего сверять с границами');
    const out = await this.ai(userId, sheet.projectId, SALARY_SCENARIOS_TASK_TYPE, SALARY_SCENARIOS_PROMPT,
      `Границы соискателя:\nИдеал: ${boundaries.idealOutcome ?? '—'}\nПриемлемо: ${boundaries.acceptableOutcome ?? '—'}\nBATNA: ${boundaries.batna ?? '—'}\nWATNA: ${boundaries.watna ?? '—'}\nТочка отказа: ${boundaries.walkAwayPoint ?? '—'}\n\nУсловия оплаты в листе/оффере:\n${offered}`,
      json((p) => Array.isArray(p?.scenarios) && p.scenarios.every((s: any) => ['accept', 'counter', 'decline'].includes(s?.kind) && typeof s?.consequences === 'string')), 1500, 'Не удалось построить сценарии');
    const scenarios = (JSON.parse(out.text) as { scenarios: Array<{ kind: string; consequences: string; script: string | null }> }).scenarios;
    return { scenarios, intake: out.intake, frame: 'Последствия — из ваших границ; «рыночной» зарплаты и вероятности реакции работодателя здесь нет; OutcomeScenario.confidence не заполняется' };
  }

  // ── К-6: live-подсказки по своему листу ──

  async liveHint(userId: string, sheetId: string, transcriptWindow: string) {
    const { sheet, project } = await this.sheets.assertSheetAccess(userId, sheetId);
    if (!transcriptWindow?.trim()) throw new BadRequestException('transcriptWindow не может быть пустым');
    const already = new Set((await this.prisma.liveHintEvent.findMany({ where: { projectId: sheet.projectId, clauseId: { not: null } }, select: { clauseId: true } })).map((h) => h.clauseId));
    const mySide = project.mode === ProjectMode.JOB_SEARCH ? TermsSide.CANDIDATE : TermsSide.EMPLOYER;
    const open = (await this.sheets.loadClauses(sheetId)).filter((c) => {
      if (!c.confirmedAt || c.rejectedAt || already.has(c.id)) return false;
      const other = mySide === TermsSide.CANDIDATE ? c.current.EMPLOYER : c.current.CANDIDATE;
      return c.side === mySide ? !other || other.coverage === ClauseCoverage.unknown || other.stance === ClauseStance.unknown : (c.current[mySide]?.coverage ?? c.current[mySide]?.stance ?? 'unknown') === 'unknown';
    });
    if (open.length === 0) return null;
    const out = await this.ai(userId, sheet.projectId, SHEET_LIVE_HINT_TASK_TYPE, SHEET_LIVE_HINT_PROMPT,
      `Фрагмент транскрипта:\n${transcriptWindow}\n\nНе обсуждённые пункты:\n${open.map((c, i) => `[${i}] ${c.text}`).join('\n')}`,
      json((p) => p === null || (typeof p?.suggestedClauseIndex === 'number' && typeof p?.hintText === 'string')), 300, 'Не удалось получить подсказку');
    const raw = JSON.parse(out.text) as { suggestedClauseIndex: number; hintText: string } | null;
    if (!raw) return null;
    const clause = open[raw.suggestedClauseIndex];
    return this.prisma.liveHintEvent.create({
      data: { projectId: sheet.projectId, hintType: LiveHintType.UNASKED_QUESTION, hintText: raw.hintText.slice(0, 500), clauseId: clause?.id ?? null },
    });
  }

  // ── К-9 / А-5: тестовое задание по пунктам ──

  async testAssignment(userId: string, sheetId: string, dto: { assignmentText: string; answerText: string }) {
    const { sheet } = await this.sheets.assertSheetAccess(userId, sheetId);
    if (!dto.assignmentText?.trim() || !dto.answerText?.trim()) throw new BadRequestException('Нужны текст задания и текст ответа');
    // требования задания — пункты EMPLOYER/REQUIREMENT (черновики с цитатой из задания)
    const { created: drafts, skipped: draftSkips } = await this.matching.proposeClauses({
      userId,
      projectId: sheet.projectId,
      sheetId,
      side: TermsSide.EMPLOYER,
      text: dto.assignmentText,
      evidenceKind: EvidenceKind.USER_STATED,
      evidenceRef: null,
      scenario: 'test-assignment-requirements',
    });
    const ids = drafts.map((d) => d.id);
    await this.prisma.termsClause.updateMany({ where: { id: { in: ids } }, data: { category: TEST_ASSIGNMENT_CATEGORY, kind: TermsClauseKind.REQUIREMENT, confirmedAt: new Date() } });
    const { created: positions, skipped: answerSkips } = await this.matching.proposePositions({
      userId,
      projectId: sheet.projectId,
      sheetId,
      bySide: TermsSide.CANDIDATE,
      input: { text: dto.answerText, evidenceKind: EvidenceKind.USER_STATED, evidenceRef: null },
      scenario: 'test-assignment-answer',
      clauseFilter: (c) => ids.includes(c.id),
    });
    const byClause = new Map(positions.map((p) => [p.clauseId, p]));
    // [draft-outcome] 2026-09-04: здесь молчание было дороже всего в
    // домене. Требование, чью позицию не удалось разобрать, показывалось
    // как `unknown` — «в ответе не отражено», то есть недоработка разбора
    // выдавалась за суждение о работе кандидата. Два потока потерь
    // разные: не разобрано ЗАДАНИЕ и не разобран ОТВЕТ.
    return {
      draftSkips: { assignment: draftSkips, answer: answerSkips },
      requirements: drafts.map((d) => ({ clauseId: d.id, text: d.text, coverage: byClause.get(d.id)?.coverage ?? 'unknown', quote: byClause.get(d.id)?.evidenceQuote ?? null })),
      frame: 'Отражено / не отражено в ответе — не «правильно / неправильно»; оценку решения делает человек',
    };
  }

  // ── К-10: прогноз → факт → урок (на существующем Prediction) ──

  async createPrediction(userId: string, sheetId: string, predictedOutcome: string) {
    const { sheet, project } = await this.sheets.assertSheetAccess(userId, sheetId);
    if (project.mode !== ProjectMode.JOB_SEARCH) throw new BadRequestException('Прогноз по процессу — для соискателя');
    if (!predictedOutcome?.trim()) throw new BadRequestException('Ожидание не может быть пустым');
    return this.prisma.prediction.create({ data: { projectId: sheet.projectId, predictedOutcome: `[${sheet.title}] ${predictedOutcome.trim()}`.slice(0, 1000) } });
  }

  // ── А-2: преданкета по ссылке — текстом ──

  async createPreQuestionnaire(userId: string, pipelineStatusId: string) {
    const status = await this.prisma.candidatePipelineStatus.findUnique({ where: { id: pipelineStatusId } });
    if (!status) throw new NotFoundException(`CandidatePipelineStatus ${pipelineStatusId} not found`);
    await assertHiringProjectAccess(this.prisma, userId, status.projectId);
    const token = randomBytes(24).toString('base64url');
    const invite = await this.prisma.preQuestionnaireInvite.create({ data: { pipelineStatusId, token, expiresAt: new Date(Date.now() + PRE_QUESTIONNAIRE_TTL_MS) } });
    return { id: invite.id, token, expiresAt: invite.expiresAt, deepLink: buildStartDeepLink(`preq_${token}`) };
  }

  /** Публично: вопросы анкеты + тексты двух согласий. Ничего сверх. */
  async preQuestionnaireForm(token: string) {
    const invite = await this.getInvite(token);
    const config = await this.prisma.interviewPoolConfig.findUnique({ where: { projectId: invite.pipelineStatus.projectId }, include: { questions: { orderBy: { orderIndex: 'asc' } } } });
    // Пункт [one-of-several-spoke-for-all] 2026-09-25: это экран, на
    // котором КАНДИДАТ видит, какая компания его пригласила, — перед
    // тем как отвечать на вопросы. Назвать одну из нескольких наугад
    // значит сказать ему неправду о стороне; не назвать никакой —
    // честное «не указано».
    const inviteDossiers = await this.prisma.employerDossier.findMany({ where: { projectId: invite.pipelineStatus.projectId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 2 });
    const dossier = inviteDossiers.length === 1 ? inviteDossiers[0] : null;
    return {
      jobTitle: config?.jobTitle ?? null,
      company: dossier?.legalName ?? null,
      questions: (config?.questions ?? []).map((q) => ({ id: q.id, text: q.text })),
      consents: {
        aiNotice: 'С вашими ответами будет работать AI-ассистент: он предложит, какие пункты анкеты ответы закрывают; решение принимает человек.',
        // Пункт [candidate-rights] 2026-09-04: было «вы можете ПОПРОСИТЬ
        // отозвать согласие» — а попросить было некого: отзыв
        // существовал только у рекрутера, за авторизацией. Теперь право
        // названо так, как оно работает, и кнопка есть на этом же экране.
        transfer: 'Ваши ответы станут частью вашего профиля у этой компании/агентства в продукте; отозвать согласие можно здесь же, по этой ссылке, в любой момент.',
      },
      answered: !!invite.answeredAt,
      // Состояние отзыва берётся из профиля — того же места, которым
      // пользуется рекрутерский маршрут: отзыв один, кто бы его ни
      // сделал, и второго источника правды здесь заводить нельзя.
      consentRevokedAt: (await this.prisma.candidateProfile.findUnique({ where: { id: invite.pipelineStatus.candidateProfileId }, select: { consentRevokedAt: true } }))?.consentRevokedAt ?? null,
      expiresAt: invite.expiresAt,
    };
  }

  /** Публично: ответы принимаются только с обоими согласиями; → сегменты → черновики позиций. */
  async submitPreQuestionnaire(token: string, dto: { aiNoticeAccepted: boolean; transferConsentAccepted: boolean; answers: Array<{ questionId: string; text: string }> }) {
    const invite = await this.getInvite(token);
    if (invite.answeredAt) throw new BadRequestException('Ответы по этой ссылке уже отправлены');
    if (!dto.aiNoticeAccepted || !dto.transferConsentAccepted) throw new ForbiddenException('Нужны оба согласия — уведомление об AI и передача ответов в профиль');
    const answers = (dto.answers ?? []).filter((a) => a?.text?.trim());
    if (answers.length === 0) throw new BadRequestException('Нет ответов');
    const projectId = invite.pipelineStatus.projectId;
    // Аудит публичных поверхностей 2026-09-03: анкета кандидата пишет в
    // проект рекрутера (разговор, транскрипт, черновики позиций), а сам
    // проект в адресе не назван — только токен. Прошлая сверка заморозки
    // перебирала маршруты С guard'ом и этот контроллер не увидела вовсе:
    // у публичного контроллера guard'а нет по определению. Формулировка
    // нейтральная — кандидат не должен узнавать из отказа, что проект
    // компании в модерации.
    await assertCounterpartyProjectNotFrozen(this.prisma, projectId);
    const questions = await this.prisma.questionnaireItem.findMany({ where: { config: { projectId } }, select: { id: true, text: true } });
    const qText = new Map(questions.map((q) => [q.id, q.text]));

    // Сверка «половины операции» 2026-09-04: разговор, участник,
    // транскрипт, реплики и отметка «ответы получены» писались пятью
    // отдельными вызовами. Сбой посреди оставлял ответы кандидата
    // записанными наполовину при неиспользованной ссылке — кандидат
    // отвечает второй раз, и в проекте рекрутера появляется ВТОРОЙ
    // разговор с теми же ответами. Обе отметки согласия (уведомление об
    // AI и передача ответов) ставятся той же записью: согласие,
    // зафиксированное отдельно от того, на что оно дано, не должно
    // существовать даже мгновение.
    const now = new Date();
    const segments = await this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({ data: { projectId, sourceType: ConversationSourceType.TEXT_IMPORT, status: ConversationProcessingStatus.TRANSCRIBED, occurredAt: new Date() } });
      const participant = await tx.conversationParticipant.create({ data: { conversationId: conversation.id, diarizationLabel: 'CANDIDATE', isSelf: false } });
      const transcript = await tx.transcript.create({ data: { conversationId: conversation.id } });
      const segs: Array<{ id: string; text: string }> = [];
      let ms = 0;
      for (const a of answers) {
        const q = qText.get(a.questionId);
        const seg = await tx.transcriptSegment.create({ data: { transcriptId: transcript.id, participantId: participant.id, text: `${q ? `[${q}] ` : ''}${a.text.trim()}`.slice(0, 4000), startMs: ms, endMs: ms + 1 } });
        ms += 2;
        segs.push({ id: seg.id, text: seg.text });
      }
      await tx.preQuestionnaireInvite.update({ where: { id: invite.id }, data: { aiNoticeAcceptedAt: now, transferConsentAcceptedAt: now, answeredAt: now, conversationId: conversation.id } });
      return segs;
    });

    // черновики позиций — от имени владельца проекта (AI-вызов с его согласиями)
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
    let proposed = 0;
    if (project) {
      try {
        const sheet = await this.sheets.openForCandidate(project.ownerId, invite.pipelineStatusId, { silent: true });
        proposed = (await this.matching.proposePositions({ userId: project.ownerId, projectId, sheetId: sheet.id, bySide: TermsSide.CANDIDATE, input: { segments }, scenario: 'pre-questionnaire' })).created.length;
      } catch (err) {
        if (err instanceof ForbiddenException) proposed = 0; // нет согласия владельца на AI — ответы всё равно сохранены
        else throw err;
      }
    }
    return { ok: true, answers: answers.length, proposedPositions: proposed, note: 'Ответы не оцениваются числом и не сравниваются между кандидатами' };
  }

  private async getInvite(token: string) {
    const invite = await this.prisma.preQuestionnaireInvite.findUnique({ where: { token }, include: { pipelineStatus: true } });
    if (!invite || invite.expiresAt < new Date()) throw new NotFoundException('Ссылка недействительна или просрочена');
    return invite;
  }

  /** Пункт [candidate-rights] 2026-09-04 — отзыв согласия САМИМ кандидатом.
   *
   * Продукт обещал ему это право в тексте согласия («вы можете попросить
   * отозвать согласие») и не давал способа: отзыв существовал только у
   * рекрутера, за авторизацией. Здесь — по тому же токену, что и анкета.
   *
   * ЧТО ОТЗЫВ ДЕЛАЕТ И ЧЕГО НЕ ДЕЛАЕТ — говорится прямо, а не умолчанием.
   * Это тот же приём, что у отзыва согласий в личном кабинете владельца
   * (`consent-revocation-effects.ts`): «отозвано» без перечня последствий
   * человек достраивает в свою пользу и решает, что стёрлось всё. Здесь
   * не стирается ничего из того, что УЖЕ ПРОЧИТАЛ ЧЕЛОВЕК: ответы стали
   * репликами разговора, а часть из них рекрутер мог подтвердить как
   * позиции по пунктам — это его работа, а не наша запись о кандидате.
   * Отзыв ставит отметку, по которой рекрутер обязан прекратить
   * обработку, и гасит ссылку. Обещать больше было бы неправдой. */
  async revokePreQuestionnaireConsent(token: string) {
    const invite = await this.getInvite(token);
    const profileId = invite.pipelineStatus.candidateProfileId;
    const profile = await this.prisma.candidateProfile.findUnique({ where: { id: profileId }, select: { consentRevokedAt: true } });
    if (!profile) throw new NotFoundException('Профиль кандидата не найден');

    // НИКАКОЙ НОВОЙ КОЛОНКИ. Первая версия этой правки заводила отметку
    // на самом приглашении и ручную миграцию к ней — и была лишней:
    // отзыв согласия кандидата в продукте уже есть
    // (`CandidateProfile.consentRevokedAt` плюс гашение живых ссылок),
    // им пользуется рекрутерский маршрут. Не хватало ровно одного —
    // ДОСТУПА К НЕМУ У САМОГО КАНДИДАТА. Переиспользование даёт и полный
    // эффект, и работоспособность сразу, без ожидания миграции.
    if (profile.consentRevokedAt) {
      // Поля те же, что в основной ветке: разные наборы полей у двух
      // выходов одного метода — это способ для читающего решить, что
      // «копий не было», когда на деле их просто не считали.
      // Пункт [the-sentence-did-not-look-at-the-fact] 2026-09-25: даже
      // здесь фраза строится из исхода — повторный отзыв ничего не
      // закрывает, и говорить «закрыто» второй раз значит обещать
      // работу, которой не было.
      {
        const outcome = { sharesRevoked: 0, copiesRevoked: 0, depthExhausted: false };
        return {
          consentRevokedAt: profile.consentRevokedAt,
          alreadyRevoked: true,
          ...outcome,
          alsoDone: 'Согласие было отозвано раньше — сейчас ничего нового не закрывалось.',
          doesNotUndo: revocationDoesNotUndo(outcome, CANDIDATE_REVOCATION_EFFECTS.doesNotUndo),
        };
      }
    }
    const now = new Date();
    // Пункт [copy-outlived-consent] 2026-09-24. Комментарий выше говорит:
    // «отзыв согласия кандидата в продукте уже есть… им пользуется
    // рекрутерский маршрут. Не хватало ровно одного — ДОСТУПА К НЕМУ У
    // САМОГО КАНДИДАТА». Переиспользование было правильным решением, но
    // переиспользована оказалась не функция, а ПОВТОРЁННЫЙ КОД — и
    // вместе с ним изъян: копии, уже принятые другой стороной, не
    // гасились. Из трёх маршрутов отзыва этот — единственный, где
    // действует САМ КАНДИДАТ, то есть тот, где обещание весит больше
    // всего.
    //
    // Третий маршрут, кстати, нашла не пара глаз, а правило сверки:
    // ручной разбор видел два.
    const cascade = await revokeConsentCascade(this.prisma, profileId, now);
    const shares = { count: cascade.sharesRevoked };
    // Журнал ведётся от имени владельца проекта — действие совершил
    // кандидат, у которого нет учётной записи, но след обязан остаться
    // там, где его увидит тот, кого он касается. Действие названо ИНАЧЕ,
    // чем отзыв рекрутером: «кандидат попросил, и я записал» и «кандидат
    // отозвал сам» — разные события, и складывать их нельзя.
    const project = await this.prisma.project.findUnique({ where: { id: invite.pipelineStatus.projectId }, select: { ownerId: true } });
    if (project) {
      await this.audit.record({
        actorId: project.ownerId,
        action: 'candidate_consent.revoked_by_candidate',
        resource: 'CandidateProfile',
        resourceId: profileId,
        after: { viaInviteId: invite.id, sharesRevoked: shares.count, profilesRevoked: cascade.profilesRevoked, depthExhausted: cascade.depthExhausted },
      });
    }
    // Пункт [the-sentence-did-not-look-at-the-fact] 2026-09-25: раньше
    // здесь к посчитанному исходу приклеивалась ФИКСИРОВАННАЯ пара фраз,
    // и при исчерпанной глубине человеку говорили «копии помечены
    // отозванными» о копиях, до которых обход не дошёл.
    const outcome = {
      sharesRevoked: shares.count,
      copiesRevoked: Math.max(0, cascade.profilesRevoked - 1),
      depthExhausted: cascade.depthExhausted,
    };
    return {
      consentRevokedAt: now,
      alreadyRevoked: false,
      ...outcome,
      alsoDone: revocationAlsoDone(outcome),
      doesNotUndo: revocationDoesNotUndo(outcome, CANDIDATE_REVOCATION_EFFECTS.doesNotUndo),
    };
  }

  // ── А-3: матрица покрытия «кандидаты × пункты» ──

  async coverageMatrix(userId: string, projectId: string) {
    const project = await assertHiringProjectAccess(this.prisma, userId, projectId);
    if (!TEAM_MODES.has(project.mode)) throw new BadRequestException('Матрица кандидатов — у агентства и работодателя');
    const vacancy = await this.prisma.termsSheet.findFirst({ where: { projectId, kind: TermsSheetKind.VACANCY } });
    const columns = vacancy ? await this.prisma.termsClause.findMany({ where: { sheetId: vacancy.id, side: TermsSide.EMPLOYER, kind: TermsClauseKind.REQUIREMENT, confirmedAt: { not: null }, rejectedAt: null }, orderBy: { orderIndex: 'asc' } }) : [];
    const sheets = await this.prisma.termsSheet.findMany({ where: { projectId, kind: TermsSheetKind.INTERVIEW }, include: { pipelineStatus: { include: { candidateProfile: { select: { id: true, displayName: true, consentRevokedAt: true } } } } } });
    const rows = [];
    let revokedRows = 0;
    for (const s of sheets) {
      if (!s.pipelineStatus) continue;
      // Пункт [revocation-not-one-rule] 2026-09-06: здесь стоял
      // `continue` по отозванному согласию — кандидат исчезал из
      // матрицы бесследно, без строки и без счётчика. Это прямо
      // нарушало границу, записанную в consent-revocation.ts: «в
      // списке он остаётся с отметкой». Строка остаётся пустой и с
      // объяснением, почему она пустая.
      if (consentRevoked(s.pipelineStatus)) {
        revokedRows++;
        rows.push({
          candidateProfileId: s.pipelineStatus.candidateProfile.id,
          displayName: s.pipelineStatus.candidateProfile.displayName,
          stage: s.pipelineStatus.stage,
          cells: {} as Record<string, { coverage: ClauseCoverage; quote: string | null; evidenceRef: string | null }>,
          openQuestions: [] as string[],
          consentRevoked: true,
          note: CONSENT_REVOKED_ROW_NOTE,
        });
        continue;
      }
      const clauses = await this.sheets.loadClauses(s.id);
      const cells: Record<string, { coverage: ClauseCoverage; quote: string | null; evidenceRef: string | null }> = {};
      const openQuestions: string[] = [];
      for (const col of columns) {
        const c = clauses.find((x) => x.sourceClauseId === col.id);
        const pos = c?.current.CANDIDATE;
        cells[col.id] = { coverage: pos?.coverage ?? ClauseCoverage.unknown, quote: pos?.evidenceQuote ?? null, evidenceRef: pos?.evidenceRef ?? null };
        if (!pos || pos.coverage === ClauseCoverage.unknown) openQuestions.push(col.text);
      }
      rows.push({ candidateProfileId: s.pipelineStatus.candidateProfile.id, displayName: s.pipelineStatus.candidateProfile.displayName, stage: s.pipelineStatus.stage, cells, openQuestions });
    }
    // Пункт [revocation-not-one-rule] 2026-09-06: сколько строк пустует
    // из-за отозванного согласия — отдельным числом. Прежде такие
    // кандидаты просто не попадали в таблицу, и матрица выглядела
    // полной при том, что часть пула из неё выпала.
    return {
      columns: columns.map((c) => ({ clauseId: c.id, text: c.text, isRequired: c.isRequired })),
      rows,
      revokedRows,
      note: 'Столбца «итог» нет; строки переставляются руками',
    };
  }

  // ── А-7: кому обещали и молчим ──

  async promiseToCandidate(userId: string, sheetId: string, dto: { description: string; dueDate?: string | null }) {
    const { sheet, project } = await this.sheets.assertSheetAccess(userId, sheetId);
    if (sheet.kind !== TermsSheetKind.INTERVIEW || !sheet.pipelineStatusId) throw new BadRequestException('Обещание кандидату — по листу кандидата');
    const status = await this.prisma.candidatePipelineStatus.findUnique({ where: { id: sheet.pipelineStatusId } });
    if (!status) throw new NotFoundException('Кандидат не найден');
    return this.prisma.commitment.create({
      data: { projectId: project.id, candidateProfileId: status.candidateProfileId, owner: CommitmentOwner.USER, description: dto.description.trim().slice(0, 1000), dueDate: dto.dueDate ? new Date(dto.dueDate) : null },
    });
  }

  async silenceReport(userId: string, projectId: string, days = 7, now = new Date()) {
    const project = await assertHiringProjectAccess(this.prisma, userId, projectId);
    if (!TEAM_MODES.has(project.mode)) throw new BadRequestException('Сводка — у агентства и работодателя');
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const waiting = await this.prisma.candidatePipelineStatus.findMany({ where: { projectId, stage: CandidateStage.AWAITING_FOLLOWUP, updatedAt: { lt: cutoff } }, include: { candidateProfile: { select: { id: true, displayName: true } } } });
    const overdue = await this.prisma.commitment.findMany({ where: { projectId, candidateProfileId: { not: null }, status: CommitmentStatus.IN_PROGRESS, dueDate: { lt: now } }, include: { candidateProfile: { select: { id: true, displayName: true } } } });
    return {
      waitingDays: days,
      waiting: waiting.map((w) => ({ candidateProfileId: w.candidateProfile.id, displayName: w.candidateProfile.displayName, since: w.updatedAt })),
      overduePromises: overdue.map((c) => ({ id: c.id, candidateProfileId: c.candidateProfileId, displayName: c.candidateProfile?.displayName, description: c.description, dueDate: c.dueDate })),
      frame: 'Дисциплина процесса, не KPI сотрудников — рейтингов рекрутеров здесь нет',
    };
  }

  // ── А-9: данные для bias-аудита — агрегаты без имён и признаков ──

  async biasExport(userId: string, projectId: string) {
    const project = await assertHiringProjectAccess(this.prisma, userId, projectId);
    if (!TEAM_MODES.has(project.mode)) throw new BadRequestException('Экспорт — у агентства и работодателя');
    const sheets = await this.prisma.termsSheet.findMany({ where: { projectId, kind: TermsSheetKind.INTERVIEW }, include: { pipelineStatus: { select: { stage: true } } } });
    const byClause = new Map<string, { text: string; total: number; covered: number; partial: number; not_covered: number; unknown: number; byStage: Record<string, number> }>();
    for (const s of sheets) {
      const clauses = await this.sheets.loadClauses(s.id);
      for (const c of clauses) {
        if (c.side !== TermsSide.EMPLOYER || c.kind !== TermsClauseKind.REQUIREMENT || !c.confirmedAt || c.rejectedAt) continue;
        const key = c.sourceClauseId ?? c.text;
        const agg = byClause.get(key) ?? { text: c.text, total: 0, covered: 0, partial: 0, not_covered: 0, unknown: 0, byStage: {} };
        const cov = c.current.CANDIDATE?.coverage ?? ClauseCoverage.unknown;
        agg.total++;
        agg[cov]++;
        const stage = s.pipelineStatus?.stage ?? 'UNKNOWN';
        agg.byStage[stage] = (agg.byStage[stage] ?? 0) + 1;
        byClause.set(key, agg);
      }
    }
    const stages = await this.prisma.candidatePipelineStatus.groupBy({ by: ['stage'], where: { projectId }, _count: { _all: true } }).catch(() => [] as Array<{ stage: CandidateStage; _count: { _all: number } }>);
    await this.audit.record({ actorId: userId, action: 'bias_export.generated', resource: 'Project', resourceId: projectId });
    return {
      generatedAt: new Date(),
      candidates: sheets.length,
      stages: stages.map((s) => ({ stage: s.stage, count: s._count._all })),
      clauses: [...byClause.values()],
      excluded: ['имена', 'контакты', 'защищённые признаки', 'genderRequirement/ageRequirement конфига', 'ComplianceFlag'],
      note: 'Материал для внешнего аудита (NYC LL144 / EU AI Act); продукт аудит не проводит и заключения о bias не выносит',
    };
  }

  // ── А-10: проектная видимость — повторное согласие при переносе кандидата в другой проект ──

  async addExistingCandidateToProject(userId: string, projectId: string, dto: { candidateProfileId: string; candidateConsentReconfirmed: boolean }) {
    const project = await assertHiringProjectAccess(this.prisma, userId, projectId);
    if (!TEAM_MODES.has(project.mode)) throw new BadRequestException('Только проект агентства или работодателя');
    const profile = await this.prisma.candidateProfile.findUnique({ where: { id: dto.candidateProfileId } });
    if (!profile) throw new NotFoundException(`CandidateProfile ${dto.candidateProfileId} not found`);
    const sameTeam = !!profile.recruitingTeamId && profile.recruitingTeamId === project.recruitingTeamId;
    if (!sameTeam && profile.ownerUserId !== userId) throw new NotFoundException(`CandidateProfile ${dto.candidateProfileId} not found`);
    // Пункт [revocation-not-one-rule] 2026-09-06: здесь стоял свой текст
    // — «Согласие кандидата отозвано», без главного: что отчёты по
    // кандидату не формируются и что снять отзыв может только сам
    // кандидат. Рекрутер, прочитавший короткую версию, идёт просить
    // коллегу добавить кандидата соседней кнопкой.
    await assertConsentActive(this.prisma, profile.id);
    const existing = await this.prisma.candidatePipelineStatus.findFirst({ where: { projectId, candidateProfileId: profile.id } });
    if (existing) return existing;
    const elsewhere = await this.prisma.candidatePipelineStatus.count({ where: { candidateProfileId: profile.id, projectId: { not: projectId } } });
    if (elsewhere > 0 && !dto.candidateConsentReconfirmed) {
      throw new ForbiddenException('Кандидат уже в другом проекте (другой заказчик / вакансия) — нужно новое подтверждение его согласия на рассмотрение здесь (candidateConsentReconfirmed)');
    }
    // ── Пункт [same-answer-either-way] 2026-09-24 ──
    //
    // Замысел этого метода ИДЕМПОТЕНТЕН и записан строкой выше своими
    // словами: `if (existing) return existing`. Но между тем чтением и
    // этой вставкой проходит время, и второй такой же вызов (двойное
    // нажатие, повтор при плохой связи, две вкладки) успевал пройти
    // проверку до того, как первый запишет. Дальше `@@unique([projectId,
    // candidateProfileId])` отвергал вторую вставку, Prisma бросала
    // P2002, и человек получал ПЯТИСОТКУ на действии, которое на самом
    // деле уже удалось.
    //
    // `upsert` с пустым `update` — не «исключить гонку усилием воли», а
    // сделать её исход одним и тем же: кто бы ни успел раньше, ответ
    // один. Пустой `update` намеренно: повтор НЕ переписывает этап,
    // до которого кандидат уже дошёл.
    //
    // Порядок сохранён: ранний возврат выше по-прежнему пропускает
    // проверку повторного согласия для уже добавленного кандидата — она
    // о ДОБАВЛЕНИИ, а не о наличии.
    const status = await this.prisma.candidatePipelineStatus.upsert({
      where: { projectId_candidateProfileId: { projectId, candidateProfileId: profile.id } },
      create: { projectId, candidateProfileId: profile.id },
      update: {},
    });
    await this.audit.record({ actorId: userId, action: 'candidate.added_to_project', resource: 'CandidatePipelineStatus', resourceId: status.id, after: { reconfirmed: dto.candidateConsentReconfirmed, elsewhere } });
    return status;
  }

  // ── Р-8: единый лист по кандидату — слияние двух статусов одного человека ──

  async mergeCandidates(userId: string, projectId: string, dto: { keepStatusId: string; mergeStatusId: string }) {
    const project = await assertHiringProjectAccess(this.prisma, userId, projectId);
    if (project.mode !== ProjectMode.EMPLOYER_HIRING) throw new BadRequestException('Слияние источников — у работодателя (кандидат от агентства и напрямую)');
    const keep = await this.prisma.candidatePipelineStatus.findFirst({ where: { id: dto.keepStatusId, projectId } });
    const merge = await this.prisma.candidatePipelineStatus.findFirst({ where: { id: dto.mergeStatusId, projectId } });
    if (!keep || !merge || keep.id === merge.id) throw new NotFoundException('Кандидаты не найдены в проекте');
    const keepSheet = await this.sheets.openForCandidate(userId, keep.id, { silent: true });
    const mergeSheet = await this.prisma.termsSheet.findUnique({ where: { pipelineStatusId: merge.id } });
    // Пункт [silent-destruction] 2026-09-04. Слияние НЕОБРАТИМО: ниже
    // удаляется вторая карточка кандидата, а по каскаду
    // (`TermsSheet.pipelineStatusId … onDelete: Cascade`) — весь её лист
    // с пунктами и позициями. Пункт, которому не нашлось пары в
    // оставляемом листе, вместе со всеми своими позициями исчезал
    // НАВСЕГДА И МОЛЧА: `continue` без счётчика. Это не находка модели,
    // а работа человека — записанные им позиции о кандидате из второго
    // источника. Отбрасывать по-прежнему приходится (пункт без пары
    // некуда переносить), но сказать об этом обязаны.
    let moved = 0;
    let clausesWithoutMatch = 0;
    let positionsDropped = 0;
    const droppedClauseTexts: string[] = [];
    if (mergeSheet) {
      const mergeClauses = await this.prisma.termsClause.findMany({ where: { sheetId: mergeSheet.id }, include: { positions: true } });
      const keepClauses = await this.prisma.termsClause.findMany({ where: { sheetId: keepSheet.id } });
      for (const mc of mergeClauses) {
        const target = keepClauses.find((k) => (mc.sourceClauseId && k.sourceClauseId === mc.sourceClauseId) || k.text === mc.text);
        if (!target) {
          clausesWithoutMatch++;
          positionsDropped += mc.positions.length;
          // Тексты пунктов возвращаются человеку: это его собственные
          // формулировки, и по ним он поймёт, что именно потеряно. Тот
          // же принцип, что в пункте [own-input]: где слова его — число
          // менее честно, чем текст.
          if (droppedClauseTexts.length < MERGE_DROPPED_SAMPLE) droppedClauseTexts.push(mc.text);
          continue;
        }
        for (const p of mc.positions) {
          await this.prisma.clausePosition.create({ data: { clauseId: target.id, bySide: p.bySide, coverage: p.coverage, stance: p.stance, note: p.note ? `[источник: ${p.evidenceKind === EvidenceKind.TRANSCRIPT_SEGMENT ? 'своё собеседование' : 'агентство'}] ${p.note}` : p.note, evidenceKind: p.evidenceKind, evidenceRef: p.evidenceRef, evidenceQuote: p.evidenceQuote, confirmedAt: p.confirmedAt, rejectedAt: p.rejectedAt } });
          moved++;
        }
      }
    }
    await this.prisma.candidatePipelineStatus.delete({ where: { id: merge.id } });
    await this.audit.record({ actorId: userId, action: 'candidate.merged', resource: 'CandidatePipelineStatus', resourceId: keep.id, after: { mergedStatusId: merge.id, positionsMoved: moved, clausesWithoutMatch, positionsDropped } });
    return {
      keepStatusId: keep.id,
      positionsMoved: moved,
      clausesWithoutMatch,
      positionsDropped,
      droppedClauseTexts,
      frame: 'Расхождения между источниками — цитатами; «кто прав» не решается',
    };
  }

  // ── Р-10: письмо-статус из фактов процесса ──

  async statusLetter(userId: string, sheetId: string, kind: 'waiting' | 'declined') {
    const { sheet, project } = await this.sheets.assertSheetAccess(userId, sheetId);
    if (sheet.kind !== TermsSheetKind.INTERVIEW || !sheet.pipelineStatusId) throw new BadRequestException('Письмо — по листу кандидата');
    const status = await this.prisma.candidatePipelineStatus.findUnique({ where: { id: sheet.pipelineStatusId }, include: { stageProgress: { where: { completedAt: { not: null } }, include: { stageDefinition: true } }, candidateProfile: { select: { displayName: true } } } });
    if (!status) throw new NotFoundException('Кандидат не найден');
    // Пункт [one-of-several-spoke-for-all] 2026-09-25: подпись письма
    // кандидату — утверждение о том, КТО ему пишет. Если компаний в
    // проекте несколько, продукт не выбирает за человека, а оставляет
    // подпись незаполненной и говорит об этом в рамке черновика:
    // письмо всё равно отправляет человек своей рукой.
    const choice = await dossierForProject(this.prisma as never, project.id);
    const clauses = await this.sheets.loadClauses(sheetId);
    const open = clauses.filter((c) => c.side === TermsSide.EMPLOYER && c.confirmedAt && !c.rejectedAt && (c.current.CANDIDATE?.coverage ?? 'unknown') === 'unknown').map((c) => c.text);
    const passed = status.stageProgress.map((p) => p.stageDefinition.name);
    const lines = [
      `Здравствуйте, ${status.candidateProfile.displayName}!`,
      '',
      passed.length ? `Вы прошли этапы: ${passed.join(', ')}.` : 'Вы откликнулись на вакансию, и мы получили ваши материалы.',
      kind === 'waiting'
        ? `Решение пока не принято${open.length ? `; открытыми остаются вопросы: ${open.join('; ')}` : ''}. Мы вернёмся с ответом.`
        : 'Мы решили не продолжать по этой вакансии. Спасибо за уделённое время.',
      '',
      choice.kind === 'one' && choice.dossier.legalName ? `${choice.dossier.legalName}` : 'Команда найма',
    ];
    const frame =
      choice.kind === 'many'
        ? `Из фактов процесса — без оценок, внутренних заметок и сравнения с другими; отправляет человек. Подпись не подставлена: ${manyCompaniesMessage(choice.companies)}`
        : 'Из фактов процесса — без оценок, внутренних заметок и сравнения с другими; отправляет человек';
    return { text: lines.join('\n'), reviewRequired: true, frame };
  }

  /** Пункт [log-says-we-saw-it] 2026-09-24 — продукт письмо НЕ отправляет.
   * Рамка самого письма это и говорит: «отправляет человек». Запись в
   * журнале называлась `status_letter.sent`, то есть утверждала
   * отправку, а получена была из нажатия кнопки.
   *
   * Подтверждение обязательно — ровно как `candidateAskedToRevoke` у
   * отзыва согласия со слов кандидата: там это правило уже есть и
   * работает, здесь его не было. */
  async markStatusLetterSent(userId: string, sheetId: string, dto: { recruiterSentIt: boolean }) {
    const { sheet } = await this.sheets.assertSheetAccess(userId, sheetId);
    if (!dto?.recruiterSentIt) {
      throw new BadRequestException('Продукт письма не отправляет — отметка делается с ваших слов. Подтвердите, что вы отправили письмо сами (recruiterSentIt).');
    }
    await this.audit.record({
      actorId: userId,
      action: AUDIT_STATUS_LETTER_MARKED_SENT,
      resource: 'TermsSheet',
      resourceId: sheet.id,
      after: { selfReported: true },
    });
    return { ok: true, selfReported: true, note: 'Отмечено с ваших слов: продукт отправку письма не проверяет и проверить не может' };
  }

  // ── Р-12: уведомление об AI от имени компании ──

  async aiNotice(userId: string, projectId: string) {
    const project = await assertHiringProjectAccess(this.prisma, userId, projectId);
    if (project.mode !== ProjectMode.EMPLOYER_HIRING) throw new BadRequestException('Уведомление от имени компании — у работодателя');
    // Пункт [one-of-several-spoke-for-all] 2026-09-25: это уведомление
    // — заявление о том, кто обрабатывает данные кандидата. Подписать
    // его одной из нескольких компаний наугад значит сказать неправду о
    // стороне, а не ошибиться в оформлении. Отказ здесь того же рода,
    // что уже стоял строкой ниже для случая «компании нет».
    const choice = await dossierForProject(this.prisma as never, projectId);
    if (choice.kind === 'none') throw new BadRequestException('Укажите компанию — уведомление подписывается её реквизитами');
    if (choice.kind === 'many') throw new BadRequestException(manyCompaniesMessage(choice.companies));
    const dossier = choice.dossier;
    const company = [dossier.legalName, dossier.registryCode ? `код ${dossier.registryCode}` : null, dossier.domain].filter(Boolean).join(', ');
    return {
      version: AI_NOTICE_VERSION,
      text:
        `${company} уведомляет: при подборе на эту вакансию используется AI-ассистент. Он сопоставляет ваши ответы с пунктами вакансии и предлагает интервьюеру, что уточнить. ` +
        'Решения о найме принимают люди; автоматических отказов и ранжирования нет. Вы можете запросить объяснение любого сопоставления и отозвать согласие на обработку.',
      consents: [
        { key: 'ai_notice', text: 'Я уведомлён(а), что с моими ответами работает AI-ассистент.' },
        { key: 'transfer', text: 'Я согласен(на) на хранение моих ответов в профиле кандидата у этой компании.' },
      ],
      frame: 'Шаблон юридически проверен под версией; правка — только с новой версией',
    };
  }

  /** Пункт [log-says-we-saw-it] 2026-09-24. Из всех шестнадцати записей
   * журнала эта — самая дорогая: именно ею доказывают, что кандидата
   * предупредили об AI. Уведомление показывает ЧЕЛОВЕК, на своём экране,
   * вне продукта; запись называлась `ai_notice.shown` и утверждала
   * показ. Теперь имя говорит, с чьих слов, и подтверждение обязательно. */
  async recordAiNoticeShown(userId: string, projectId: string, candidateProfileId: string, dto: { noticeShownToCandidate: boolean }) {
    const project = await assertHiringProjectAccess(this.prisma, userId, projectId);
    if (project.mode !== ProjectMode.EMPLOYER_HIRING) throw new BadRequestException('Только работодатель');
    const status = await this.prisma.candidatePipelineStatus.findFirst({ where: { projectId, candidateProfileId } });
    if (!status) throw new NotFoundException('Кандидат не найден в проекте');
    if (!dto?.noticeShownToCandidate) {
      throw new BadRequestException('Продукт уведомление кандидату не показывает — отметка делается с ваших слов. Подтвердите, что показали текст кандидату (noticeShownToCandidate).');
    }
    await this.audit.record({
      actorId: userId,
      action: AUDIT_AI_NOTICE_MARKED_SHOWN,
      resource: 'CandidateProfile',
      resourceId: candidateProfileId,
      after: { version: AI_NOTICE_VERSION, projectId, selfReported: true },
    });
    return { ok: true, version: AI_NOTICE_VERSION, selfReported: true, note: 'Отмечено с ваших слов: продукт показ уведомления не проверяет и проверить не может' };
  }

  // ── Р-14: закрытие вакансии — что осталось открытым ──

  async closingChecklist(userId: string, projectId: string) {
    const project = await assertHiringProjectAccess(this.prisma, userId, projectId);
    if (project.mode !== ProjectMode.EMPLOYER_HIRING) throw new BadRequestException('Закрытие вакансии — у работодателя');
    const statuses = await this.prisma.candidatePipelineStatus.findMany({ where: { projectId }, include: { candidateProfile: { select: { id: true, displayName: true } }, termsSheet: { select: { id: true } } } });
    // Пункт [log-says-we-saw-it] 2026-09-24. Два имени, а не одно:
    // строки за прежним именем в журнале уже есть и означают то же
    // самое — делать вид, что истории нет, было бы той же неправдой, но
    // в другую сторону. Писать прежнее имя больше нельзя, читать —
    // обязаны.
    //
    // И поле переименовано. Прежнее `candidatesWithoutAnswer`
    // утверждало, что этим людям НЕ ОТВЕТИЛИ, а знает продукт только
    // одно: рекрутер не нажимал кнопку. Экран под пустым списком писал
    // «Всем ответили.» — утверждение о живых людях, собранное из нажатий.
    const letters = new Set((await this.prisma.auditLogEntry.findMany({ where: { action: { in: AUDIT_STATUS_LETTER_ANY }, resource: 'TermsSheet' }, select: { resourceId: true } })).map((e) => e.resourceId));
    const withoutAnswer = statuses.filter((s) => !s.termsSheet || !letters.has(s.termsSheet.id)).map((s) => ({ candidateProfileId: s.candidateProfile.id, displayName: s.candidateProfile.displayName, stage: s.stage }));
    const openCommitments = await this.prisma.commitment.findMany({ where: { projectId, status: CommitmentStatus.IN_PROGRESS }, select: { id: true, description: true, dueDate: true, candidateProfileId: true } });
    // Пункт [term-never-ends] 2026-09-06: оба списка назывались
    // «активными», а применяли ДВА РАЗНЫХ ослабленных определения —
    // заказы по `status`, шеринги по `revokedAt`, — и ни одно не
    // включало срок. Чеклист закрытия вакансии перечисляет человеку, что
    // осталось развязать: истёкшее в этом списке — не просто лишняя
    // строка, а просьба сделать то, чего делать уже не нужно, и
    // уверенность, что канал открыт, когда он закрылся сам.
    //
    // Срок отсекается ЗАПРОСОМ, а не фильтром в памяти: список может
    // вырасти, и «сначала взять всё, потом отбросить» — привычка, из-за
    // которой потолки выборки однажды начнут резать не то.
    const сейчас = new Date();
    const activeEngagements = await this.prisma.employerAgencyEngagement.findMany({ where: { employerProjectId: projectId, status: 'ACTIVE', expiresAt: { gt: сейчас } }, select: { id: true, agencyProjectId: true, expiresAt: true } });
    const activeShares = await this.prisma.candidateShare.findMany({ where: { acceptedIntoMode: ProjectMode.EMPLOYER_HIRING, revokedAt: null, expiresAt: { gt: сейчас }, createdCandidateProfileId: { in: statuses.map((s) => s.candidateProfile.id) } }, select: { id: true, createdCandidateProfileId: true, expiresAt: true } });
    return {
      candidatesAnswerNotMarked: withoutAnswer,
      openCommitments,
      activeEngagements,
      activeShares,
      frame: 'Список действий человеку; автоматических писем и отзывов нет. Отметки об ответе — с ваших слов: отправку письма продукт не проверяет',
    };
  }
}

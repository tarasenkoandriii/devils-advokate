// Пункт [job-domain-v2] — клиент общего слоя найма (лист условий, CV-вариант,
// самошеринг, бриф, компания, текст вакансии, приток, работодатель, этап 2).
// Пути — ровно как в декораторах контроллеров apps/api. Типы — минимально
// достаточные для экранов; произвольные JSON-хвосты рендерятся JsonView.
import { apiGet, apiPatch, apiPost } from '../api';

export type TermsSide = 'EMPLOYER' | 'CANDIDATE';
export type ClauseKind = 'REQUIREMENT' | 'CONDITION';
export type Coverage = 'covered' | 'partial' | 'not_covered' | 'unknown';
export type Stance = 'unknown' | 'offered' | 'accepted' | 'countered' | 'declined' | 'open';
export type SheetKind = 'VACANCY' | 'INTERVIEW' | 'VACANCY_RESPONSE';
// Пункт [label-is-the-choice] 2026-09-06. Здесь стояло
// `… | 'DECLINED' | 'CLOSED'`: статуса CLOSED в перечислении сервера
// НЕТ, а существующий WITHDRAWN в типе отсутствовал. Тип клиента
// разошёлся с перечислением сервера, и это не заметил никто — потому
// что значений в обоих было по пять. Сверка типа с перечислением
// держится тестом.
export type SheetStatus = 'DRAFT' | 'IN_NEGOTIATION' | 'AGREED' | 'DECLINED' | 'WITHDRAWN';

export interface Position {
  id: string;
  bySide: TermsSide;
  coverage: Coverage | null;
  stance: Stance | null;
  note: string | null;
  evidenceKind: string;
  evidenceRef: string | null;
  evidenceQuote: string | null;
  confirmedAt: string | null;
  rejectedAt: string | null;
  supersedesId: string | null;
  createdAt: string;
}

export interface Clause {
  id: string;
  side: TermsSide;
  kind: ClauseKind;
  text: string;
  category: string | null;
  isRequired: boolean;
  orderIndex: number;
  sourceEvidence: string | null;
  sourceRef: string | null;
  sourceQuote: string | null;
  sourceClauseId: string | null;
  confirmedAt: string | null;
  rejectedAt: string | null;
  counterpartClauseId: string | null;
  counterpartConfirmedAt: string | null;
  current: Record<TermsSide, Position | null>;
  drafts: Position[];
}

export interface Offer {
  id: string;
  rawText: string;
  source: string | null;
  reviewedAt: string | null;
  sharedFromProjectId: string | null;
  withdrawnAt: string | null;
  createdAt: string;
}

export interface Sheet {
  id: string;
  projectId: string;
  kind: SheetKind;
  status: SheetStatus;
  title: string;
  configId: string | null;
  pipelineStatusId: string | null;
  vacancyId: string | null;
  clauses: Clause[];
  counters: { total: Record<Coverage, number>; byCategory: Record<string, Record<Coverage, number>> };
  offers: Offer[];
  cvVariants: Array<{ id: string; lang: string; compiledAt: string; reviewedAt: string | null }>;
  /** Что сервер СЕЙЧАС примет в setStatus. Экран не вычисляет это сам:
   * правила переходов живут на сервере, и второй их экземпляр однажды
   * разойдётся с первым. */
  allowedStatuses?: SheetStatus[];
}

export interface SheetListItem { id: string; kind: SheetKind; status: SheetStatus; title: string; configId: string | null; pipelineStatusId: string | null; vacancyId: string | null; createdAt: string }

export const COVERAGE_LABEL: Record<string, string> = {
  covered: 'отражено',
  partial: 'частично',
  not_covered: 'не отражено',
  unknown: 'не обсуждалось',
};
export const STANCE_LABEL: Record<string, string> = {
  unknown: 'не обсуждалось',
  offered: 'предложено',
  accepted: 'принято',
  countered: 'встречное',
  declined: 'отклонено',
  open: 'открыто',
};
export const SIDE_LABEL: Record<TermsSide, string> = { EMPLOYER: 'работодатель', CANDIDATE: 'соискатель' };
/** Подписи статусов. Тип закрыт намеренно: `Record<string, string>` не
 * держало ни одного из двух расхождений — ни пропавшего WITHDRAWN, ни
 * несуществующего CLOSED. Теперь пропуск ключа не соберётся. */
export const STATUS_LABEL: Record<SheetStatus, string> = {
  DRAFT: 'черновик',
  IN_NEGOTIATION: 'обсуждается',
  AGREED: 'согласовано',
  DECLINED: 'отказ',
  WITHDRAWN: 'отозван',
};
export const EVIDENCE_LABEL: Record<string, string> = {
  TRANSCRIPT_SEGMENT: 'транскрипт',
  VACANCY_TEXT: 'текст вакансии',
  OFFER_TEXT: 'оффер',
  CLIENT_BRIEF: 'бриф',
  PUBLIC_SOURCE: 'публичный источник',
  OWN_DOCUMENT: 'документ',
  INTERVIEWER_DEBRIEF: 'мнение интервьюера',
  USER_STATED: 'сказано пользователем',
};

const S = (id: string) => `/terms-sheets/${id}`;

export const sheetsApi = {
  list: (projectId: string) => apiGet<SheetListItem[]>(`/terms-sheets/projects/${projectId}`),
  get: (id: string) => apiGet<Sheet>(S(id)),
  openVacancy: (projectId: string) => apiPost<Sheet>(`/terms-sheets/projects/${projectId}/vacancy`, {}),
  openForCandidate: (pipelineStatusId: string) => apiPost<Sheet>(`/terms-sheets/from-candidate/${pipelineStatusId}`, {}),
  openForVacancy: (vacancyId: string) => apiPost<Sheet>(`/terms-sheets/from-vacancy/${vacancyId}`, {}),
  // К-5 (аудит 2026-09-03): повестка отдавала пункты, а ТЗ требует
  // сформулированные вопросы, которые человек отправит как есть.
  clarifyingQuestions: (id: string) => apiPost<{ sheetId: string; questions: Array<{ clauseId: string; clauseText: string; question: string }>; note: string }>(`${S(id)}/clarifying-questions`, {}),
  agenda: (id: string) => apiGet<Array<{ clauseId: string; side: TermsSide; kind: ClauseKind; text: string; category: string | null; isRequired: boolean }>>(`${S(id)}/agenda`),
  revisions: (id: string, clauseId: string) => apiGet<any>(`${S(id)}/revisions/${clauseId}`),
  addClause: (id: string, body: { side: TermsSide; kind: ClauseKind; text: string; category?: string | null; isRequired?: boolean }) => apiPost<Clause>(`${S(id)}/clauses`, body),
  confirmClauses: (id: string, ids: string[]) => apiPost<any>(`${S(id)}/clauses/confirm`, { ids }),
  rejectClauses: (id: string, ids: string[]) => apiPost<any>(`${S(id)}/clauses/reject`, { ids }),
  setCounterpart: (id: string, clauseId: string, counterpartClauseId: string | null) => apiPatch<any>(`${S(id)}/clauses/${clauseId}`, { counterpartClauseId }),
  proposeCounterparts: (id: string) => apiPost<any>(`${S(id)}/counterparts/propose`, {}),
  propose: (id: string, body: { evidenceKind: string; evidenceRef?: string | null; text?: string | null; bySide?: TermsSide }) => apiPost<any>(`${S(id)}/propose`, body),
  addPosition: (id: string, body: { clauseId: string; bySide: TermsSide; coverage?: Coverage | null; stance?: Stance | null; note?: string | null; evidenceQuote: string }) => apiPost<Position>(`${S(id)}/positions`, body),
  confirmPositions: (id: string, ids: string[]) => apiPost<any>(`${S(id)}/positions/confirm`, { ids }),
  rejectPositions: (id: string, ids: string[]) => apiPost<any>(`${S(id)}/positions/reject`, { ids }),
  addOffer: (id: string, body: { rawText: string; source?: string | null }) => apiPost<any>(`${S(id)}/offers`, body),
  offerDraft: (id: string) => apiPost<{ text: string; [k: string]: unknown }>(`${S(id)}/offer-draft`, {}),
  setStatus: (id: string, status: SheetStatus) => apiPatch<Sheet>(`${S(id)}/status`, { status }),
  // CV-вариант (К-21…К-28)
  cvPropose: (id: string) => apiPost<any>(`${S(id)}/cv-variant/propose`, {}),
  cvCompile: (id: string, highlightMap: unknown[], lang?: string) => apiPost<any>(`${S(id)}/cv-variant/compile`, { highlightMap, ...(lang ? { lang } : {}) }),
  cvReview: (variantId: string) => apiPost<any>(`/cv-variants/${variantId}/review`, {}),
  cvRephrase: (variantId: string, refs: string[]) => apiPost<any>(`/cv-variants/${variantId}/rephrase`, { refs }),
  cvRephraseConfirm: (variantId: string, refs: string[]) => apiPost<any>(`/cv-variants/${variantId}/rephrase/confirm`, { refs }),
  cvTranslate: (variantId: string, lang: string) => apiPost<any>(`/cv-variants/${variantId}/translate`, { lang }),
  // К-23 (аудит 2026-09-03): маршрут появился только после аудита — сервис
  // был написан, но недостижим.
  cvConsistency: (projectId: string) => apiGet<any>(`/terms-sheets/projects/${projectId}/cv-consistency`),
  dialogueNext: (id: string) => apiGet<any>(`${S(id)}/dialogue/next`),
  dialogueAnswer: (id: string, body: { clauseId: string; text?: string | null; segmentId?: string | null }) => apiPost<any>(`${S(id)}/dialogue/answer`, body),
  // этап 2 (hiring-extras)
  rehearsalPositions: (id: string, sparringSessionId: string) => apiPost<any>(`${S(id)}/rehearsal-positions`, { sparringSessionId }),
  debrief: (id: string, text: string) => apiPost<any>(`${S(id)}/debrief`, { text }),
  salaryScenarios: (id: string) => apiPost<any>(`${S(id)}/salary-scenarios`, {}),
  liveHint: (id: string, transcriptWindow: string) => apiPost<any>(`${S(id)}/live-hint`, { transcriptWindow }),
  testAssignment: (id: string, body: { assignmentText: string; answerText: string }) => apiPost<any>(`${S(id)}/test-assignment`, body),
  prediction: (id: string, predictedOutcome: string) => apiPost<any>(`${S(id)}/predictions`, { predictedOutcome }),
  promise: (id: string, body: { description: string; dueDate?: string | null }) => apiPost<any>(`${S(id)}/promises`, body),
  statusLetter: (id: string, kind: 'waiting' | 'declined') => apiGet<{ text: string; reviewRequired: boolean; frame: string }>(`${S(id)}/status-letter/${kind}`),
  // Пункт [log-says-we-saw-it] 2026-09-24: продукт письма не отправляет
  // и показа уведомления не видит. Подтверждение не «галочка ради
  // валидации», а единственное, что делает запись в журнале правдой:
  // она говорит «рекрутер сказал, что отправил», а не «отправлено».
  // Значение обязан передавать тот, кто утверждает, — поэтому параметр,
  // а не константа в клиенте.
  statusLetterSent: (id: string, recruiterSentIt: boolean) => apiPost<any>(`${S(id)}/status-letter/sent`, { recruiterSentIt }),
  coverageMatrix: (projectId: string) => apiGet<any>(`/terms-sheets/projects/${projectId}/coverage-matrix`),
  silence: (projectId: string, days = 7) => apiGet<any>(`/terms-sheets/projects/${projectId}/silence?days=${days}`),
  biasExport: (projectId: string) => apiGet<any>(`/terms-sheets/projects/${projectId}/bias-export`),
  existingCandidate: (projectId: string, body: { candidateProfileId: string; candidateConsentReconfirmed: boolean }) => apiPost<any>(`/terms-sheets/projects/${projectId}/existing-candidate`, body),
  mergeCandidates: (projectId: string, body: { keepStatusId: string; mergeStatusId: string }) => apiPost<any>(`/terms-sheets/projects/${projectId}/merge-candidates`, body),
  aiNotice: (projectId: string) => apiGet<any>(`/terms-sheets/projects/${projectId}/ai-notice`),
  aiNoticeShown: (projectId: string, candidateProfileId: string, noticeShownToCandidate: boolean) => apiPost<any>(`/terms-sheets/projects/${projectId}/ai-notice/shown`, { candidateProfileId, noticeShownToCandidate }),
  closingChecklist: (projectId: string) => apiGet<any>(`/terms-sheets/projects/${projectId}/closing-checklist`),
  preQuestionnaire: (pipelineStatusId: string) => apiPost<{ token: string; expiresAt: string; deepLink: string }>(`/interview-pool/pipeline-statuses/${pipelineStatusId}/pre-questionnaire`, {}),
};

// Самошеринг соискателя (К-8)
// А-6 (аудит 2026-09-03): отзыв согласия, полученный вне продукта.
export const candidateConsentApi = {
  revoke: (candidateProfileId: string, body: { candidateAskedToRevoke: boolean; note?: string | null }) =>
    apiPost<{ consentRevokedAt: string; sharesRevoked?: number; alreadyRevoked?: boolean; message: string }>(`/candidate-profiles/${candidateProfileId}/revoke-consent`, body),
};

/** Исход отзыва самошеринга — та же форма, что у отзыва кандидатом
 *  (`CandidateRevocation` в `lib/public-api`): два текста плюс признак
 *  недойденной вглубь цепочки. */
export interface SelfShareRevocation {
  shareId: string;
  revokedAt: string;
  copiesRevoked: number;
  depthExhausted: boolean;
  alsoDone: string;
  doesNotUndo: string;
}

export const selfShareApi = {
  consentText: () => apiGet<{ version: string; text: string; [k: string]: unknown }>('/job-search/self-share/consent-text'),
  create: (sheetId: string, body: { cvVariantId: string; visibleClauseIds: string[]; edge: 'to_agency' | 'to_employer'; consentVersion?: string | null }) => apiPost<{ shareId: string; deepLink: string; expiresAt: string; edge: string }>(`/job-search/terms-sheets/${sheetId}/self-share`, body),
  list: (sheetId: string) => apiGet<any[]>(`/job-search/terms-sheets/${sheetId}/self-shares`),
  // Пункт [the-outcome-reached-one-route-of-three] 2026-10-01: здесь был
  // `apiPost<any>`, и из-за него исход отзыва нельзя было НАРИСОВАТЬ —
  // поля, которые сервер считает, в типе отсутствовали, а экран результат
  // выбрасывал. Тип повторяет форму, общую для всех трёх маршрутов
  // отзыва.
  revoke: (shareId: string) =>
    apiPost<SelfShareRevocation>(`/job-search/self-shares/${shareId}/revoke`, {}),
  preview: (token: string) => apiGet<any>(`/candidate-shares/self/${token}/preview`),
  accept: (token: string, projectId: string) => apiPost<any>('/candidate-shares/accept', { token, projectId }),
};

// К-22 (аудит 2026-09-03) — импорт готового резюме и правка черновика.
export const cvImportApi = {
  importCv: (projectId: string, body: { text: string; sourceRef?: string | null }) =>
    apiPost<{ config: any; evidenceCount: number; missing: Array<{ path: string; label: string }>; note: string }>(`/job-search/projects/${projectId}/cv/import`, body),
  editDraft: (projectId: string, draft: unknown) =>
    apiPost<{ config: any; evidenceCount: number; missing: Array<{ path: string; label: string }> }>(`/job-search/projects/${projectId}/cv/draft-edit`, { draft }),
};

// Приток и инструменты соискателя (связка П)
const J = (projectId: string) => `/job-search/projects/${projectId}`;
export const intakeApi = {
  searchPage: (projectId: string, body: { url?: string | null; html?: string | null }) => apiPost<any>(`${J(projectId)}/intake/search-page`, body),
  emailAlert: (projectId: string, links: Array<{ url: string; title?: string | null; company?: string | null }>) => apiPost<any>(`${J(projectId)}/intake/email-alert`, { links }),
  pasted: (projectId: string, body: { text: string; title?: string | null; sourceUrl?: string | null }) => apiPost<any>(`${J(projectId)}/intake/pasted`, body),
  responses: (projectId: string, text: string) => apiPost<any>(`${J(projectId)}/intake/responses`, { text }),
  candidates: (projectId: string) => apiGet<any[]>(`${J(projectId)}/intake/candidates`),
  fetchCandidate: (id: string) => apiPost<any>(`/job-search/vacancy-candidates/${id}/fetch`, {}),
  dedupe: (projectId: string) => apiPost<any>(`${J(projectId)}/dedupe`, {}),
  unlinkDuplicate: (vacancyId: string) => apiPost<any>(`/job-search/vacancies/${vacancyId}/unlink-duplicate`, {}),
  watch: (vacancyId: string, enabled: boolean) => apiPatch<any>(`/job-search/vacancies/${vacancyId}/watch`, { enabled }),
  refetch: (vacancyId: string) => apiPost<any>(`/job-search/vacancies/${vacancyId}/refetch`, {}),
  changes: (vacancyId: string) => apiGet<any>(`/job-search/vacancies/${vacancyId}/changes`),
  favorite: (vacancyId: string, favorite: boolean) => apiPatch<any>(`/job-search/vacancies/${vacancyId}/favorite`, { favorite }),
  // К-3 (аудит 2026-09-03): отметить отклик руками — без этого сводка
  // «молчат N дней» работала только после импорта истории с площадки.
  responseStatus: (vacancyId: string, status: string | null) => apiPatch<any>(`/job-search/vacancies/${vacancyId}/response-status`, { status }),
  silence: (projectId: string, days = 7) => apiGet<any>(`${J(projectId)}/silence?days=${days}`),
  queryBuilder: (projectId: string) => apiGet<any>(`${J(projectId)}/query-builder`),
  batchMatch: (projectId: string, vacancyIds: string[]) => apiPost<any>(`${J(projectId)}/batch-match`, { vacancyIds }),
  matrix: (projectId: string, q: { filter?: string; sort?: string } = {}) => apiGet<any>(`${J(projectId)}/matrix?${new URLSearchParams(Object.fromEntries(Object.entries(q).filter(([, v]) => v)) as Record<string, string>).toString()}`),
  criteriaSuggestions: (projectId: string) => apiGet<any>(`${J(projectId)}/criteria-suggestions`),
  addCriterion: (projectId: string, body: { text: string; category: string; isRequired: boolean }) => apiPost<any>(`${J(projectId)}/criteria`, body),
  gapMap: (projectId: string) => apiGet<any>(`${J(projectId)}/gap-map`),
  coverLetter: (projectId: string, sheetId: string, body: { notCoveredHandling: 'name_honestly' | 'skip'; cvVariantId?: string | null }) => apiPost<any>(`${J(projectId)}/cover-letter/${sheetId}`, body),
  applicationPackage: (projectId: string, sheetId: string, body: { notCoveredHandling: 'name_honestly' | 'skip'; questions?: string[] }) => apiPost<any>(`${J(projectId)}/application-package/${sheetId}`, body),
  scamSignals: (vacancyId: string) => apiPost<any>(`/job-search/vacancies/${vacancyId}/scam-signals`, {}),
  similar: (projectId: string, vacancyId: string) => apiGet<any>(`${J(projectId)}/similar/${vacancyId}`),
};

// Компания (досье работодателя)
export const dossierApi = {
  identify: (projectId: string, body: { legalName?: string | null; registryCode?: string | null; domain?: string | null; jurisdiction?: string | null }) => apiPost<any>(`/employer-dossiers/projects/${projectId}`, body),
  list: (projectId: string) => apiGet<any[]>(`/employer-dossiers/projects/${projectId}`),
  shipmentChecklist: (projectId: string) => apiGet<any>(`/employer-dossiers/projects/${projectId}/shipment-checklist`),
  get: (id: string) => apiGet<any>(`/employer-dossiers/${id}`),
  confirm: (id: string, legalName?: string | null) => apiPost<any>(`/employer-dossiers/${id}/confirm`, legalName ? { legalName } : {}),
  refresh: (id: string) => apiPost<any>(`/employer-dossiers/${id}/refresh`, {}),
  addSource: (id: string, body: { url: string; category?: string | null }) => apiPost<any>(`/employer-dossiers/${id}/sources`, body),
  addRepresentative: (id: string, body: { displayName: string; claimedRole?: string | null; contactDomain?: string | null; personId?: string | null }) => apiPost<any>(`/employer-dossiers/${id}/representatives`, body),
  checkRepresentative: (repId: string) => apiPost<any>(`/employer-dossiers/representatives/${repId}/check`, {}),
  discrepancies: (id: string, q: { briefId?: string; vacancyId?: string; postingId?: string } = {}) => apiGet<any>(`/employer-dossiers/${id}/discrepancies?${new URLSearchParams(Object.fromEntries(Object.entries(q).filter(([, v]) => v)) as Record<string, string>).toString()}`),
  linkVacancy: (id: string, vacancyId: string) => apiPost<any>(`/employer-dossiers/${id}/vacancies/${vacancyId}`, {}),
  history: (id: string) => apiGet<any>(`/employer-dossiers/${id}/history`),
  // А-28 (аудит 2026-09-03): выжимка о компании, которую можно показать кандидату.
  candidateSummary: (id: string) => apiGet<any>(`/employer-dossiers/${id}/candidate-summary`),
};

// Бриф
export const briefApi = {
  ingest: (projectId: string, body: { rawText: string; source?: string | null; origin?: string }) => apiPost<any>(`/client-briefs/projects/${projectId}`, body),
  list: (projectId: string) => apiGet<any[]>(`/client-briefs/projects/${projectId}`),
  diff: (projectId: string) => apiGet<any>(`/client-briefs/projects/${projectId}/diff`),
  extract: (id: string) => apiPost<any>(`/client-briefs/${id}/extract`, {}),
  questions: (id: string) => apiGet<any>(`/client-briefs/${id}/questions`),
  compliance: (id: string) => apiGet<any>(`/client-briefs/${id}/compliance`),
};

// Текст вакансии (связка Т)
export const postingApi = {
  get: (projectId: string) => apiGet<any>(`/vacancy-postings/projects/${projectId}`),
  draft: (projectId: string) => apiPost<any>(`/vacancy-postings/projects/${projectId}/draft`, {}),
  addRevision: (projectId: string, text: string) => apiPost<any>(`/vacancy-postings/projects/${projectId}/revisions`, { text }),
  check: (revisionId: string) => apiPost<any>(`/vacancy-postings/revisions/${revisionId}/check`, {}),
  trace: (revisionId: string) => apiGet<any>(`/vacancy-postings/revisions/${revisionId}/trace`),
  readerQuestions: (revisionId: string) => apiGet<any>(`/vacancy-postings/revisions/${revisionId}/reader-questions`),
  variants: (revisionId: string, body: { channels?: string[]; langs?: string[] }) => apiPost<any>(`/vacancy-postings/revisions/${revisionId}/variants`, body),
  publishChecklist: (revisionId: string) => apiGet<any>(`/vacancy-postings/revisions/${revisionId}/publish-checklist`),
  salaryOmission: (revisionId: string, reason: string) => apiPost<any>(`/vacancy-postings/revisions/${revisionId}/salary-omission`, { reason }),
  review: (revisionId: string) => apiPost<any>(`/vacancy-postings/revisions/${revisionId}/review`, {}),
  reviewShare: (revisionId: string) => apiPost<any>(`/vacancy-postings/revisions/${revisionId}/review-share`, {}),
  reviewVariant: (variantId: string) => apiPost<any>(`/vacancy-postings/variants/${variantId}/review`, {}),
};

// Работодатель: хаб, engagement, оффер
export const employerApi = {
  state: (projectId: string) => apiGet<any>(`/employer-hiring/projects/${projectId}/state`),
  updateConfig: (projectId: string, body: Record<string, unknown>) => apiPost<any>(`/employer-hiring/projects/${projectId}/config`, body),
  invite: (employerProjectId: string, body: { sharedItems: string[]; expiresAt?: string | null }) => apiPost<any>(`/engagements/projects/${employerProjectId}`, body),
  engagements: (employerProjectId: string) => apiGet<any[]>(`/engagements/projects/${employerProjectId}`),
  deliveredReports: (employerProjectId: string) => apiGet<any[]>(`/engagements/projects/${employerProjectId}/reports`),
  agencyEngagements: (agencyProjectId: string) => apiGet<any[]>(`/engagements/agency-projects/${agencyProjectId}`),
  accept: (body: { token: string; teamId: string; agencyProjectId?: string | null }) => apiPost<any>('/engagements/accept', body),
  revoke: (id: string) => apiPost<any>(`/engagements/${id}/revoke`, {}),
  followUp: (id: string, body: { candidateProfileId: string; text: string }) => apiPost<any>(`/engagements/${id}/follow-up`, body),
  postingReview: (id: string, body: { revisionId: string; text: string }) => apiPost<any>(`/engagements/${id}/posting-review`, body),
  agencyPosting: (id: string) => apiGet<any>(`/engagements/${id}/posting`),
  deliver: (id: string, reportId: string) => apiPost<any>(`/engagements/${id}/deliver`, { reportId }),
  offerReview: (offerId: string) => apiPost<any>(`/offers/${offerId}/review`, {}),
  offerPromisesCheck: (offerId: string) => apiGet<any>(`/offers/${offerId}/promises-check`),
  offerShare: (offerId: string, body: { candidateShareId?: string | null; token?: string | null }) => apiPost<any>(`/offers/${offerId}/share-to-candidate`, body),
  offerWithdraw: (offerId: string) => apiPost<any>(`/offers/${offerId}/withdraw`, {}),
};

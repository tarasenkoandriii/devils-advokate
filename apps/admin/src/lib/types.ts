// Типы отражают контракты из devils-advocate-admin-panel-tz.md §4,
// devils-advocate-prompt-framework-tz.md §5, devils-advocate-telemetry-tz.md §4
// и реальные Prisma-модели backend (apps/api/prisma/schema.prisma) —
// не переизобретены заново, списаны с уже реализованного кода.

// ── Аутентификация (§4.1) ──

export interface AdminMe {
  userId: string;
  isLibraryModerator: boolean;
  isVenueModerator: boolean;
  isOperator: boolean;
}

// ── Пользователи (§4.3) ──

export interface AdminUserRow {
  id: string;
  telegramId: string;
  createdAt: string;
  isRestricted: boolean;
  isBlocked: boolean;
  isLibraryModerator: boolean;
  isVenueModerator: boolean;
  isOperator: boolean;
}

export interface AdminUserDetail extends AdminUserRow {
  restrictedAt: string | null;
  restrictedNote: string | null;
  blockedAt: string | null;
  blockedNote: string | null;
  projectCount: number;
  conversationCount: number;
  lastActivityAt: string | null;
}

// ── Модерация библиотеки (§3.5 ТЗ, library.service.ts) ──

export interface LibraryArgument {
  id: string;
  text: string;
  stance: 'PRO' | 'CON';
}

export interface LibraryEntry {
  id: string;
  title: string;
  category: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  upvotes: number;
  downvotes: number;
  createdAt: string;
  arguments: LibraryArgument[];
}

// ── Модерация заведений + монетизация (§3.22/§3.23 ТЗ) ──

export interface VenueApplication {
  id: string;
  name: string;
  address: string;
  phone: string | null;
  openingHours: string[];
  googlePlaceId: string | null;
  photoReferences: string[];
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
}

export interface ApprovedVenue {
  id: string;
  name: string;
  address: string;
  phone: string | null;
  rating: number | null;
  referralFeeAmount: number | null;
  isPriorityPartner: boolean;
}

export interface CommissionSummary {
  totalBookingsConfirmed: number;
  totalFeesOwed: number;
}

// ── Prompt Registry (devils-advocate-prompt-framework-tz.md §5.1) ──

export type PromptVersionStatus = 'DRAFT' | 'TESTING' | 'ACTIVE' | 'DEPRECATED';

export interface PromptVersion {
  id: string;
  promptId: string;
  version: string;
  template: string;
  changelog: string | null;
  status: PromptVersionStatus;
  createdAt: string;
}

// ── Evaluation (§5.2) ──

export interface EvaluationDataset {
  id: string;
  name: string;
  version: string;
  description: string | null;
}

export interface EvaluationCaseResult {
  id: string;
  evaluationCaseId: string;
  actualOutput: string;
  passed: boolean;
  note: string | null;
}

export interface EvaluationMetricResult {
  id: string;
  value: number;
  passed: boolean;
  evaluationMetric?: { name: string };
}

export interface ReleaseGate {
  id: string;
  passed: boolean;
  gateType: string;
}

export interface EvaluationRun {
  id: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  promptVersionId: string | null;
  evaluationDatasetId: string;
  startedAt: string;
  completedAt: string | null;
  results?: EvaluationMetricResult[];
  caseResults?: EvaluationCaseResult[];
  failedCases?: EvaluationCaseResult[];
  releaseGate?: ReleaseGate | null;
}

// ── Calibration (§5.3) ──

export interface CalibrationStatus {
  sampleSize: number;
  brierScore: number | null;
  threshold: number;
  gatePassed: boolean;
}

// ── Telemetry (devils-advocate-telemetry-tz.md §4) ──

export interface TelemetrySummaryRow {
  taskType: string | null;
  totalCalls: number;
  byStatus: Record<'COMPLETED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED', number>;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  retryRate: number;
  schemaValidationFailRate: number;
  inputBlockedCount: number;
}

export interface TelemetryByModelRow extends Omit<TelemetrySummaryRow, 'taskType'> {
  modelVersion: string;
}

export interface AIJobDetail {
  id: string;
  status: string;
  modelVersion: string;
  promptVersionId: string | null;
  retryCount: number;
  durationMs: number | null;
  schemaValidation: string;
  inputScanStatus: string;
  createdAt: string;
}

// ── Доменные сценарии / intake / media-review (ТЗ domain-ui-and-voice-intake §1.4, фаза F) ──

export interface DomainSummaryRow { domain: string; mode: string; total: number; last7: number; last30: number; withConfig: number; configRate: number | null }
export interface DomainProjectRow { id: string; question: string; createdAt: string; updatedAt: string; frozenAt: string | null; owner: { id: string; telegramId: string }; config: { id: string; createdAt: string } | null }
export interface DomainProjectList { items: DomainProjectRow[]; total: number; take: number; skip: number }
export interface DomainProjectDetail { id: string; question: string; goal: string | null; createdAt: string; updatedAt: string; frozenAt: string | null; frozenNote: string | null; owner: { id: string; telegramId: string; isRestricted: boolean; isBlocked: boolean }; config: Record<string, unknown> | null; _count: { conversations: number } }
export interface IntakeSummary { windowDays: number; total: number; byStatus: Record<string, number>; dispatched: number; mismatches: number; mismatchRate: number | null; avgConfidence: number | null; avgFollowUps: number | null; suggestedVsChosen: Record<string, Record<string, number>> }
export interface AdminMediaReviewQueue { id: string; title: string; createdAt: string; ownerTelegramId: string; totalItems: number; byStatus: Record<string, number>; stuckProcessing: number }

// ── Sandbox (пункт [admin-sandbox] 2026-08-31) ──

export interface SandboxCheckItem {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
}
export interface SandboxStatus { items: SandboxCheckItem[] }

export interface SandboxYouTubeResult {
  videoId: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  durationSeconds: number | null;
  publishedAt: string | null;
}
export interface SandboxYouTubeSearch { tookMs: number; results: SandboxYouTubeResult[] }

export interface SandboxTranscriptionRun {
  projectId: string;
  conversationId: string;
  status: string;
  externalJobId: string | null;
  note: string;
}
export interface SandboxConversation {
  id: string;
  status: string;
  externalJobId: string | null;
  segments: number;
  participants: number;
  updatedAt: string;
}

export interface SandboxQueueItem {
  id: string;
  youtubeVideoId: string;
  title: string;
  status: string;
  conversationId: string | null;
  /** Причина последнего отказа автоматического разбора (если был). */
  autoAnalysisError: string | null;
  /** Итог разбора: сколько сегментов транскрипта записано. */
  segments: number;
  /** Итог разбора: сколько сигналов найдено (честный 0 допустим). */
  signals: number;
  /** Длительность ролика из метаданных YouTube — основа оценки времени разбора. */
  durationSeconds: number | null;
  channelName: string | null;
  publishedAt: string | null;
  addedAt: string | null;
  /** Статус Conversation — вторая ось прогресса (TRANSCRIBING/ANALYZING/…). */
  conversationStatus: string | null;
  /** Факты о джобе для PROCESSING (провайдер прогресса не отдаёт —
   * процент оценивается на клиенте и помечается как «≈»). */
  job: {
    status: string;
    startedAt: string;
    submitted: boolean;
    retryCount: number;
    note: string | null;
    leaseExpiresAt: string | null;
  } | null;
}
export interface SandboxQueue {
  id: string;
  title: string;
  items: SandboxQueueItem[];
}
export interface SandboxAnalysisSignal {
  type: string;
  channel: string | null;
  confidence: number | null;
}
export interface SandboxAnalysisSegment {
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
  signals: SandboxAnalysisSignal[];
}
export interface SandboxAnalysis {
  language: string | null;
  segments: SandboxAnalysisSegment[];
}
export interface FactCheckMatch {
  claim: string;
  claimant: string | null;
  rating: string | null;
  publisher: string | null;
  url: string | null;
  reviewDate: string | null;
}
// Пункт [fact-check-ai-fallback] 2026-09-01 — гипотеза модели с
// веб-поиском, когда база фактчеков промолчала. НЕ рейтинг фактчекера.
export interface AiFactCheckHypothesis {
  verdict: 'SUPPORTED' | 'CONTRADICTED' | 'DISPUTED' | 'UNVERIFIABLE';
  confidence: number;
  rationale: string;
  sources: string[];
}
export interface FactCheckSegmentResult {
  segmentId: string;
  startMs: number;
  text: string;
  matches: FactCheckMatch[];
  /** Пункт [fact-check-unmask] 2026-09-01 — причина сбоя поиска по
   * этому сегменту (null = поиск прошёл). Раньше сбой выглядел как
   * «совпадений: 0» — маскировал невключённый API. */
  error: string | null;
  ai: AiFactCheckHypothesis | null;
}
export interface SandboxIntakeState {
  id: string;
  status: string;
  answers: Array<{ question: string | null; text: string; at: string }>;
  followUpsAsked: number;
  followUpsLeft: number;
  nextQuestion: string | null;
  decision: { scenario: string; suggestedScenario: string; confidence: number; belowThreshold: boolean } | null;
  extracted: { question: string; goal: string | null; facts: string[]; contractType: string | null } | null;
  chosenScenario: string | null;
  dispatchedProjectId: string | null;
  projectId?: string;
  conversationId?: string | null;
}
// Пункт [sandbox-major-purchase] 2026-09-01 — этап 1 доменного покрытия.
export interface SandboxMpDraft {
  goalDescription: string;
  budgetMin: number | null;
  budgetMax: number | null;
  currency: string | null;
  financingMethod: string | null;
  timeline: string | null;
  criteria: Array<{ text: string; isRequired: boolean; orderIndex: number }>;
}
export interface SandboxMpComparison {
  criteria: Array<{ id: string; text: string; isRequired: boolean }>;
  variants: Array<{
    id: string;
    label: string;
    askingPrice: number | null;
    currency: string | null;
    placeName: string | null;
    placeAddress: string | null;
    comparisonCount: number;
    latestConclusion: string | null;
    criteriaBreakdown: unknown | null;
  }>;
}
// Пункт [sandbox-investment] 2026-09-01 — этап 2 доменного покрытия.
export interface SandboxInvDraft {
  goalDescription: string;
  targetBudget: number | null;
  currency: string | null;
  criteria: Array<{ text: string; category: string; isRequired: boolean; orderIndex: number }>;
}
export interface SandboxInvComparison {
  criteria: Array<{ id: string; text: string; isRequired: boolean }>;
  opportunities: Array<{
    id: string;
    label: string;
    advisorName: string | null;
    advisorCompany: string | null;
    meetingsCount: number;
    comparisonCount: number;
    latestBreakdown: unknown | null;
  }>;
}
export interface SandboxInvGroupSmoke {
  groupId: string;
  groupName: string;
  inviteTokenIssued: boolean;
  inviteExpiresAt: string;
  rejoinIdempotent: boolean;
  pledgedAmount: number;
  myGroupsCount: number;
  notes: string;
}
// Пункт [sandbox-interview-pool] 2026-09-01 — этап 3 доменного покрытия.
export interface SandboxIpDraft {
  jobTitle: string;
  extendedDescription: string;
  salaryRange: string | null;
  employmentLoad: string | null;
  workArrangement: string | null;
  officeLocation: string | null;
  employmentFormat: string | null;
  perks: string[];
  genderRequirement: string;
  ageRequirement: string;
  minAge: number | null;
  maxAge: number | null;
  isPhysicallyDemanding: boolean;
  interviewStages: Array<{ name: string; orderIndex: number; isTestAssignment: boolean; interviewerRole: string | null }>;
  complianceFlags: Array<{ category: string; quotedText: string }>;
}
export interface SandboxIpQuestionnaireItem {
  text: string;
  category: string | null;
  orderIndex: number;
  isRequired: boolean;
}
export interface SandboxIpRelevance {
  snapshotId: string | null;
  entries: Array<{ candidate: string; attentionPoints: string[]; followUpRequestsDraft: string[] }>;
  note: string | null;
}
export interface SandboxIpSummaryReport {
  reportId: string;
  content: {
    funnel: { totalCandidates: number; byStage: Record<string, number> };
    entries: Array<{ candidateProfileId: string; displayName: string; stage: string; coverageScore: number }>;
  };
}
export interface SandboxIpTeamSmoke {
  teamId: string;
  teamName: string;
  inviteTokenIssued: boolean;
  rejoinIdempotent: boolean;
  myTeamsCount: number;
  notes: string;
}
// Пункт [sandbox-family-law] 2026-09-01 — этап 4 доменного покрытия.
export interface SandboxFlDraft {
  goalDescription: string;
  targetBudget: number | null;
  currency: string | null;
  criteria: Array<{ text: string; category: string; isRequired: boolean; orderIndex: number }>;
}
export interface SandboxFlBudget {
  lineItems: Array<{ id: string; category: string; direction: string; amount: number; currency: string | null; description: string | null }>;
  byCurrency: Array<{ currency: string; totalExpense: number; totalCoverage: number; netBudget: number }>;
  targetBudget: number | null;
  currency: string | null;
}
export interface SandboxFlSettlementDraft {
  text: string;
  generatedAt: string;
  disclaimer: string;
}
// Пункт [sandbox-dtp] 2026-09-01 — этап 5 доменного покрытия.
export interface SandboxDtpDraft {
  goalDescription: string;
  targetBudget: number | null;
  currency: string | null;
  occurredAt: string | null;
  criteria: Array<{ text: string; category: string; isRequired: boolean; orderIndex: number }>;
}
export interface SandboxDtpEvidence {
  evidenceId: string;
  fileHash: string;
  mediaType: string;
  capturedAt: string;
  accessLog: Array<{ action: string; at: string }>;
}
// Пункт [job-search] 2026-09-01 — седьмой домен: CV + вакансии.
export interface SandboxJsDraft {
  desiredRole: string;
  city: string | null;
  region: string | null;
  salaryExpectation: number | null;
  currency: string | null;
  employmentFormat: string | null;
  experienceSummary: string | null;
  criteria: Array<{ text: string; category: string; isRequired: boolean; orderIndex: number }>;
}
export interface SandboxJsCv {
  cvText: string | null;
  cvDraft: unknown;
  cvDraftedAt: string | null;
}
export interface SandboxJsVacancyMatch {
  id: string;
  title: string | null;
  locationMatch: 'MATCHES' | 'DIFFERENT' | 'UNKNOWN' | null;
  salaryMentioned: string | null;
  matchBreakdown: unknown;
  matchNotes: string | null;
}
export interface SandboxJsStatistics {
  total: number;
  matched: number;
  bySite: Record<string, number>;
  byLocationMatch: Record<string, number>;
  withSalaryMentioned: number;
  requiredCriteriaCount: number;
  fullRequiredCoverage: number;
  city: string | null;
  region: string | null;
}
export interface SandboxHealthDraft {
  goalDescription: string;
  targetBudget: number | null;
  currency: string | null;
  criteria: Array<{ text: string; category: string; isRequired: boolean; orderIndex: number }>;
}
export interface SandboxDiagnosis {
  verdict: string;
  steps: string[];
  fixedMissingLease: boolean;
  pollResult: { completed: number; failed: number; waiting: number } | null;
  inspection: {
    jobStatus: string;
    retryCount: number;
    submitted: boolean;
    leaseExpiresAt: string | null;
    note: string | null;
    providerStatus: string | null;
    providerError: string | null;
  } | null;
}
// Пункт [db-state] 2026-09-01 — вкладка «БД»: секция либо данные, либо
// { error } (локальная БД без pg_cron/pg_net — честная ошибка секции,
// не пустая страница).
export type DbStateSection<T> = T | { error: string };
export interface DbStateCronJob {
  jobname: string;
  schedule: string;
  active: boolean;
}
export interface DbStateCronRun {
  jobname: string;
  status: string;
  returnMessage: string | null;
  startTime: string | null;
  endTime: string | null;
}
export interface DbStateHttpResponse {
  statusCode: number | null;
  content: string | null;
  timedOut: boolean | null;
  errorMsg: string | null;
  created: string;
}
export interface DbStateAiJobs {
  byStatus: Record<string, number>;
  recent: Array<{
    id: string;
    taskType: string | null;
    status: string;
    retryCount: number;
    submitted: boolean;
    leaseExpiresAt: string | null;
    note: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}
export interface AdminDbState {
  generatedAt: string;
  cronJobs: DbStateSection<DbStateCronJob[]>;
  cronRuns: DbStateSection<DbStateCronRun[]>;
  httpResponses: DbStateSection<DbStateHttpResponse[]>;
  aiJobs: DbStateSection<DbStateAiJobs>;
}
export interface SandboxFactCheck {
  language: string | null;
  checkedSegments: number;
  totalSegments: number;
  apiKeyPresent: boolean;
  aiFallbackUsed: boolean;
  aiCheckedSegments: number;
  aiError: string | null;
  results: FactCheckSegmentResult[];
}

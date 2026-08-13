// apps/tma: типы домена, зеркалящие Prisma-модели бэкенда.
// Ручное зеркалирование, не codegen — схема ещё меняется достаточно
// часто, чтобы генератор давал больше шума, чем пользы; пересмотреть
// после стабилизации схемы в конце MVP v1.

export interface Project {
  id: string;
  question: string;
  goal: string | null;
  // Пункт 56 (backend) — null = не вынесен на публичное обсуждение.
  publicShareToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListItem extends Project {
  _count: { arguments: number; people: number };
}

export interface ProjectListResponse {
  items: ProjectListItem[];
  total: number;
  take: number;
  skip: number;
}

export interface ProjectDetail extends Project {
  arguments: Argument[];
  // Пункт 57 — присутствует, если проект уже отправлен в публичную
  // библиотеку (независимо от статуса модерации).
  libraryEntry: LibraryEntry | null;
}

export interface DecisionObjective {
  id: string;
  projectId: string;
  desiredOutcome: string | null;
  idealOutcome: string | null;
  minimumAcceptableOutcome: string | null;
  unacceptableOutcome: string | null;
  deadline: string | null;
  constraints: string[];
  nonNegotiables: string[];
  negotiables: string[];
  doNotSay: string[];
}

export type PersonStatus = 'PERSONA' | 'FIGURANT';

export interface Person {
  id: string;
  displayName: string | null;
}

export interface ProjectPersonLink {
  personId: string;
  status: PersonStatus;
  person: Person;
}

export interface SteelmanCase {
  id: string;
  projectId: string;
  personId: string;
  strongestArgument: string;
  reasonableness: string | null;
  whatUserMayMiss: string | null;
  createdAt: string;
}

export interface NegotiationBoundaries {
  id: string;
  projectId: string;
  idealOutcome: string | null;
  acceptableOutcome: string | null;
  batna: string | null;
  watna: string | null;
  walkAwayPoint: string | null;
}

export interface ConversationCard {
  project: { question: string; goal: string | null };
  objective: DecisionObjective | null;
  boundaries: NegotiationBoundaries | null;
  topArguments: Argument[];
  doNotSay: string[];
  // Пункт 18 (backend) — AI-детекция риска из прошлых разговоров
  // (§3.53/§3.17 ТЗ), отдельно от doNotSay выше (ручной список).
  selfRiskWarnings: SelfRiskWarning[];
  // Пункт 22 (backend) — §3.57 ТЗ, детерминированная выборка устаревших
  // фактов по всем фигурантам проекта.
  staleFacts: StaleFactWarning[];
  // Пункт 27/28 (backend) — раздел 2 ТЗ, "туз в рукаве / план Б" и
  // "повестка следующего разговора" — последний честно
  // зафиксированный пробел карточки, теперь закрыт.
  agenda: string[];
  protectedNotes: ProtectedNote[];
  openingScript: string | null;
  closingScript: string | null;
}

export interface SelfRiskWarning {
  id: string;
  riskCategory: 'ESCALATION' | 'LEVERAGE';
  why: string | null;
  saferAlternative: string | null;
}

export type ConversationScriptType = 'OPENING' | 'CLOSING';

export interface PrivacyOverview {
  consents: ConsentRecord[];
  projectsCount: number;
  people: Array<{
    id: string;
    displayName: string | null;
    factsCount: number;
    projectsCount: number;
  }>;
}

export interface SafeSharePreflightResult {
  safeShareActionId: string;
  blocked: boolean;
  sanitizedText: string;
  detectedItemsCount: number;
}

export interface SafeShareLogEntry {
  id: string;
  contentType: string;
  previewShownAt: string;
  sentAt: string | null;
  detectedItemsCount: number;
  createdAt: string;
}

export interface RetentionClassInfo {
  classKey: string;
  displayName: string;
  description: string;
  defaultRetentionDays: number | null;
  userOverrideAllowed: boolean;
  legalHold: boolean;
  deletionBehavior: string;
}

export interface OnboardingData {
  religion: string | null;
  city: string | null;
  // Пункт 49 — по прямому запросу, сознательно отменяющему более
  // раннее P0-решение против гео-автоподсказки. См. обоснование в
  // apps/api/prisma/README.md, «Пункт 49».
  country: string | null;
  // Пункт 64 — переиспользован этот же "профиль пользователя" тип,
  // не заведён отдельный.
  alwaysShowQuote: boolean;
  alwaysShowAnecdote: boolean;
  // Пункт 68 — та же логика переиспользования.
  religiousReminderFrequency: ReligiousReminderFrequency;
}

export interface LocationSuggestion {
  country: string | null;
  city: string | null;
  suggestedReligion: string | null;
  reasoning: string | null;
}

export interface AvailableEngine {
  modelVersionId: string;
  providerName: string;
  modelName: string;
  version: string;
  latencyClass: string | null;
  costClass: string | null;
}

export type ArgumentStance = 'PRO' | 'CON';

export type ArgumentLifecycleStatus =
  | 'DRAFT'
  | 'TESTED'
  | 'USED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'COUNTERED'
  | 'EXPIRED'
  | 'VERIFIED';

export interface Argument {
  id: string;
  projectId: string;
  text: string;
  stance: ArgumentStance;
  weight: number | null;
  // Пункт 23 (backend) — раньше существовало в схеме с чекпоинта 1, но
  // не было экспонировано в TMA (не было и способа его изменить).
  lifecycleStatus: ArgumentLifecycleStatus;
  createdAt: string;
}

export interface ArgumentLifecycleEvent {
  id: string;
  argumentId: string;
  fromStatus: ArgumentLifecycleStatus | null;
  toStatus: ArgumentLifecycleStatus;
  conversationId: string | null;
  note: string | null;
  createdAt: string;
}

export interface ArgumentFailureInsight {
  failureCount: number;
  insight: string | null;
}

// Пункт 24 (backend) — Open Loops (§3.59 ТЗ). Не персистится — чистая
// агрегация уже существующих данных (Commitment/Argument/
// MissingInformationCheck/SourceConflict), пересчитывается на каждый
// запрос (см. open-loops.service.ts на бэкенде).
export interface OpenLoopsSummary {
  unansweredQuestionsCount: number;
  openCommitmentsCount: number;
  pendingDecisionsCount: number;
  unresolvedObjectionsCount: number;
  details: {
    missingInformationQuestions: string[];
    unresolvedConflictQuestions: string[];
    openCommitments: Array<{ id: string; description: string }>;
    pendingDecisions: Array<{ id: string; text: string }>;
    unresolvedObjections: Array<{ id: string; text: string }>;
  };
}

// Пункт 25 (backend) — Prediction vs Reality (§3.60 ТЗ).
export interface Prediction {
  id: string;
  projectId: string;
  predictedOutcome: string;
  predictedAt: string;
  actualOutcome: string | null;
  actualOutcomeRecordedAt: string | null;
  difference: string | null;
  lesson: string | null;
  generatedByInferenceId: string | null;
  createdAt: string;
}

export type ConsentType =
  | 'RECORDING'
  | 'EXTERNAL_AI'
  | 'EPHEMERAL_SERVER'
  | 'LOCATION'
  | 'RELIGIOUS_CONTENT'
  | 'PUBLIC_SHARING'
  | 'PERSON_RESEARCH'
  | 'VOICE_PROCESSING'
  // Пункт 48 (backend) — отдельный тип согласия, не переиспользующий
  // формулировку EPHEMERAL_SERVER (см. schema.prisma).
  | 'PUBLIC_IMAGE_SEARCH'
  // Пункт 87 (backend) — отдельный от VOICE_PROCESSING тип согласия
  // для персистентного биометрического отпечатка (см. schema.prisma).
  | 'VOICE_BIOMETRIC';

export interface ConsentRecord {
  id: string;
  consentType: ConsentType;
  granted: boolean;
  purposes: string[];
}

export interface BootstrapResponse {
  userId: string;
  privacyProcessingMode: string;
  isNewUser: boolean;
  serverTime: string;
  disclaimerAcknowledged: boolean;
}

export interface DisclaimerStatus {
  acknowledged: boolean;
  currentVersion: string;
  acknowledgedVersion: string | null;
}

// Пункт 13 (backend) — Conversation Dossier (раздел 2 ТЗ, MVP v2).
export type ConversationSourceType =
  | 'LIVE_RECORDING'
  | 'UPLOADED_AUDIO'
  | 'UPLOADED_VIDEO'
  | 'UPLOADED_PHOTO';

export type ConversationProcessingStatus =
  | 'UPLOADED'
  | 'TRANSCRIBING'
  | 'TRANSCRIBED'
  | 'ANALYZING'
  | 'ANALYZED'
  | 'FAILED';

export interface Conversation {
  id: string;
  projectId: string;
  sourceType: ConversationSourceType;
  status: ConversationProcessingStatus;
  occurredAt: string;
  durationSeconds: number | null;
  rawFileRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationParticipant {
  id: string;
  conversationId: string;
  diarizationLabel: string;
  personId: string | null;
  isSelf: boolean;
  person: Person | null;
}

export interface TranscriptSegment {
  id: string;
  transcriptId: string;
  participantId: string | null;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
}

export interface Transcript {
  id: string;
  conversationId: string;
  language: string | null;
  segments: TranscriptSegment[];
}

export interface ConversationDetail extends Conversation {
  participants: ConversationParticipant[];
  transcript: Transcript | null;
}

// Пункт 26 (backend) — сопоставление диаризации фигурантам.
export interface AssignParticipantInput {
  personId?: string;
  isSelf?: boolean;
}

// Пункт 27 (backend) — повестка следующего разговора (раздел 2 ТЗ).
export interface ConversationAgenda {
  id: string;
  projectId: string;
  items: string[];
  generatedByInferenceId: string | null;
  createdAt: string;
  updatedAt: string;
}

// Пункт 28 (backend) — защищённые заметки (раздел 2 ТЗ).
export type ProtectedNoteType = 'ACE_IN_THE_HOLE' | 'FALLBACK_PLAN';

export interface ProtectedNote {
  id: string;
  projectId: string;
  type: ProtectedNoteType;
  content: string;
  triggerCondition: string | null;
  planOrder: number | null;
  createdAt: string;
  updatedAt: string;
}

// Пункт 14 (backend) — Commitment Tracker (§3.49 ТЗ).
export type CommitmentOwner = 'USER' | 'FIGURANT';
export type CommitmentStatus = 'IN_PROGRESS' | 'COMPLETED';

export interface Commitment {
  id: string;
  projectId: string;
  personId: string;
  owner: CommitmentOwner;
  description: string;
  dueDate: string | null;
  status: CommitmentStatus;
  completedAt: string | null;
  isOverdue: boolean;
  createdAt: string;
  updatedAt: string;
}

// Пункт 15 (backend) — Turning Point Detection (§3.50 ТЗ). Не новая
// модель — ConversationSignal(EMOTIONAL_SHIFT|ARGUMENT_ACCEPTANCE) с
// восстановленным из общего AIInference описанием (см.
// TurningPointsService.list() на бэкенде).
export type TurningPointSignalType = 'EMOTIONAL_SHIFT' | 'ARGUMENT_ACCEPTANCE';

export interface TurningPoint {
  id: string;
  signalType: TurningPointSignalType;
  transcriptSegmentId: string | null;
  confidence: number | null;
  confirmedGenuinely: boolean | null;
  description: string | null;
}

// Пункт 16 (backend) — Missing Information (§3.51 ТЗ).
export interface MissingInformationCheck {
  id: string;
  projectId: string;
  questions: string[];
  generatedByInferenceId: string | null;
  createdAt: string;
}

// Пункт 17 (backend) — Evidence Gap (§3.52 ТЗ). Не персистится — чистая
// классификация уже существующих Argument по существующим полям
// (см. evidence-gap.service.ts на бэкенде), пересчитывается на каждый запрос.
export type EvidenceGapCategory = 'KNOWN' | 'SUPPORTED' | 'ASSUMED' | 'UNKNOWN' | 'CONTRADICTORY' | 'STALE';

export interface ClassifiedArgument {
  id: string;
  text: string;
  stance: string;
  category: EvidenceGapCategory;
}

export interface EvidenceGapReport {
  promptToUser: string;
  breakdown: Record<EvidenceGapCategory, ClassifiedArgument[]>;
}

// Пункт 18 (backend) — Do Not Say (§3.53 ТЗ). Детекция по одному
// разговору — та же форма, что TurningPoint, плюс два текстовых поля
// (why/saferAlternative вместо одного description).
export interface DoNotSayItem {
  id: string;
  transcriptSegmentId: string | null;
  riskCategory: 'ESCALATION' | 'LEVERAGE';
  why: string | null;
  saferAlternative: string | null;
}

// Пункт 19 (backend) — Best Next Move (§3.54 ТЗ).
export interface BestNextMoveRecommendation {
  id: string;
  conversationId: string;
  bestAction: string;
  alternative: string;
  avoid: string;
  why: string;
  whyNotAlternative: string | null;
  whatCouldChange: string | null;
  generatedByInferenceId: string | null;
  createdAt: string;
}

// Пункт 21 (backend) — Source Conflict Resolver (§3.56 ТЗ).
export interface SourceConflict {
  id: string;
  personId: string;
  factAId: string;
  factBId: string;
  factA: { id: string; content: string; sourceType: string };
  factB: { id: string; content: string; sourceType: string };
  conflictDescription: string;
  possibleExplanations: string[];
  clarifyingQuestion: string;
  resolvedAt: string | null;
  createdAt: string;
}

// Пункт 22 (backend) — Stale Fact Alert (§3.57 ТЗ). Не персистится —
// детерминированная выборка по PersonFact.lastVerifiedAt, пересчитывается
// на каждый запрос (см. stale-fact.service.ts на бэкенде).
export interface StaleFactWarning {
  id: string;
  personId: string;
  personDisplayName: string | null;
  content: string;
  lastVerifiedAt: string | null;
  ageInDays: number;
}

// Пункт 36 (backend) — Manipulation Detector (§3.28 ТЗ, MVP v3, первая
// из фич v3, отобранных как готовые без новой инфраструктуры).
export interface ManipulationPoint {
  id: string;
  transcriptSegmentId: string | null;
  confidence: number | null;
  technique: string | null;
  description: string | null;
}

// Пункт 37 (backend) — Discrepancy Analysis (§3.16 ТЗ, MVP v3, вторая
// из фич v3). Честно ограничена: сверка с "публично доступными
// фактами" не реализована — нужен внешний поиск, которого в
// приложении нет.
export type DiscrepancySeverity = 'INACCURACY' | 'DISCREPANCY' | 'STRONG_DISCREPANCY';

export interface DiscrepancySignal {
  id: string;
  transcriptSegmentId: string | null;
  severity: DiscrepancySeverity | null;
  userConfirmedIntentionalFalsehood: boolean;
  sourceDescription: string | null;
}

// Пункт 38 (backend) — Archetype Perspective Simulation (§3.11 ТЗ,
// MVP v3, третья и последняя из фич этого захода). Честно ограничена:
// только ветка "архетипы", не "реальные фигуранты с коммуникационным
// профилем" — того поля в схеме нет.
export type ArchetypeType =
  | 'POLICE_OFFICER'
  | 'LAWYER'
  | 'NEIGHBORHOOD_GRANDMOTHER'
  | 'FINANCIAL_ANALYST'
  | 'PSYCHOLOGIST'
  | 'CHILD'
  | 'JEALOUS_SPOUSE'
  | 'TROUBLEMAKER'
  | 'CUSTOM'
  // Пункт 46 — вторая ветка §3.11 ТЗ ("глазами реальных фигурантов"),
  // ранее честно отложенная при построении архетипов.
  | 'REAL_PERSON';

export interface ArchetypePerspective {
  id: string;
  projectId: string;
  archetypeType: ArchetypeType;
  customArchetypeDescription: string | null;
  targetPersonId: string | null;
  // Пункт 54 (backend) — §3.17 ТЗ, "тот же механизм, развёрнутый на
  // 180°": true = критика собственной позиции пользователя, не
  // обычная реакция на ситуацию.
  focusOnOwnPositionWeaknesses: boolean;
  reaction: string;
  createdAt: string;
}

// Пункт 39 (backend) — Communication Profile (§3.11 ТЗ текст,
// роадмап-пункт 24 v3). Закрывает пробел, зафиксированный в Пункте 38
// — "глазами реальных фигурантов" требовала этого поля.
export type CommunicationTraitType =
  | 'PREFERS_WRITTEN_COMMUNICATION'
  | 'PREFERS_DIRECTNESS'
  | 'NEEDS_TIME_TO_DECIDE'
  | 'RESPONDS_TO_DATA'
  | 'CONFLICT_AVOIDANCE'
  | 'DECISION_MAKING_STYLE';

export interface PersonCommunicationTrait {
  id: string;
  personId: string;
  traitType: CommunicationTraitType;
  value: string;
  confidence: number | null;
  observedFrom: string;
  lastObservedAt: string;
}

// Пункт 40 (backend) — четвёртый источник сверки §3.16 ТЗ ("публично
// доступные факты"), ручная вставка ссылки пользователем вместо
// автономного поиска (см. обоснование в discrepancy-analysis.service.ts).
export type SourceCheckOutcome = 'CONFIRMED' | 'CONTRADICTED' | 'INSUFFICIENT';

export interface SourceCheckResult {
  outcome: SourceCheckOutcome;
  explanation: string;
  sourceUrl: string;
  signal: DiscrepancySignal | null;
}

// Пункт 41 (backend) — выгрузка пронумерованного списка утверждений
// для ручной проверки, вместо автономного поиска.
export interface FactsToVerifyExport {
  text: string;
  count: number;
}

// Пункт 43 (backend) — Relationship (§3.13 ТЗ), "первый слой" графа
// связей между фигурантами (по итогам разбора выполнимости пунктов
// 20/23 v3-роадмапа). sourceType — та же строка, что уже используется
// для PersonFact в этом файле (см. SourceConflict.factA.sourceType) —
// не заводится отдельный строгий union ради единственного нового места.
export type RelationshipType = 'FAMILY' | 'HIERARCHY' | 'SOCIAL';
export type RelationshipDirection = 'A_TO_B' | 'B_TO_A' | 'MUTUAL';

export interface Relationship {
  id: string;
  personAId: string;
  personBId: string;
  personA?: { id: string; displayName: string | null };
  personB?: { id: string; displayName: string | null };
  type: RelationshipType;
  label: string;
  direction: RelationshipDirection;
  strength: number | null;
  sourceType: string;
  createdAt: string;
}

export interface RelationshipSuggestion {
  personAId: string;
  personBId: string;
  personA?: { id: string; displayName: string | null };
  personB?: { id: string; displayName: string | null };
  sharedConversations: number;
}

// Пункт 44 (backend) — Stakeholder Map (§3.8 ТЗ), доводит до конца
// пункт 20 v3-роадмапа. Визуализация графа НЕ реализована (сама ТЗ
// называет её опциональной) — только роли + аргументы под каждого.
export type StakeholderRole = 'DECISION_MAKER' | 'ADVISOR' | 'BLOCKER' | 'ALLY';

export interface RoleSuggestion {
  personId: string;
  role: StakeholderRole;
  reasoning: string;
}

export interface GapSuggestion {
  roleHint: string;
  reasoning: string;
}

export interface SuggestRolesResult {
  roleSuggestions: RoleSuggestion[];
  gapSuggestions: GapSuggestion[];
}

export interface TargetedArgument {
  id: string;
  text: string;
  stance: 'PRO' | 'CON';
  weight: number | null;
  targetPersonId: string;
}

export interface StakeholderMapEntry {
  personId: string;
  displayName: string | null;
  role: StakeholderRole;
  arguments: TargetedArgument[];
}

// Пункт 45 (backend) — Precedent Search (§3.9 ТЗ), реализует ПОЛОВИНУ
// пункта 21 v3-роадмапа — только из личных записей пользователя,
// без публичного поиска (см. подробное обоснование в
// apps/api/prisma/README.md, «Пункт 45»).
export type PrecedentSimilarity = 'ANALOGOUS' | 'PARTIALLY_SIMILAR' | 'CONTRASTING';

export interface BehaviorPrecedent {
  id: string;
  personId: string;
  situationDescription: string;
  precedentDescription: string;
  similarity: PrecedentSimilarity;
  sourceDescription: string;
  createdAt: string;
}

export interface PrecedentSearchResult {
  precedents: BehaviorPrecedent[];
  total: number;
  analogousCount: number;
  conclusion: string;
}

// Пункт 47 (backend) — Outcome Forecasting (§3.12 ТЗ), доводит пункт
// 23 v3-роадмапа до конца, последний в группе 20-23. Ни одного нового
// источника данных — синтезирует уже построенное (аргументы, роль
// решающего, связи, прецеденты, защищённые заметки).
export type ScenarioType = 'DO_NOTHING' | 'ASSUME_HARM' | 'ASSUME_HELP' | 'USER_DEFINED';
export type ScenarioConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface OutcomeScenario {
  id: string;
  projectId: string;
  scenarioType: ScenarioType;
  userDescription: string | null;
  outcomeDescription: string;
  precedentBasis: string | null;
  protectedNoteHint: string | null;
  confidence: ScenarioConfidence;
  createdAt: string;
}

// Пункт 48 (backend) — Photo Verification (§4.4 ТЗ, пункт 33
// v3-роадмапа). Требует отдельного согласия PUBLIC_IMAGE_SEARCH —
// фото временно становится публично доступным в интернете (не просто
// отправляется на наш сервер), см. подробное обоснование в
// apps/api/prisma/README.md, «Пункт 48».
export type PhotoVerificationStatus = 'NO_SIMILAR_IMAGES_FOUND' | 'SIMILAR_IMAGES_FOUND';

export interface PhotoVerification {
  id: string;
  personFactId: string;
  verificationStatus: PhotoVerificationStatus;
  similarity: number | null;
  sourceUrl: string | null;
  sourceDate: string | null;
  matchType: string | null;
  contextDifference: string | null;
  createdAt: string;
}

// Пункт 49 (backend) — Reconciliation Arguments (§3.14 ТЗ). Тот же
// ArgumentStance/Argument, что и обычные за/против — не параллельная
// модель, поэтому переиспользует существующий Argument, не новый тип.
export interface ReconciliationArgument {
  id: string;
  projectId: string;
  stance: 'RECONCILIATION';
  text: string;
  scriptureReference: string | null;
  createdAt: string;
}

// Пункт 50 (backend) — Scheduler (§3.20 ТЗ), пункт 30 v3-роадмапа.
// Не расширение Conversation — разговор ещё не состоялся, отдельная
// модель (см. обоснование в apps/api/prisma/README.md, «Пункт 50»).
export interface ScheduledConversation {
  id: string;
  projectId: string;
  personId: string | null;
  person: { id: string; displayName: string | null } | null;
  scheduledAt: string;
  sparringReminderMinutesBefore: number | null;
  sparringReminderSentAt: string | null;
  postMortemReminderSentAt: string | null;
  linkedConversationId: string | null;
  linkedConversation: { id: string; occurredAt: string } | null;
  createdAt: string;
}

// Пункт 52 (backend) — Decision Track Record (§3.2 ТЗ), пункт 35
// v3-роадмапа. "Показывает когнитивные искажения" реализовано как
// РЕАЛЬНАЯ вычисленная статистика (прогноз vs факт), не AI-догадка о
// психологии пользователя — см. подробное обоснование в
// apps/api/prisma/README.md, «Пункт 52».
export type DecisionOutcomeRating = 'WENT_WELL' | 'WENT_POORLY' | 'MIXED' | 'TOO_EARLY_TO_TELL';

export interface DecisionOutcome {
  id: string;
  projectId: string;
  predictedLean: number | null;
  actualOutcome: DecisionOutcomeRating;
  outcomeNotes: string | null;
  category: string | null;
  recordedAt: string;
}

export interface CategoryCalibrationStats {
  category: string | null;
  sampleSize: number;
  matchCount: number;
  overOptimisticCount: number;
  overCautiousCount: number;
  matchRate: number;
}

export interface CalibrationSummary {
  totalRecorded: number;
  overall: CategoryCalibrationStats;
  byCategory: CategoryCalibrationStats[];
}

// Пункт 55 (backend) — Sparring / Red Team (§3.1 ТЗ), пункт 34
// v3-роадмапа. Ключевое отличие от одноразовых генераций (Steelman,
// ArchetypePerspective) — многоходовой диалог.
export type SparringSessionStatus = 'ACTIVE' | 'ENDED';
export type SparringMessageRole = 'OPPONENT' | 'USER';

export interface SparringMessage {
  id: string;
  sessionId: string;
  role: SparringMessageRole;
  text: string;
  // Пункт 90 (backend) — озвучка реплики оппонента, уже предзаготовлена
  // сервером через ElevenLabs. null при role=USER, либо если синтез
  // не удался — честная деградация, текст всегда доступен независимо.
  audioBase64: string | null;
  createdAt: string;
}

export interface SparringSession {
  id: string;
  projectId: string;
  targetPersonId: string | null;
  targetPerson?: { id: string; displayName: string | null } | null;
  status: SparringSessionStatus;
  endedAt: string | null;
  createdAt: string;
  messages?: SparringMessage[];
  // Пункт 69 (backend) — §3.26 ТЗ: выбор архетипа + снапшот голоса.
  archetypeType: ArchetypeType | null;
  customArchetypeDescription: string | null;
  voiceId: string | null;
}

export type SparringVoiceReplyStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface SparringVoiceReplyJob {
  id: string;
  sparringSessionId: string;
  status: SparringVoiceReplyStatus;
  userMessageId: string | null;
  opponentMessageId: string | null;
  errorMessage: string | null;
  createdAt: string;
}

// Пункт 56 (backend) — Public Discussion (§4.3/§4.5 ТЗ), пункт 32
// v3-роадмапа. "Участники видят только Argument, доступа к PersonFact
// нет" — PublicDiscussionView никогда не содержит фактов/файлов,
// только вопрос проекта и уже принятые/поданные аргументы.
export type PublicSubmissionStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export interface PublicParticipant {
  id: string;
  projectId: string;
  displayName: string | null;
  createdAt: string;
}

export interface PublicArgumentSubmission {
  id: string;
  projectId: string;
  participantId: string | null;
  participant?: PublicParticipant | null;
  text: string;
  stance: 'PRO' | 'CON';
  status: PublicSubmissionStatus;
  upvotes: number;
  downvotes: number;
  promotedToArgumentId: string | null;
  createdAt: string;
}

export interface PublicComment {
  id: string;
  projectId: string;
  participantId: string | null;
  participant?: PublicParticipant | null;
  text: string;
  createdAt: string;
}

export interface PublicDiscussionView {
  question: string;
  goal: string | null;
  arguments: Argument[];
  submissions: PublicArgumentSubmission[];
  comments: PublicComment[];
  // Пункт 80 (backend) — узкий read-only объём командного режима
  // (пункт 38 общего списка), согласовано явно перед реализацией.
  // Оба null, если ничего не сгенерировано владельцем проекта.
  protocol: { summaryText: string; createdAt: string } | null;
  closingMessage: {
    summaryText: string;
    quoteText: string | null;
    quoteSourceReference: string | null;
    createdAt: string;
  } | null;
}

// Пункт 57 (backend) — Library (§3.5 ТЗ), пункт 36 v3-роадмапа.
// Snapshot-семантика — LibraryArgument не ссылается на живой Argument,
// хранит копию текста на момент отправки в библиотеку.
export type LibraryModerationStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export interface LibraryArgument {
  id: string;
  libraryEntryId: string;
  text: string;
  stance: 'PRO' | 'CON';
}

export interface LibraryExperience {
  id: string;
  libraryEntryId: string;
  text: string;
  authorDisplayName: string | null;
  createdAt: string;
}

export interface LibraryEntry {
  id: string;
  title: string;
  category: string;
  sourceProjectId: string | null;
  status: LibraryModerationStatus;
  upvotes: number;
  downvotes: number;
  createdAt: string;
  arguments?: LibraryArgument[];
  experiences?: LibraryExperience[];
}

// Пункт 58 (backend) — PersonFact create/list (§4.2/§3.19 ТЗ), пункт
// 29 v3-роадмапа. hasGeoTag/metadataStripped вычисляются ЦЕЛИКОМ на
// клиенте (см. lib/exif-check.ts), backend только сохраняет результат.
export type FactScope = 'PROJECT' | 'PERSON_GLOBAL' | 'PRIVATE_TO_USER' | 'PUBLIC_DERIVED_ONLY';
export type FactSourceType = 'PUBLIC_FACT' | 'PERSONAL_RECORD' | 'USER_GUESS';

export interface FactSource {
  id: string;
  personFactId: string;
  fileRef: string | null;
  url: string | null;
  hasGeoTag: boolean | null;
  metadataStripped: boolean | null;
  createdAt: string;
}

export interface PersonFact {
  id: string;
  personId: string;
  projectId: string | null;
  scope: FactScope;
  content: string;
  sourceType: FactSourceType;
  confidence: number | null;
  status: string;
  createdAt: string;
  sources: FactSource[];
}

// Пункт 59 (backend) — MotiveHypothesis (§3.18 ТЗ), пункт 28
// v3-роадмапа. Публичный поиск сознательно не реализован — только
// синтез уже накопленных личных данных. "Возможное объяснение", не
// вывод о мотиве как факте.
export type MotiveConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface MotiveHypothesis {
  id: string;
  personId: string;
  projectId: string;
  explanation: string;
  supportingFactsSummary: string;
  confidence: MotiveConfidenceLevel;
  alignmentWithUserGoal: string | null;
  compromiseSuggestion: string | null;
  // Пункт 74 (backend) — §3.38 ТЗ. Только ПРЕДЛАГАЕТ смену статуса,
  // не переключает сама — требует явного подтверждения пользователем.
  suggestsFigurantStatus: boolean;
  createdAt: string;
}

// Пункт 60 (backend) — Working Materials (§3.27 ТЗ), реализовано в
// честно суженном объёме: .md/PPTX-текст, без фото/графиков и без
// голосового режима. extractedText — уже извлечённый на клиенте
// текст, сервер никогда не видит исходный файл.
export interface MaterialVersion {
  id: string;
  workingMaterialId: string;
  versionNumber: number;
  extractedText: string;
  critique: string;
  editPrompt: string;
  createdAt: string;
}

export interface WorkingMaterial {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  versions: MaterialVersion[];
}

// Пункт 91 (backend) — Material Chat (§3.27 ТЗ, "голосовой чат с AI").
export type MaterialChatMessageRole = 'USER' | 'ASSISTANT';

export interface MaterialChatMessage {
  id: string;
  sessionId: string;
  role: MaterialChatMessageRole;
  text: string;
  audioBase64: string | null;
  createdAt: string;
}

export interface MaterialChatSession {
  id: string;
  workingMaterialId: string;
  status: 'ACTIVE' | 'ENDED';
  endedAt: string | null;
  refinedEditPrompt: string | null;
  createdAt: string;
  messages?: MaterialChatMessage[];
}

export interface MaterialChatVoiceReplyJob {
  id: string;
  materialChatSessionId: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  userMessageId: string | null;
  assistantMessageId: string | null;
  errorMessage: string | null;
}

// Пункт 61 (backend) — Chat Import (§3.29 ТЗ, только WhatsApp .txt в
// этом проходе). Импорт заполняет те же модели, что аудио-конвейер
// (Conversation/ConversationParticipant/TranscriptSegment) — тип
// ниже отражает именно тот же Conversation, что уже возвращает
// getConversation(), не отдельная параллельная структура.
export interface ImportedConversation {
  id: string;
  projectId: string;
  sourceType: string;
  status: string;
  occurredAt: string;
  participants: { id: string; diarizationLabel: string; isSelf: boolean }[];
  transcript: { segments: { id: string; text: string; startMs: number }[] } | null;
}

// Пункт 62 (backend) — Protocol (§3.30 ТЗ). "Лёгкая версия MOU" —
// текст уже содержит оговорку об отсутствии юридической силы,
// заданную в промпте, не только в UI.
export interface Protocol {
  id: string;
  projectId: string;
  summaryText: string;
  createdAt: string;
}

// Пункт 63 (backend) — Text-to-Speech (пункт 43 общего списка
// v4-роадмапа). Общая инфраструктура, не привязанная к одной фиче.
export interface SynthesizeResult {
  audioBase64: string;
  cached: boolean;
}

// Пункт 64 (backend) — §3.24 частично + §3.25 ТЗ. Раздельная
// дисциплина: цитата хранит sourceReference отдельным полем, анекдот
// — нет (не факт и не аргумент, буквально ТЗ).
export interface SituationalQuote {
  id: string;
  projectId: string;
  quoteText: string;
  sourceReference: string;
  createdAt: string;
}

export interface SituationalAnecdote {
  id: string;
  projectId: string;
  text: string;
  createdAt: string;
}

export interface SituationalContentPreferences {
  alwaysShowQuote: boolean;
  alwaysShowAnecdote: boolean;
}

// Пункт 65 (backend) — VenueRecommendation (§3.22 ТЗ, честно суженный
// объём — без монетизации и без автоматического бронирования, см.
// /TODO.md). rating — 🔵 публичный факт, reviewSummary/suitabilityReason
// — 🟡 AI-парафраз/оценка, раздельные поля.
export interface VenueRecommendation {
  id: string;
  scheduledConversationId: string;
  placeId: string;
  name: string;
  address: string;
  phone: string | null;
  rating: number | null;
  reviewSummary: string | null;
  suitabilityReason: string;
  createdAt: string;
}

// Пункт 66 (backend) — VenueApplication/ApprovedVenue (§3.23 ТЗ).
// Внутренний скоринг честно ограничен только рейтингом Google — нет
// полей под трекинг бронирований/жалоб, которых не существует.
export interface PlaceSearchCandidate {
  placeId: string;
  name: string;
  rating: number | null;
}

export interface VenueAutofillData {
  name: string;
  address: string;
  phone: string | null;
  openingHours: string[];
  photoReferences: string[];
}

export type VenueApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface VenueApplication {
  id: string;
  submittedByUserId: string;
  name: string;
  address: string;
  phone: string | null;
  openingHours: string[];
  googlePlaceId: string | null;
  photoReferences: string[];
  status: VenueApplicationStatus;
  createdAt: string;
}

export interface ApprovedVenue {
  id: string;
  applicationId: string;
  name: string;
  address: string;
  phone: string | null;
  openingHours: string[];
  photoReferences: string[];
  rating: number | null;
  createdAt: string;
  // Пункт 67 (§3.22 "Монетизация") — леджер, не реальная платёжная
  // интеграция. См. подробное обоснование в apps/api/prisma/README.md,
  // «Пункт 67».
  referralFeeAmount: number | null;
  isPriorityPartner: boolean;
}

export interface VenueBookingConfirmation {
  id: string;
  approvedVenueId: string;
  scheduledConversationId: string | null;
  referralFeeOwed: number | null;
  createdAt: string;
}

export interface CommissionSummary {
  totalBookingsConfirmed: number;
  totalFeesOwed: number;
}

// Пункт 68 (backend) — Religious Reminder (§3.24 ТЗ, ежедневное
// напоминание). Статический справочник по religionId, не AI-генерация
// — принципиальное отличие от контекстных цитат/анекдотов (Пункт 64).
export type ReligiousReminderFrequency = 'EVERY_LAUNCH' | 'ONCE_PER_DAY' | 'OFF';

export interface ReligiousReminderResult {
  shouldShow: boolean;
  principles: string[] | null;
}

// Пункт 70 (backend) — CompromiseSheet (§3.41 ТЗ). items ссылаются на
// Argument, не на Fact — только производный уровень покидает
// приложение. Пункт 71 — audioSource=USER_VOICE реализован с
// клиентской пост-обработкой (apps/tma/src/lib/audio-post-process.ts).
export type CompromiseSheetPhase = 'BEFORE' | 'AFTER';
export type CompromiseSheetAudioSource = 'ELEVENLABS' | 'USER_VOICE';

export interface CompromiseSheetItem {
  id: string;
  compromiseSheetId: string;
  argumentId: string;
  argument: { id: string; text: string; stance: string };
}

export interface CompromiseSheet {
  id: string;
  sparringSessionId: string;
  phase: CompromiseSheetPhase;
  items: CompromiseSheetItem[];
  audioGenerated: boolean;
  audioSource: CompromiseSheetAudioSource | null;
  audioBase64: string | null;
  postProcessingNormalizeVolume: boolean;
  postProcessingRemovePauses: boolean;
  postProcessingRemoveNoise: boolean;
  previewedByUser: boolean;
  sentToFigurant: boolean;
  createdAt: string;
}

// Пункт 72 (backend) — ClosingMessage (§3.35 ТЗ). quoteText/
// quoteSourceReference оба null, если пользователь не указал
// вероисповедание — никогда не подставляются по умолчанию.
export interface ClosingMessage {
  id: string;
  projectId: string;
  summaryText: string;
  quoteText: string | null;
  quoteSourceReference: string | null;
  createdAt: string;
}

// Пункт 73 (backend) — Success Stats (§3.34 ТЗ). Пункт 85 добавил
// вторую метрику (conflictsSmoothed*) — реальный след категории
// накала во времени (§3.33, Пункт 83), не приближение. Скользящие
// окна, не календарные, обе метрики.
//
// EscalationCategory уже определён как тип в lib/acoustic-monitor.ts
// (Пункт 83) — не дублируется здесь, тот тип реэкспортируется как
// единый источник истины для обеих сторон (клиентский расчёт и
// то, что отправляется на backend, структурно один и тот же набор
// значений).
export interface SuccessStats {
  positiveOutcomesToday: number;
  positiveOutcomesLast3Days: number;
  positiveOutcomesLastWeek: number;
  conflictsSmoothedToday: number;
  conflictsSmoothedLast3Days: number;
  conflictsSmoothedLastWeek: number;
}

// Пункт 75 (backend) — Project Log (§3.39 ТЗ, честно суженный объём —
// два источника событий из трёх, третий заблокирован §3.33, см.
// /TODO.md). Вычисляемое представление на backend, не отдельная
// сущность на клиенте.
export type ProjectLogColor = 'GREEN' | 'RED';
export type ProjectLogEventType = 'STATUS_CHANGE' | 'DISCREPANCY_DETECTED' | 'MANIPULATION_DETECTED';

export interface ProjectLogEntry {
  color: ProjectLogColor;
  eventType: ProjectLogEventType;
  personId: string;
  personName: string;
  description: string;
  occurredAt: string;
  sourceConversationId: string | null;
}

// Пункт 76 (backend) — Weather Forecast (§3.21 ТЗ). cityLabel — только
// при ручном вводе города, честно null при geo-пути (координаты
// никогда не персистятся).
export type WeatherRecommendation = 'PROCEED' | 'RECONSIDER';

export interface WeatherForecast {
  id: string;
  scheduledConversationId: string;
  cityLabel: string | null;
  temperatureCelsius: number | null;
  condition: string;
  recommendation: WeatherRecommendation;
  recommendationReason: string;
  createdAt: string;
}

// Пункт 78 (backend) — предпросмотр в форме создания встречи (§3.20
// ТЗ). Не персистентная сущность — нет id/createdAt, чистый
// предпросмотр по уже сохранённому профильному городу.
export interface WeatherForecastPreview {
  cityLabel: string;
  temperatureCelsius: number | null;
  condition: string;
  recommendation: WeatherRecommendation;
  recommendationReason: string;
}

// Пункт 79 (backend) — Scheduler Advice (пункт 58 общего списка).
// "Личные предпочтения строго со слов" — обеспечено на backend
// фильтром по sourceType=PERSONAL_RECORD, здесь просто текст совета.
export interface SchedulerAdvice {
  id: string;
  projectId: string;
  adviceText: string;
  createdAt: string;
}

// Пункт 81 (backend) — Live Session / Cooldown-нудж (§3.31 ТЗ).
export interface CooldownNudgeEvent {
  id: string;
  projectId: string;
  peakVolumeDb: number | null;
  escalationScore: number | null;
  dismissed: boolean;
  createdAt: string;
}

// Пункт 82 (backend) — Live Hints (§3.4 ТЗ).
export type LiveHintType = 'ARGUMENT_SUGGESTION' | 'TOPIC_REPETITION';

export interface LiveHintEvent {
  id: string;
  projectId: string;
  hintType: LiveHintType;
  hintText: string;
  suggestedArgumentId: string | null;
  dismissed: boolean;
  createdAt: string;
}

// Пункт 83 (backend) — Live Manipulation Flags (§3.33 ТЗ). "Тег
// происхождения остаётся 🟡 догадка ИИ... live-детекция ещё менее
// надёжна, чем постфактум-анализ" (buкально ТЗ) — confidence должен
// показываться явно, не скрываться за уверенной формулировкой.
export interface LiveManipulationFlag {
  id: string;
  projectId: string;
  technique: string;
  description: string;
  confidence: number | null;
  createdAt: string;
}

// Пункт 84 (backend) — Breaking Questions + Live Argument Tracking
// (§3.33 ТЗ, проход 2). Оба вопроса — с тегом происхождения 🟡
// "догадка ИИ", buкально ТЗ.
export interface BreakingQuestionSet {
  id: string;
  projectId: string;
  breakingQuestion: string;
  compromiseQuestion: string;
  createdAt: string;
}

export type ArgumentTrackingState = 'NOT_MENTIONED' | 'NEEDS_REPEAT' | 'SUFFICIENTLY_MENTIONED' | 'GENUINELY_ACCEPTED';

export interface LiveArgumentTrackingStatus {
  id: string;
  projectId: string;
  argumentId: string;
  argument: { id: string; text: string; stance: string };
  status: ArgumentTrackingState;
  lastCheckedAt: string;
}

// Пункт 86 (backend) — Probing Detector (§3.37 ТЗ). "Дважды, трижды"
// — только темы с repeatCount >= 2 реально показываются как
// предупреждение, но list() может вернуть и repeatCount=1 (ещё
// отслеживается, порог не пройден) — TMA должна учитывать это при
// отображении, не показывать всё подряд как готовое предупреждение.
export interface ProbingTopic {
  id: string;
  projectId: string;
  topicDescription: string;
  repeatCount: number;
  confidence: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
}

// Пункт 87 (backend) — Voice Embedding (голосовой отпечаток).
export interface VoiceEnrollmentStatus {
  enrolled: boolean;
}

export interface VoiceVerifyResult {
  isMatch: boolean | null; // null = ещё нет эталона для сравнения
}

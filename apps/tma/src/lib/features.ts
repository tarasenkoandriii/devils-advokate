import { apiGet, apiPost, apiPut, apiPatch, apiDelete, handle } from './api';
import {
  Argument,
  AvailableEngine,
  BootstrapResponse,
  Commitment,
  CommitmentOwner,
  CommitmentStatus,
  ConsentRecord,
  ConsentType,
  Conversation,
  ConversationCard,
  ConversationDetail,
  ConversationScriptType,
  ConversationSourceType,
  DecisionObjective,
  DisclaimerStatus,
  NegotiationBoundaries,
  OnboardingData,
  LocationSuggestion,
  ReconciliationArgument,
  ScheduledConversation,
  DecisionOutcomeRating,
  DecisionOutcome,
  CalibrationSummary,
  SparringMessage,
  SparringSession,
  SparringVoiceReplyJob,
  PublicArgumentSubmission,
  LibraryEntry,
  FactScope,
  FactSourceType,
  PersonFact,
  MotiveHypothesis,
  WorkingMaterial,
  ImportedConversation,
  Protocol,
  SynthesizeResult,
  SituationalQuote,
  SituationalAnecdote,
  SituationalContentPreferences,
  VenueRecommendation,
  PlaceSearchCandidate,
  VenueAutofillData,
  VenueApplication,
  VenueBookingConfirmation,
  ReligiousReminderFrequency,
  ReligiousReminderResult,
  CompromiseSheet,
  ClosingMessage,
  SuccessStats,
  ProjectLogEntry,
  WeatherForecast,
  WeatherForecastPreview,
  SchedulerAdvice,
  CooldownNudgeEvent,
  LiveHintEvent,
  LiveManipulationFlag,
  BreakingQuestionSet,
  LiveArgumentTrackingStatus,
  ProbingTopic,
  VoiceEnrollmentStatus,
  VoiceVerifyResult,
  MaterialChatSession,
  MaterialChatMessage,
  MaterialChatVoiceReplyJob,
  CompromiseSheetPhase,
  PrivacyOverview,
  Project,
  ProjectDetail,
  ProjectListResponse,
  ProjectPersonLink,
  PersonStatus,
  RetentionClassInfo,
  SafeShareLogEntry,
  SafeSharePreflightResult,
  SteelmanCase,
  TurningPoint,
  MissingInformationCheck,
  EvidenceGapReport,
  DoNotSayItem,
  BestNextMoveRecommendation,
  SourceConflict,
  StaleFactWarning,
  ManipulationPoint,
  DiscrepancySignal,
  ArchetypeType,
  ArchetypePerspective,
  PersonCommunicationTrait,
  SourceCheckResult,
  FactCheckApiResult,
  LegalDisclaimerResponse,
  FactsToVerifyExport,
  Relationship,
  RelationshipSuggestion,
  StakeholderRole,
  SuggestRolesResult,
  TargetedArgument,
  StakeholderMapEntry,
  BehaviorPrecedent,
  PrecedentSearchResult,
  OutcomeScenario,
  PhotoVerification,
  RelationshipType,
  RelationshipDirection,
  ArgumentLifecycleStatus,
  ArgumentFailureInsight,
  OpenLoopsSummary,
  Prediction,
  AssignParticipantInput,
  ConversationAgenda,
  ProtectedNote,
  ProtectedNoteType,
} from './types';

export const CURRENT_EXTERNAL_AI_CONSENT_VERSION = 'v1';

export function bootstrap(): Promise<BootstrapResponse> {
  return apiGet<BootstrapResponse>('/bootstrap');
}

export function getDisclaimerStatus(): Promise<DisclaimerStatus> {
  return apiGet<DisclaimerStatus>('/disclaimer/status');
}

export function acknowledgeDisclaimer(): Promise<DisclaimerStatus> {
  return apiPost<DisclaimerStatus>('/disclaimer/acknowledge');
}

export function listConsents(): Promise<ConsentRecord[]> {
  return apiGet<ConsentRecord[]>('/consent');
}

export function grantConsent(params: {
  consentType: ConsentType;
  version: string;
  source: string;
  purposes?: string[];
}): Promise<ConsentRecord> {
  return apiPost<ConsentRecord>('/consent/grant', params);
}

export function hasConsent(consents: ConsentRecord[], type: ConsentType): boolean {
  return consents.some((c) => c.consentType === type && c.granted);
}

export function createProject(input: { question: string; goal?: string }): Promise<Project> {
  return apiPost<Project>('/projects', input);
}

export function listProjects(): Promise<ProjectListResponse> {
  return apiGet<ProjectListResponse>('/projects');
}

export function getProjectDetail(projectId: string): Promise<ProjectDetail> {
  return apiGet<ProjectDetail>(`/projects/${projectId}`);
}

export function generateArguments(projectId: string, engineId?: string): Promise<Argument[]> {
  return apiPost<Argument[]>(`/projects/${projectId}/arguments/generate`, { engineId });
}

export function listEngines(taskType = 'argument-generation'): Promise<AvailableEngine[]> {
  return apiGet<AvailableEngine[]>(`/ai-engines?taskType=${encodeURIComponent(taskType)}`);
}

export function getObjective(projectId: string): Promise<DecisionObjective | null> {
  return apiGet<DecisionObjective | null>(`/projects/${projectId}/objective`);
}

export interface SaveObjectiveInput {
  desiredOutcome?: string;
  idealOutcome?: string;
  minimumAcceptableOutcome?: string;
  unacceptableOutcome?: string;
  deadline?: string;
  constraints?: string[];
  nonNegotiables?: string[];
  negotiables?: string[];
  doNotSay?: string[];
}

export function saveObjective(
  projectId: string,
  input: SaveObjectiveInput,
): Promise<DecisionObjective> {
  return apiPut<DecisionObjective>(`/projects/${projectId}/objective`, input);
}

export function listPeople(projectId: string): Promise<ProjectPersonLink[]> {
  return apiGet<ProjectPersonLink[]>(`/projects/${projectId}/people`);
}

export function addPerson(projectId: string, displayName: string): Promise<ProjectPersonLink> {
  return apiPost<ProjectPersonLink>(`/projects/${projectId}/people`, { displayName });
}

// Пункт 30 (аудит) — removePerson()/updatePersonStatus() backend был
// реализован и протестирован ещё в чекпоинте 1 (persons.service.ts,
// 10 тестов), но не имел ни одной вызывающей функции в TMA — PeopleSection
// не давал пользователю ни удалить фигуранта, ни сменить его статус.
// Найдено систематической сверкой backend-эндпоинтов с TMA-вызовами.

export function removePerson(projectId: string, personId: string): Promise<unknown> {
  return apiDelete(`/projects/${projectId}/people/${personId}`);
}

// trigger всегда 'MANUAL' — это ручное действие пользователя в UI, не
// автоматическое предложение AI-детектора конфликтов (StatusTrigger.
// CONFLICT_DETECTOR_SUGGESTED — фича, которая ни разу не была
// реализована ни в одной сессии; confirmed=true осмысленно только для
// неё, поэтому не передаётся здесь вообще).
export function updatePersonStatus(
  projectId: string,
  personId: string,
  status: PersonStatus,
): Promise<ProjectPersonLink> {
  return apiPatch<ProjectPersonLink>(`/projects/${projectId}/people/${personId}/status`, {
    status,
    trigger: 'MANUAL',
  });
}

// Пункт 74 (backend) — подтверждение предложения детектора конфликта
// целей (§3.38 ТЗ). Единственный способ перевести CONFLICT_DETECTOR_
// SUGGESTED в реальное изменение статуса — backend жёстко требует
// confirmed=true для этого trigger, отклоняет иначе.
export function confirmSuggestedStatus(projectId: string, personId: string): Promise<ProjectPersonLink> {
  return apiPatch<ProjectPersonLink>(`/projects/${projectId}/people/${personId}/status`, {
    status: 'FIGURANT',
    trigger: 'CONFLICT_DETECTOR_SUGGESTED',
    confirmed: true,
  });
}

export function generateSteelman(
  projectId: string,
  personId: string,
  engineId?: string,
): Promise<SteelmanCase> {
  return apiPost<SteelmanCase>(`/projects/${projectId}/people/${personId}/steelman`, { engineId });
}

export function listSteelmanCases(projectId: string, personId: string): Promise<SteelmanCase[]> {
  return apiGet<SteelmanCase[]>(`/projects/${projectId}/people/${personId}/steelman`);
}

export function getBoundaries(projectId: string): Promise<NegotiationBoundaries | null> {
  return apiGet<NegotiationBoundaries | null>(`/projects/${projectId}/boundaries`);
}

export interface SaveBoundariesInput {
  idealOutcome?: string;
  acceptableOutcome?: string;
  batna?: string;
  watna?: string;
  walkAwayPoint?: string;
}

export function saveBoundaries(
  projectId: string,
  input: SaveBoundariesInput,
): Promise<NegotiationBoundaries> {
  return apiPut<NegotiationBoundaries>(`/projects/${projectId}/boundaries`, input);
}

export function getConversationCard(projectId: string): Promise<ConversationCard> {
  return apiGet<ConversationCard>(`/projects/${projectId}/card`);
}

export function generateScript(
  projectId: string,
  type: ConversationScriptType,
  personId?: string,
  engineId?: string,
): Promise<{ type: ConversationScriptType; text: string }> {
  return apiPost(`/projects/${projectId}/scripts`, { type, personId, engineId });
}

export function getPrivacyOverview(): Promise<PrivacyOverview> {
  return apiGet<PrivacyOverview>('/privacy/overview');
}

export function deletePersonData(personId: string): Promise<{ deleted: boolean }> {
  return apiDelete<{ deleted: boolean }>(`/privacy/person/${personId}`);
}

export interface AccountDeletionResult {
  deleted: true;
  removed: Record<string, number>;
  externalArtifacts: { evidenceBlobs: number; deleted: number; failed: number };
  notRemovedHere: string[];
}

/** Аудит БД 2026-08-30 §2.4 — удаление аккаунта (GDPR art. 17). Backend
 * требует confirmation: "DELETE" — защита от случайного вызова. */
export function deleteAccount(): Promise<AccountDeletionResult> {
  return apiDelete<AccountDeletionResult>('/privacy/account', { confirmation: 'DELETE' });
}

export function exportPrivacyData(): Promise<unknown> {
  return apiGet('/privacy/export');
}

export function revokeConsent(type: ConsentType): Promise<{ revoked: boolean }> {
  return apiDelete<{ revoked: boolean }>(`/consent/${type}`);
}

export function safeSharePreflight(
  text: string,
  contentType: string,
  projectId?: string,
): Promise<SafeSharePreflightResult> {
  return apiPost<SafeSharePreflightResult>('/safe-share/preflight', { text, contentType, projectId });
}

export function safeShareConfirm(safeShareActionId: string): Promise<unknown> {
  return apiPost(`/safe-share/confirm/${safeShareActionId}`);
}

export function getSafeShareLog(): Promise<SafeShareLogEntry[]> {
  return apiGet<SafeShareLogEntry[]>('/safe-share/log');
}

export function getRetentionClasses(): Promise<RetentionClassInfo[]> {
  return apiGet<RetentionClassInfo[]>('/retention-classes');
}

export function getOnboarding(): Promise<OnboardingData> {
  return apiGet<OnboardingData>('/onboarding');
}

export function saveOnboarding(input: {
  religion?: string | null;
  city?: string | null;
  country?: string | null;
  countryCode?: string | null;
}): Promise<OnboardingData> {
  return apiPut<OnboardingData>('/onboarding', input);
}

// Пункт 49 — НЕ персистит ничего сама, только возвращает подсказку.
export function suggestOnboardingFromLocation(lat: number, lon: number): Promise<LocationSuggestion> {
  return apiPost<LocationSuggestion>('/onboarding/suggest-from-location', { lat, lon });
}

// Пункт 13 (backend) — Conversation Dossier (раздел 2 ТЗ, MVP v2).

export function createConversation(
  projectId: string,
  input: { sourceType: ConversationSourceType; occurredAt: string; durationSeconds?: number },
): Promise<Conversation> {
  return apiPost<Conversation>(`/projects/${projectId}/conversations`, input);
}

export function listConversations(projectId: string): Promise<Conversation[]> {
  return apiGet<Conversation[]>(`/projects/${projectId}/conversations`);
}

export function getConversation(conversationId: string): Promise<ConversationDetail> {
  return apiGet<ConversationDetail>(`/conversations/${conversationId}`);
}

export function requestTranscription(
  conversationId: string,
  input: { audioUrl: string; languageCode?: string },
): Promise<Conversation> {
  return apiPost<Conversation>(`/conversations/${conversationId}/transcribe`, input);
}

// Потоковая загрузка — НЕ через apiPost(): тот всегда делает
// JSON.stringify(body) и ставит Content-Type: application/json, что
// сломало бы бинарную загрузку файла. File/Blob как body у fetch()
// передаётся потоково нативно (браузер сам решает буферизацию) — тот
// же принцип "без буферизации на диск/в БД", что и на бэкенде
// (TranscriptionService.streamUpload(), см. apps/api/prisma/README.md
// "Пункт 13"), здесь просто нет промежуточного НАШЕГО сервера вообще
// на клиентской стороне — File объект передаётся в fetch() напрямую.
export async function uploadConversationAudio(
  conversationId: string,
  file: File,
): Promise<{ audioUrl: string }> {
  const { getAuthHeaders } = await import('./telegram');
  const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

  const response = await fetch(`${API_BASE_URL}/conversations/${conversationId}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      ...getAuthHeaders(),
    },
    body: file,
  });

  // Пункт 34 (реальное исправление найденной асимметрии, Пункт 33) —
  // раньше эта функция сама разбирала конверт ответа урезанной копией
  // логики handle() (без обработки некорректного JSON, с обычным Error
  // вместо ApiRequestError — единственная асимметрия среди всех функций
  // файла). Не JSON-тело запроса (стриминг File) требует собственного
  // fetch(), но РАЗБОР ответа — та же самая логика, что у всех
  // остальных функций, поэтому переиспользует handle() из api.ts, не
  // дублирует её отдельной копией.
  return handle<{ audioUrl: string }>(response);
}

// Пункт 14 (backend) — Commitment Tracker (§3.49 ТЗ).

export function createCommitment(
  projectId: string,
  input: { personId: string; owner: CommitmentOwner; description: string; dueDate?: string },
): Promise<Commitment> {
  return apiPost<Commitment>(`/projects/${projectId}/commitments`, input);
}

export function listCommitmentsByProject(projectId: string): Promise<Commitment[]> {
  return apiGet<Commitment[]>(`/projects/${projectId}/commitments`);
}

// §3.49 ТЗ: "отображается в хронологии по фигуранту" — по personId,
// сразу по всем проектам, где этот человек фигурирует.
export function listCommitmentsByPerson(personId: string): Promise<Commitment[]> {
  return apiGet<Commitment[]>(`/people/${personId}/commitments`);
}

export function updateCommitment(
  commitmentId: string,
  input: { description?: string; dueDate?: string | null; status?: CommitmentStatus },
): Promise<Commitment> {
  return apiPatch<Commitment>(`/commitments/${commitmentId}`, input);
}

// Пункт 15 (backend) — Turning Point Detection (§3.50 ТЗ).

export function detectTurningPoints(conversationId: string): Promise<TurningPoint[]> {
  return apiPost<TurningPoint[]>(`/conversations/${conversationId}/turning-points/detect`);
}

export function listTurningPoints(conversationId: string): Promise<TurningPoint[]> {
  return apiGet<TurningPoint[]>(`/conversations/${conversationId}/turning-points`);
}

// Пункт 16 (backend) — Missing Information (§3.51 ТЗ).

export function detectMissingInformation(projectId: string): Promise<MissingInformationCheck> {
  return apiPost<MissingInformationCheck>(`/projects/${projectId}/missing-information/detect`);
}

export function getLatestMissingInformation(projectId: string): Promise<MissingInformationCheck | null> {
  return apiGet<MissingInformationCheck | null>(`/projects/${projectId}/missing-information`);
}

// Пункт 17 (backend) — Evidence Gap (§3.52 ТЗ). GET, не POST —
// детерминированная классификация, не AI-вызов, ничего не персистится.
export function getEvidenceGap(projectId: string): Promise<EvidenceGapReport> {
  return apiGet<EvidenceGapReport>(`/projects/${projectId}/evidence-gap`);
}

// Пункт 18 (backend) — Do Not Say (§3.53 ТЗ).

export function detectDoNotSay(conversationId: string): Promise<DoNotSayItem[]> {
  return apiPost<DoNotSayItem[]>(`/conversations/${conversationId}/do-not-say/detect`);
}

export function listDoNotSay(conversationId: string): Promise<DoNotSayItem[]> {
  return apiGet<DoNotSayItem[]>(`/conversations/${conversationId}/do-not-say`);
}

// Пункт 19 (backend) — Best Next Move (§3.54 ТЗ).

export function detectBestNextMove(conversationId: string): Promise<BestNextMoveRecommendation> {
  return apiPost<BestNextMoveRecommendation>(`/conversations/${conversationId}/best-next-move/detect`);
}

export function getLatestBestNextMove(conversationId: string): Promise<BestNextMoveRecommendation | null> {
  return apiGet<BestNextMoveRecommendation | null>(`/conversations/${conversationId}/best-next-move`);
}

// Пункт 21 (backend) — Source Conflict Resolver (§3.56 ТЗ).

export function detectSourceConflicts(personId: string): Promise<SourceConflict[]> {
  return apiPost<SourceConflict[]>(`/people/${personId}/source-conflicts/detect`);
}

export function listSourceConflicts(personId: string): Promise<SourceConflict[]> {
  return apiGet<SourceConflict[]>(`/people/${personId}/source-conflicts`);
}

export function resolveSourceConflict(conflictId: string): Promise<SourceConflict> {
  return apiPatch<SourceConflict>(`/source-conflicts/${conflictId}/resolve`);
}

// Пункт 22 (backend) — Stale Fact Alert (§3.57 ТЗ).

export function listStaleFactsByPerson(personId: string): Promise<StaleFactWarning[]> {
  return apiGet<StaleFactWarning[]>(`/people/${personId}/stale-facts`);
}

// Пункт 23 (backend) — Argument Lifecycle (§3.58 ТЗ).

export function transitionArgumentLifecycle(
  projectId: string,
  argumentId: string,
  input: { toStatus: ArgumentLifecycleStatus; conversationId?: string; note?: string },
): Promise<Argument> {
  return apiPost<Argument>(`/projects/${projectId}/arguments/${argumentId}/lifecycle`, input);
}

export function getArgumentFailureInsight(
  projectId: string,
  argumentId: string,
): Promise<ArgumentFailureInsight> {
  return apiGet<ArgumentFailureInsight>(`/projects/${projectId}/arguments/${argumentId}/lifecycle/insight`);
}

// Пункт 24 (backend) — Open Loops (§3.59 ТЗ).

export function getOpenLoopsSummary(projectId: string): Promise<OpenLoopsSummary> {
  return apiGet<OpenLoopsSummary>(`/projects/${projectId}/open-loops`);
}

// Пункт 25 (backend) — Prediction vs Reality (§3.60 ТЗ).

export function createPrediction(projectId: string, predictedOutcome: string): Promise<Prediction> {
  return apiPost<Prediction>(`/projects/${projectId}/predictions`, { predictedOutcome });
}

export function listPredictions(projectId: string): Promise<Prediction[]> {
  return apiGet<Prediction[]>(`/projects/${projectId}/predictions`);
}

export function recordActualOutcome(predictionId: string, actualOutcome: string): Promise<Prediction> {
  return apiPatch<Prediction>(`/predictions/${predictionId}/actual-outcome`, { actualOutcome });
}

// Пункт 26 (backend) — сопоставление диаризации фигурантам.

export function assignParticipant(
  participantId: string,
  input: AssignParticipantInput,
): Promise<unknown> {
  return apiPatch(`/conversation-participants/${participantId}`, input);
}

// Пункт 27 (backend) — повестка следующего разговора (раздел 2 ТЗ).

export function generateAgenda(projectId: string): Promise<ConversationAgenda> {
  return apiPost<ConversationAgenda>(`/projects/${projectId}/agenda/generate`);
}

export function getLatestAgenda(projectId: string): Promise<ConversationAgenda | null> {
  return apiGet<ConversationAgenda | null>(`/projects/${projectId}/agenda`);
}

// Пункт 28 (backend) — защищённые заметки (раздел 2 ТЗ).

export function createProtectedNote(
  projectId: string,
  input: { type: ProtectedNoteType; content: string; triggerCondition?: string; planOrder?: number },
): Promise<ProtectedNote> {
  return apiPost<ProtectedNote>(`/projects/${projectId}/protected-notes`, input);
}

export function listProtectedNotes(projectId: string): Promise<ProtectedNote[]> {
  return apiGet<ProtectedNote[]>(`/projects/${projectId}/protected-notes`);
}

export function updateProtectedNote(
  noteId: string,
  input: { content?: string; triggerCondition?: string | null; planOrder?: number | null },
): Promise<ProtectedNote> {
  return apiPatch<ProtectedNote>(`/protected-notes/${noteId}`, input);
}

export function deleteProtectedNote(noteId: string): Promise<unknown> {
  return apiDelete(`/protected-notes/${noteId}`);
}

// Пункт 36 (backend) — Manipulation Detector (§3.28 ТЗ, MVP v3).

export function detectManipulationPatterns(conversationId: string): Promise<ManipulationPoint[]> {
  return apiPost<ManipulationPoint[]>(`/conversations/${conversationId}/manipulation-patterns/detect`);
}

export function listManipulationPatterns(conversationId: string): Promise<ManipulationPoint[]> {
  return apiGet<ManipulationPoint[]>(`/conversations/${conversationId}/manipulation-patterns`);
}

// Пункт 37 (backend) — Discrepancy Analysis (§3.16 ТЗ, MVP v3).

export function detectDiscrepancies(conversationId: string): Promise<DiscrepancySignal[]> {
  return apiPost<DiscrepancySignal[]>(`/conversations/${conversationId}/discrepancies/detect`);
}

export function listDiscrepancies(conversationId: string): Promise<DiscrepancySignal[]> {
  return apiGet<DiscrepancySignal[]>(`/conversations/${conversationId}/discrepancies`);
}

export function confirmIntentionalFalsehood(signalId: string): Promise<DiscrepancySignal> {
  return apiPatch<DiscrepancySignal>(`/discrepancies/${signalId}/confirm-intentional`);
}

// Пункт 38 (backend) — Archetype Perspective Simulation (§3.11 ТЗ, MVP v3).

export function generateArchetypePerspective(
  projectId: string,
  archetypeType: ArchetypeType,
  customArchetypeDescription?: string,
  targetPersonId?: string,
  focusOnOwnPositionWeaknesses?: boolean,
): Promise<ArchetypePerspective> {
  return apiPost<ArchetypePerspective>(`/projects/${projectId}/archetype-perspectives`, {
    archetypeType,
    customArchetypeDescription,
    targetPersonId,
    focusOnOwnPositionWeaknesses,
  });
}

export function listArchetypePerspectives(projectId: string): Promise<ArchetypePerspective[]> {
  return apiGet<ArchetypePerspective[]>(`/projects/${projectId}/archetype-perspectives`);
}

// Пункт 39 (backend) — Communication Profile (§3.11 ТЗ текст).

export function refreshCommunicationProfile(personId: string): Promise<PersonCommunicationTrait[]> {
  return apiPost<PersonCommunicationTrait[]>(`/people/${personId}/communication-profile/refresh`);
}

export function getCommunicationProfile(personId: string): Promise<PersonCommunicationTrait[]> {
  return apiGet<PersonCommunicationTrait[]>(`/people/${personId}/communication-profile`);
}

// Пункт 40 (backend) — четвёртый источник сверки §3.16 ТЗ, ручная
// вставка ссылки пользователем.

export function checkAgainstUserSource(
  conversationId: string,
  segmentId: string,
  url: string,
): Promise<SourceCheckResult> {
  return apiPost<SourceCheckResult>(`/conversations/${conversationId}/discrepancies/check-source`, { segmentId, url });
}

// Пункт 41 (backend) — выгрузка пронумерованного списка утверждений
// для ручной проверки, не автономный поиск.

/** Полный аудит 2026-08-30 — сверка утверждения с публичными фактчек-базами
 * (Google Fact Check Tools). Backend закрыл этим «четвёртый источник» §3.16,
 * но из TMA метод не вызывался. Утверждение — текст сегмента (или правка). */
export function checkAgainstFactCheckApi(conversationId: string, segmentId: string, claimText: string): Promise<FactCheckApiResult> {
  return apiPost<FactCheckApiResult>(`/conversations/${conversationId}/discrepancies/check-against-fact-check-api`, { segmentId, claimText });
}

/** Полный аудит 2026-08-30 — юридические ссылки по режиму проекта и
 * юрисдикции пользователя (по User.country). null = для этой пары ничего
 * нет; фронтенд прячет блок сам. */
export function getLegalDisclaimer(mode: string): Promise<LegalDisclaimerResponse | null> {
  return apiGet<LegalDisclaimerResponse | null>(`/legal-disclaimer?mode=${encodeURIComponent(mode)}`);
}

export function exportFactsToVerify(conversationId: string): Promise<FactsToVerifyExport> {
  return apiGet<FactsToVerifyExport>(`/conversations/${conversationId}/discrepancies/export`);
}

// Пункт 43 (backend) — Relationship (§3.13 ТЗ).

export function createRelationship(input: {
  personAId: string;
  personBId: string;
  type: RelationshipType;
  label: string;
  direction: RelationshipDirection;
  strength?: number;
  sourceType: string;
}): Promise<Relationship> {
  return apiPost<Relationship>('/relationships', input);
}

export function listRelationshipsForPerson(personId: string): Promise<Relationship[]> {
  return apiGet<Relationship[]>(`/people/${personId}/relationships`);
}

export function deleteRelationship(relationshipId: string): Promise<unknown> {
  return apiDelete(`/relationships/${relationshipId}`);
}

export function suggestRelationships(): Promise<RelationshipSuggestion[]> {
  return apiGet<RelationshipSuggestion[]>('/relationships/suggestions');
}

// Пункт 44 (backend) — Stakeholder Map (§3.8 ТЗ).

export function suggestStakeholderRoles(projectId: string): Promise<SuggestRolesResult> {
  return apiPost<SuggestRolesResult>(`/projects/${projectId}/stakeholder-map/suggest-roles`, {});
}

export function confirmStakeholderRole(
  projectId: string,
  personId: string,
  role: StakeholderRole,
): Promise<unknown> {
  return apiPatch(`/projects/${projectId}/stakeholder-map/people/${personId}/role`, { role });
}

export function generateArgumentsForStakeholder(
  projectId: string,
  personId: string,
): Promise<TargetedArgument[]> {
  return apiPost<TargetedArgument[]>(`/projects/${projectId}/stakeholder-map/people/${personId}/arguments`, {});
}

export function listStakeholderMap(projectId: string): Promise<StakeholderMapEntry[]> {
  return apiGet<StakeholderMapEntry[]>(`/projects/${projectId}/stakeholder-map`);
}

// Пункт 45 (backend) — Precedent Search (§3.9 ТЗ, только личные записи).

export function findPrecedents(personId: string, situationDescription: string): Promise<BehaviorPrecedent[]> {
  return apiPost<BehaviorPrecedent[]>(`/people/${personId}/precedents`, { situationDescription });
}

export function listPrecedents(personId: string): Promise<PrecedentSearchResult> {
  return apiGet<PrecedentSearchResult>(`/people/${personId}/precedents`);
}

// Пункт 47 (backend) — Outcome Forecasting (§3.12 ТЗ).

export function generateOutcomeScenarios(
  projectId: string,
  userScenarioDescriptions: string[] = [],
): Promise<OutcomeScenario[]> {
  return apiPost<OutcomeScenario[]>(`/projects/${projectId}/outcome-scenarios`, { userScenarioDescriptions });
}

export function listOutcomeScenarios(projectId: string): Promise<OutcomeScenario[]> {
  return apiGet<OutcomeScenario[]>(`/projects/${projectId}/outcome-scenarios`);
}

/** Полный аудит 2026-08-30 — «сбылось / не сбылось» по сценарию. Backend
 * называет это единственным источником данных калибровочного gate
 * (CalibrationService); до этого из UI не вызывалось никогда. */
export function confirmOutcomeScenario(projectId: string, scenarioId: string, confirmed: boolean): Promise<OutcomeScenario> {
  return apiPatch<OutcomeScenario>(`/projects/${projectId}/outcome-scenarios/${scenarioId}/confirm-outcome`, { confirmed });
}

// Пункт 48 (backend) — Photo Verification (§4.4 ТЗ).

export async function uploadPhotoForVerification(personFactId: string, file: File): Promise<PhotoVerification[]> {
  const { getAuthHeaders } = await import('./telegram');
  const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

  // Тот же паттерн, что uploadConversationAudio() — потоковая
  // передача файла напрямую как body, не JSON, разбор ответа
  // переиспользует handle() из api.ts, не дублирует логику.
  const response = await fetch(`${API_BASE_URL}/facts/${personFactId}/photo-verification`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      ...getAuthHeaders(),
    },
    body: file,
  });

  return handle<PhotoVerification[]>(response);
}

export function listPhotoVerifications(personFactId: string): Promise<PhotoVerification[]> {
  return apiGet<PhotoVerification[]>(`/facts/${personFactId}/photo-verification`);
}

// Пункт 49 (backend) — Reconciliation Arguments (§3.14 ТЗ).

export function generateReconciliationArguments(projectId: string): Promise<ReconciliationArgument[]> {
  return apiPost<ReconciliationArgument[]>(`/projects/${projectId}/reconciliation-arguments`, {});
}

export function listReconciliationArguments(projectId: string): Promise<ReconciliationArgument[]> {
  return apiGet<ReconciliationArgument[]>(`/projects/${projectId}/reconciliation-arguments`);
}

// Пункт 50 (backend) — Scheduler (§3.20 ТЗ).

export function createScheduledConversation(
  projectId: string,
  input: { personId?: string; scheduledAt: string; sparringReminderMinutesBefore?: number | null },
): Promise<ScheduledConversation> {
  return apiPost<ScheduledConversation>(`/projects/${projectId}/scheduled-conversations`, input);
}

export function listScheduledConversations(projectId: string): Promise<ScheduledConversation[]> {
  return apiGet<ScheduledConversation[]>(`/projects/${projectId}/scheduled-conversations`);
}

export function linkScheduledConversation(
  projectId: string,
  scheduledId: string,
  conversationId: string,
): Promise<ScheduledConversation> {
  return apiPatch<ScheduledConversation>(
    `/projects/${projectId}/scheduled-conversations/${scheduledId}/link`,
    { conversationId },
  );
}

// Пункт 52 (backend) — Decision Track Record (§3.2 ТЗ).

export function recordDecisionOutcome(
  projectId: string,
  input: { actualOutcome: DecisionOutcomeRating; outcomeNotes?: string; category?: string },
): Promise<DecisionOutcome> {
  return apiPut<DecisionOutcome>(`/projects/${projectId}/outcome`, input);
}

export function getDecisionOutcome(projectId: string): Promise<DecisionOutcome | null> {
  return apiGet<DecisionOutcome | null>(`/projects/${projectId}/outcome`);
}

export function getCalibrationSummary(): Promise<CalibrationSummary> {
  return apiGet<CalibrationSummary>('/calibration-summary');
}

// Пункт 73 (backend) — та же логика "уровень пользователя", что и getCalibrationSummary выше.
export function getSuccessStats(): Promise<SuccessStats> {
  return apiGet<SuccessStats>('/success-stats');
}

// Пункт 85 (backend) — след категории накала во времени (§3.34 ТЗ).
export function logEscalationCategory(projectId: string, sessionId: string, category: string): Promise<void> {
  return apiPost(`/projects/${projectId}/escalation-category-events`, { sessionId, category });
}

// Пункт 55 (backend) — Sparring / Red Team (§3.1 ТЗ).

export function startSparringSession(
  projectId: string,
  targetPersonId?: string,
  archetypeType?: ArchetypeType,
  customArchetypeDescription?: string,
  scheduledConversationId?: string,
): Promise<SparringSession> {
  return apiPost<SparringSession>(`/projects/${projectId}/sparring-sessions`, {
    targetPersonId,
    archetypeType,
    customArchetypeDescription,
    scheduledConversationId,
  });
}

export function listSparringSessions(projectId: string): Promise<SparringSession[]> {
  return apiGet<SparringSession[]>(`/projects/${projectId}/sparring-sessions`);
}

export function getSparringSession(sessionId: string): Promise<SparringSession> {
  return apiGet<SparringSession>(`/sparring-sessions/${sessionId}`);
}

export function replySparring(sessionId: string, text: string): Promise<SparringMessage[]> {
  return apiPost<SparringMessage[]>(`/sparring-sessions/${sessionId}/reply`, { text });
}

export function endSparringSession(sessionId: string): Promise<SparringSession> {
  return apiPost<SparringSession>(`/sparring-sessions/${sessionId}/end`, {});
}

// Пункт 69 (backend) — голосовой ввод реплики (§3.26 ТЗ). Тот же
// паттерн потоковой загрузки, что uploadConversationAudio() — File
// как body у fetch() передаётся потоково нативно, не через apiPost.
export async function uploadSparringVoiceReply(sessionId: string, file: File): Promise<{ audioUrl: string }> {
  const { getAuthHeaders } = await import('./telegram');
  const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

  const response = await fetch(`${API_BASE_URL}/sparring-sessions/${sessionId}/voice-upload`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      ...getAuthHeaders(),
    },
    body: file,
  });
  return handle<{ audioUrl: string }>(response);
}

export function submitSparringVoiceReply(sessionId: string, audioUrl: string): Promise<SparringVoiceReplyJob> {
  return apiPost<SparringVoiceReplyJob>(`/sparring-sessions/${sessionId}/voice-reply`, { audioUrl });
}

export function getSparringVoiceReplyStatus(sessionId: string, jobId: string): Promise<SparringVoiceReplyJob> {
  return apiGet<SparringVoiceReplyJob>(`/sparring-sessions/${sessionId}/voice-reply/${jobId}`);
}

// Пункт 56 (backend) — Public Discussion (§4.3/§4.5 ТЗ), owner-side
// (за TelegramAuthGuard). Публичная сторона — см. lib/public-api.ts.

export function enablePublicSharing(projectId: string): Promise<{ publicShareToken: string }> {
  return apiPost<{ publicShareToken: string }>(`/projects/${projectId}/public-discussion/enable`, {});
}

export function disablePublicSharing(projectId: string): Promise<{ publicShareToken: string | null }> {
  return apiPost<{ publicShareToken: string | null }>(`/projects/${projectId}/public-discussion/disable`, {});
}

export function listPublicSubmissionsForModeration(projectId: string): Promise<PublicArgumentSubmission[]> {
  return apiGet<PublicArgumentSubmission[]>(`/projects/${projectId}/public-discussion/submissions`);
}

export function moderatePublicSubmission(
  projectId: string,
  submissionId: string,
  decision: 'ACCEPT' | 'REJECT',
): Promise<PublicArgumentSubmission> {
  return apiPatch<PublicArgumentSubmission>(
    `/projects/${projectId}/public-discussion/submissions/${submissionId}/moderate`,
    { decision },
  );
}

// Пункт 57 (backend) — Library (§3.5 ТЗ), owner-side (за
// TelegramAuthGuard). Публичная сторона — см. lib/public-api.ts.

export function submitProjectToLibrary(
  projectId: string,
  title: string,
  category: string,
): Promise<LibraryEntry> {
  return apiPost<LibraryEntry>(`/projects/${projectId}/submit-to-library`, { title, category });
}

// Модерация библиотеки (moderation-queue / :id/moderate) с Пункта
// [admin-panel] живёт за AdminSessionGuard (httpOnly cookie админки), а не
// за Telegram initData — из TMA эти вызовы всегда получали бы 401.
// Функции и страница /library/moderate удалены аудитом; UI — apps/admin.

// Пункт 58 (backend) — PersonFact create/list (§4.2/§3.19 ТЗ).

export interface CreatePersonFactInput {
  content: string;
  sourceType: FactSourceType;
  scope?: FactScope;
  projectId?: string;
  confidence?: number;
  source?: {
    fileRef?: string;
    url?: string;
    hasGeoTag?: boolean;
    metadataStripped?: boolean;
  };
}

export function createPersonFact(personId: string, input: CreatePersonFactInput): Promise<PersonFact> {
  return apiPost<PersonFact>(`/people/${personId}/facts`, input);
}

export function listPersonFacts(personId: string): Promise<PersonFact[]> {
  return apiGet<PersonFact[]>(`/people/${personId}/facts`);
}

// Пункт 59 (backend) — Motive Analysis (§3.18 ТЗ, публичный поиск не реализован).

export function analyzeMotives(projectId: string, personId: string): Promise<MotiveHypothesis[]> {
  return apiPost<MotiveHypothesis[]>(`/projects/${projectId}/people/${personId}/motive-hypotheses`, {});
}

export function listMotiveHypotheses(projectId: string, personId: string): Promise<MotiveHypothesis[]> {
  return apiGet<MotiveHypothesis[]>(`/projects/${projectId}/people/${personId}/motive-hypotheses`);
}

// Пункт 60 (backend) — Working Materials (§3.27 ТЗ, honestly суженный объём).

export function submitWorkingMaterialVersion(
  projectId: string,
  input: { extractedText: string; materialId?: string; title?: string },
): Promise<{ material: WorkingMaterial; version: WorkingMaterial['versions'][number] }> {
  return apiPost<{ material: WorkingMaterial; version: WorkingMaterial['versions'][number] }>(
    `/projects/${projectId}/working-materials`,
    input,
  );
}

export function listWorkingMaterials(projectId: string): Promise<WorkingMaterial[]> {
  return apiGet<WorkingMaterial[]>(`/projects/${projectId}/working-materials`);
}

// Пункт 61 (backend) — Chat Import (§3.29 ТЗ, только WhatsApp .txt).

export interface ImportChatInput {
  messages: { sender: string; text: string; timestampMs: number }[];
  selfSenderName: string;
  rawFileRef?: string;
}

export function importChat(projectId: string, input: ImportChatInput): Promise<ImportedConversation> {
  return apiPost<ImportedConversation>(`/projects/${projectId}/chat-import`, input);
}

// Пункт 62 (backend) — Protocol (§3.30 ТЗ).

export function generateProtocol(projectId: string): Promise<Protocol> {
  return apiPost<Protocol>(`/projects/${projectId}/protocols`, {});
}

export function listProtocols(projectId: string): Promise<Protocol[]> {
  return apiGet<Protocol[]>(`/projects/${projectId}/protocols`);
}

// Пункт 63 (backend) — Text-to-Speech (пункт 43 общего списка).

export function synthesizeSpeech(text: string, voiceId?: string): Promise<SynthesizeResult> {
  return apiPost<SynthesizeResult>('/tts', { text, voiceId });
}

// Пункт 64 (backend) — §3.24 частично + §3.25 ТЗ.

export function generateSituationalQuote(projectId: string): Promise<SituationalQuote> {
  return apiPost<SituationalQuote>(`/projects/${projectId}/situational-quotes`, {});
}

export function listSituationalQuotes(projectId: string): Promise<SituationalQuote[]> {
  return apiGet<SituationalQuote[]>(`/projects/${projectId}/situational-quotes`);
}

export function generateSituationalAnecdote(projectId: string): Promise<SituationalAnecdote> {
  return apiPost<SituationalAnecdote>(`/projects/${projectId}/situational-anecdotes`, {});
}

export function listSituationalAnecdotes(projectId: string): Promise<SituationalAnecdote[]> {
  return apiGet<SituationalAnecdote[]>(`/projects/${projectId}/situational-anecdotes`);
}

export function updateSituationalContentPreferences(
  input: Partial<SituationalContentPreferences>,
): Promise<SituationalContentPreferences> {
  return apiPatch<SituationalContentPreferences>('/users/me/situational-content-preferences', input);
}

// Пункт 65 (backend) — Venue Recommendation (§3.22 ТЗ, честно суженный объём).

export function generateVenueRecommendations(
  scheduledConversationId: string,
  latitude: number,
  longitude: number,
): Promise<VenueRecommendation[]> {
  return apiPost<VenueRecommendation[]>(`/scheduled-conversations/${scheduledConversationId}/venue-recommendations`, {
    latitude,
    longitude,
  });
}

export function listVenueRecommendations(scheduledConversationId: string): Promise<VenueRecommendation[]> {
  return apiGet<VenueRecommendation[]>(`/scheduled-conversations/${scheduledConversationId}/venue-recommendations`);
}

// Пункт 66 (backend) — Venue Application (§3.23 ТЗ), owner-side/модерация
// (за TelegramAuthGuard). Публичная сторона — см. lib/public-api.ts.

export function searchVenueCandidates(
  query: string,
  latitude?: number,
  longitude?: number,
): Promise<PlaceSearchCandidate[]> {
  const params = new URLSearchParams({ query });
  if (latitude !== undefined) params.set('latitude', String(latitude));
  if (longitude !== undefined) params.set('longitude', String(longitude));
  return apiGet<PlaceSearchCandidate[]>(`/venue-applications/search?${params.toString()}`);
}

export function getVenueAutofillData(googlePlaceId: string): Promise<VenueAutofillData> {
  return apiGet<VenueAutofillData>(`/venue-applications/autofill/${googlePlaceId}`);
}

export interface SubmitVenueApplicationInput {
  name: string;
  address: string;
  phone?: string;
  openingHours?: string[];
  googlePlaceId?: string;
  photoReferences?: string[];
}

export function submitVenueApplication(input: SubmitVenueApplicationInput): Promise<VenueApplication> {
  return apiPost<VenueApplication>('/venue-applications', input);
}

// Модерация заявок заведений — та же история, что у библиотеки выше:
// с Пункта [admin-panel] за AdminSessionGuard, из TMA недостижима.
// Страница /venues/moderate и обёртки удалены аудитом; UI — apps/admin.

// Пункт 67 (backend) — Venue Monetization (§3.22 ТЗ, честный леджер, не платёжная интеграция).

export function confirmVenueBooking(
  approvedVenueId: string,
  scheduledConversationId?: string,
): Promise<VenueBookingConfirmation> {
  return apiPost<VenueBookingConfirmation>(`/approved-venues/${approvedVenueId}/booking-confirmations`, {
    scheduledConversationId,
  });
}

// Пункт 68 (backend) — Religious Reminder (§3.24 ТЗ).

export function getReligiousReminderIfDue(): Promise<ReligiousReminderResult> {
  return apiGet<ReligiousReminderResult>('/religious-reminder');
}

export function updateReligiousReminderFrequency(
  frequency: ReligiousReminderFrequency,
): Promise<{ religiousReminderFrequency: ReligiousReminderFrequency }> {
  return apiPatch<{ religiousReminderFrequency: ReligiousReminderFrequency }>('/religious-reminder/frequency', {
    frequency,
  });
}

// Пункт 70 (backend) — Compromise Sheet (§3.41 ТЗ).

export function generateCompromiseSheet(
  sessionId: string,
  phase: CompromiseSheetPhase,
  engineId?: string,
): Promise<CompromiseSheet> {
  return apiPost<CompromiseSheet>(`/sparring-sessions/${sessionId}/compromise-sheets`, { phase, engineId });
}

export function listCompromiseSheets(sessionId: string): Promise<CompromiseSheet[]> {
  return apiGet<CompromiseSheet[]>(`/sparring-sessions/${sessionId}/compromise-sheets`);
}

export function generateCompromiseSheetVoiceOver(sheetId: string, voiceId?: string): Promise<CompromiseSheet> {
  return apiPost<CompromiseSheet>(`/compromise-sheets/${sheetId}/voice-over`, { voiceId });
}

export function markCompromiseSheetPreviewed(sheetId: string): Promise<CompromiseSheet> {
  return apiPatch<CompromiseSheet>(`/compromise-sheets/${sheetId}/preview`, {});
}

export function markCompromiseSheetSentToFigurant(sheetId: string): Promise<CompromiseSheet> {
  return apiPatch<CompromiseSheet>(`/compromise-sheets/${sheetId}/sent`, {});
}

// Пункт 71 (backend) — собственный голос + пост-обработка (§3.41 ТЗ).

export interface SubmitUserVoiceInput {
  audioBase64: string;
  normalizeVolume: boolean;
  removePauses: boolean;
  removeNoise: boolean;
}

export function submitCompromiseSheetUserVoice(sheetId: string, input: SubmitUserVoiceInput): Promise<CompromiseSheet> {
  return apiPost<CompromiseSheet>(`/compromise-sheets/${sheetId}/user-voice`, input);
}

// Пункт 72 (backend) — Closing Message (§3.35 ТЗ).

export function generateClosingMessage(projectId: string, engineId?: string): Promise<ClosingMessage> {
  return apiPost<ClosingMessage>(`/projects/${projectId}/closing-messages`, { engineId });
}

export function listClosingMessages(projectId: string): Promise<ClosingMessage[]> {
  return apiGet<ClosingMessage[]>(`/projects/${projectId}/closing-messages`);
}

// Пункт 75 (backend) — Project Log (§3.39 ТЗ).

export function getProjectLog(projectId: string): Promise<ProjectLogEntry[]> {
  return apiGet<ProjectLogEntry[]>(`/projects/${projectId}/log`);
}

// Пункт 76 (backend) — Weather Forecast (§3.21 ТЗ).

export function generateWeatherByCity(scheduledConversationId: string, cityName: string): Promise<WeatherForecast> {
  return apiPost<WeatherForecast>(`/scheduled-conversations/${scheduledConversationId}/weather-forecasts/by-city`, {
    cityName,
  });
}

export function generateWeatherByGeolocation(
  scheduledConversationId: string,
  latitude: number,
  longitude: number,
): Promise<WeatherForecast> {
  return apiPost<WeatherForecast>(`/scheduled-conversations/${scheduledConversationId}/weather-forecasts/by-geolocation`, {
    latitude,
    longitude,
  });
}

export function listWeatherForecasts(scheduledConversationId: string): Promise<WeatherForecast[]> {
  return apiGet<WeatherForecast[]>(`/scheduled-conversations/${scheduledConversationId}/weather-forecasts`);
}

// Пункт 78 (backend) — предпросмотр в форме создания встречи (§3.20 ТЗ).
export function previewWeatherForScheduling(
  projectId: string,
  scheduledAt: string,
): Promise<WeatherForecastPreview | null> {
  return apiGet<WeatherForecastPreview | null>(
    `/projects/${projectId}/weather-forecast-preview?scheduledAt=${encodeURIComponent(scheduledAt)}`,
  );
}

// Пункт 79 (backend) — Scheduler Advice (пункт 58 общего списка).

export function generateSchedulerAdvice(projectId: string, engineId?: string): Promise<SchedulerAdvice[]> {
  return apiPost<SchedulerAdvice[]>(`/projects/${projectId}/scheduler-advice`, { engineId });
}

export function listSchedulerAdvice(projectId: string): Promise<SchedulerAdvice[]> {
  return apiGet<SchedulerAdvice[]>(`/projects/${projectId}/scheduler-advice`);
}

// Пункт 81 (backend) — Live Session / Cooldown-нудж (§3.31 ТЗ).

export function mintTranscriptionToken(): Promise<{ token: string; expiresInSeconds: number }> {
  return apiPost<{ token: string; expiresInSeconds: number }>('/live-session/transcription-token', {});
}

export function logCooldownNudgeEvent(
  projectId: string,
  peakVolumeDb: number | null,
  escalationScore: number | null,
): Promise<CooldownNudgeEvent> {
  return apiPost<CooldownNudgeEvent>(`/projects/${projectId}/cooldown-nudge-events`, { peakVolumeDb, escalationScore });
}

export function dismissCooldownNudgeEvent(projectId: string, eventId: string): Promise<CooldownNudgeEvent> {
  return apiPatch<CooldownNudgeEvent>(`/projects/${projectId}/cooldown-nudge-events/${eventId}/dismiss`, {});
}

// Пункт 82 (backend) — Live Hints (§3.4 ТЗ).

export function analyzeLiveHint(
  projectId: string,
  transcriptWindow: string,
): Promise<LiveHintEvent | null> {
  return apiPost<LiveHintEvent | null>(`/projects/${projectId}/live-hints`, { transcriptWindow });
}

/** Полный аудит 2026-08-30 — режим собеседования (Пункт [interview-pool]):
 * подсказывает следующий ещё не заданный вопрос опросника; backend был, из
 * TMA не вызывался. */
export function analyzeLiveHintForInterview(projectId: string, transcriptWindow: string): Promise<LiveHintEvent | null> {
  return apiPost<LiveHintEvent | null>(`/projects/${projectId}/live-hints/interview`, { transcriptWindow });
}

export function dismissLiveHintEvent(projectId: string, eventId: string): Promise<LiveHintEvent> {
  return apiPatch<LiveHintEvent>(`/projects/${projectId}/live-hints/${eventId}/dismiss`, {});
}

// Пункт 83 (backend) — Live Manipulation Flags (§3.33 ТЗ).

export function analyzeLiveManipulation(
  projectId: string,
  transcriptWindow: string,
): Promise<LiveManipulationFlag[]> {
  return apiPost<LiveManipulationFlag[]>(`/projects/${projectId}/live-manipulation-flags`, { transcriptWindow });
}

// Пункт 84 (backend) — Breaking Questions + Live Argument Tracking (§3.33 ТЗ, проход 2).

export function generateBreakingQuestions(
  projectId: string,
  transcriptWindow: string,
  targetPersonId?: string,
): Promise<BreakingQuestionSet> {
  return apiPost<BreakingQuestionSet>(`/projects/${projectId}/breaking-questions`, { transcriptWindow, targetPersonId });
}

export function initializeArgumentTracking(projectId: string): Promise<LiveArgumentTrackingStatus[]> {
  return apiPost<LiveArgumentTrackingStatus[]>(`/projects/${projectId}/live-argument-tracking/initialize`, {});
}

export function checkArgumentTrackingStatus(
  projectId: string,
  transcriptWindow: string,
): Promise<LiveArgumentTrackingStatus[]> {
  return apiPost<LiveArgumentTrackingStatus[]>(`/projects/${projectId}/live-argument-tracking/check`, { transcriptWindow });
}

// Пункт 86 (backend) — Probing Detector (§3.37 ТЗ).

export function analyzeProbing(projectId: string, transcriptWindow: string): Promise<ProbingTopic[]> {
  return apiPost<ProbingTopic[]>(`/projects/${projectId}/probing-topics`, { transcriptWindow });
}

// Пункт 87 (backend) — Voice Embedding (голосовой отпечаток).

export function enrollVoiceEmbedding(embedding: number[]): Promise<{ userId: string }> {
  return apiPost(`/voice-embedding/enroll`, { embedding });
}

export function getVoiceEnrollmentStatus(): Promise<VoiceEnrollmentStatus> {
  return apiGet<VoiceEnrollmentStatus>(`/voice-embedding/status`);
}

export function verifyVoiceEmbedding(embedding: number[], threshold?: number): Promise<VoiceVerifyResult> {
  return apiPost<VoiceVerifyResult>(`/voice-embedding/verify`, { embedding, threshold });
}

export function revokeVoiceEmbedding(): Promise<{ revoked: boolean }> {
  return apiDelete<{ revoked: boolean }>(`/voice-embedding`);
}

// Пункт 91 (backend) — Material Chat (§3.27 ТЗ, голосовой чат с AI).

export function startMaterialChatSession(
  projectId: string,
  workingMaterialId: string,
  engineId?: string,
): Promise<MaterialChatSession> {
  return apiPost<MaterialChatSession>(`/projects/${projectId}/working-materials/${workingMaterialId}/chat-sessions`, { engineId });
}

export function listMaterialChatSessions(projectId: string, workingMaterialId: string): Promise<MaterialChatSession[]> {
  return apiGet<MaterialChatSession[]>(`/projects/${projectId}/working-materials/${workingMaterialId}/chat-sessions`);
}

export function getMaterialChatSession(sessionId: string): Promise<MaterialChatSession> {
  return apiGet<MaterialChatSession>(`/material-chat-sessions/${sessionId}`);
}

export function replyMaterialChat(sessionId: string, text: string): Promise<MaterialChatMessage[]> {
  return apiPost<MaterialChatMessage[]>(`/material-chat-sessions/${sessionId}/reply`, { text });
}

export function endMaterialChatSession(sessionId: string): Promise<MaterialChatSession> {
  return apiPost<MaterialChatSession>(`/material-chat-sessions/${sessionId}/end`, {});
}

// Тот же паттерн потоковой загрузки, что uploadSparringVoiceReply()
// (Пункт 69) — File как body у fetch() передаётся потоково нативно.
export async function uploadMaterialChatVoiceReply(sessionId: string, file: File): Promise<{ audioUrl: string }> {
  const { getAuthHeaders } = await import('./telegram');
  const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

  const response = await fetch(`${API_BASE_URL}/material-chat-sessions/${sessionId}/voice-upload`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      ...getAuthHeaders(),
    },
    body: file,
  });
  return handle<{ audioUrl: string }>(response);
}

export function submitMaterialChatVoiceReply(sessionId: string, audioUrl: string): Promise<MaterialChatVoiceReplyJob> {
  return apiPost<MaterialChatVoiceReplyJob>(`/material-chat-sessions/${sessionId}/voice-reply`, { audioUrl });
}

export function getMaterialChatVoiceReplyStatus(sessionId: string, jobId: string): Promise<MaterialChatVoiceReplyJob> {
  return apiGet<MaterialChatVoiceReplyJob>(`/material-chat-sessions/${sessionId}/voice-reply/${jobId}`);
}

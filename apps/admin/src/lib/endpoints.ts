import { apiGet, apiPost, apiPatch } from './admin-api';
import type {
  AdminMe,
  AdminUserRow,
  AdminUserDetail,
  LibraryEntry,
  VenueApplication,
  ApprovedVenue,
  CommissionSummary,
  PromptVersion,
  EvaluationDataset,
  EvaluationRun,
  CalibrationStatus,
  TelemetrySummaryRow,
  TelemetryByModelRow,
  AIJobDetail,
} from './types';

// ── Аутентификация (devils-advocate-admin-panel-tz.md §4.1) ──

export interface TelegramLoginWidgetPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

// Ответ содержит только expiresAt: сам токен сессии живёт исключительно
// в httpOnly-cookie и клиентскому JS недоступен (повторный аудит
// 2026-08-30 — раньше он дублировался в теле ответа, что сводило смысл
// httpOnly к нулю).
export function telegramCallback(payload: TelegramLoginWidgetPayload) {
  return apiPost<{ expiresAt: string }>('/admin/auth/telegram-callback', payload);
}

export function logout() {
  return apiPost<{ ok: true }>('/admin/auth/logout');
}

/** Docker dev-запуск (DOCKER.md): вход без Telegram Login Widget.
 * Нужен потому, что виджет физически не работает на http://localhost —
 * Telegram привязывает его к домену, заданному боту через /setdomain,
 * а localhost туда не принимается. На бэкенде эндпоинт отвечает 404,
 * если ALLOW_DEV_AUTH!=true или NODE_ENV=production, так что вызов из
 * продовой сборки просто не сработает; кнопка в UI дополнительно
 * скрыта флагом NEXT_PUBLIC_ALLOW_DEV_AUTH, чтобы её не было видно
 * там, где она заведомо бессмысленна. */
export function devLogin(devUserId: string) {
  return apiPost<{ expiresAt: string }>('/admin/auth/dev-login', { devUserId });
}

export function getMe() {
  return apiGet<AdminMe>('/admin/auth/me');
}

// ── Пользователи (§4.3) ──

export function listUsers(search?: string, restricted?: boolean, blocked?: boolean) {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (restricted !== undefined) params.set('restricted', String(restricted));
  if (blocked !== undefined) params.set('blocked', String(blocked));
  const qs = params.toString();
  return apiGet<AdminUserRow[]>(`/admin/users${qs ? `?${qs}` : ''}`);
}

export function getUserDetail(id: string) {
  return apiGet<AdminUserDetail>(`/admin/users/${id}`);
}

export function restrictUser(id: string, restricted: boolean, note?: string) {
  return apiPatch<AdminUserDetail>(`/admin/users/${id}/restrict`, { restricted, note });
}

export function blockUser(id: string, blocked: boolean, note?: string) {
  return apiPatch<AdminUserDetail>(`/admin/users/${id}/block`, { blocked, note });
}

// ── Модерация библиотеки (§3.5 ТЗ) ──

export function listLibraryModerationQueue() {
  return apiGet<LibraryEntry[]>('/library/moderation-queue');
}

export function moderateLibraryEntry(entryId: string, decision: 'ACCEPT' | 'REJECT') {
  return apiPatch<LibraryEntry>(`/library/${entryId}/moderate`, { decision });
}

// ── Модерация заведений + монетизация (§3.22/§3.23 ТЗ) ──

export function listVenueModerationQueue() {
  return apiGet<VenueApplication[]>('/venue-applications/moderation-queue');
}

export function moderateVenueApplication(
  applicationId: string,
  decision: 'APPROVE' | 'REJECT',
  referralFeeAmount?: number,
) {
  return apiPatch<VenueApplication>(`/venue-applications/${applicationId}/moderate`, {
    decision,
    referralFeeAmount,
  });
}

export function listApprovedVenues() {
  // Публичный эндпоинт (та же витрина, что видят обычные пользователи) —
  // используется здесь только для чтения списка при управлении
  // монетизацией, не требует AdminSession, но безопасно вызывается и
  // с ней (credentials: 'include' не мешает публичному GET).
  return apiGet<ApprovedVenue[]>('/public/venues');
}

export function setVenueReferralFee(approvedVenueId: string, referralFeeAmount: number | null) {
  return apiPatch<ApprovedVenue>(`/approved-venues/${approvedVenueId}/referral-fee`, { referralFeeAmount });
}

export function setVenuePriorityPartner(approvedVenueId: string, isPriorityPartner: boolean) {
  return apiPatch<ApprovedVenue>(`/approved-venues/${approvedVenueId}/priority-partner`, { isPriorityPartner });
}

export function getVenueCommissionSummary(approvedVenueId: string) {
  return apiGet<CommissionSummary>(`/approved-venues/${approvedVenueId}/commission-summary`);
}

// ── Prompt Registry (devils-advocate-prompt-framework-tz.md §5.1) ──

export function createPromptDraft(promptId: string, version: string, template: string, changelog?: string) {
  return apiPost<PromptVersion>('/admin/prompts', { promptId, version, template, changelog });
}

export function listPromptVersions(promptId: string) {
  return apiGet<PromptVersion[]>(`/admin/prompts/${promptId}`);
}

export function getActivePromptVersion(promptId: string) {
  return apiGet<PromptVersion | null>(`/admin/prompts/${promptId}/active`);
}

export function updatePromptDraft(id: string, changes: { template?: string; changelog?: string }) {
  return apiPatch<PromptVersion>(`/admin/prompts/${id}`, changes);
}

export function promoteToTesting(id: string) {
  return apiPost<PromptVersion>(`/admin/prompts/${id}/promote-to-testing`);
}

export function promoteToActive(id: string) {
  return apiPost<PromptVersion>(`/admin/prompts/${id}/promote-to-active`);
}

export function rollbackPrompt(promptId: string) {
  return apiPost<PromptVersion>(`/admin/prompts/${promptId}/rollback`);
}

// ── Evaluation (§5.2) ──

export function createEvaluationDataset(name: string, version: string, description?: string) {
  return apiPost<EvaluationDataset>('/admin/evaluation-datasets', { name, version, description });
}

export function addEvaluationCases(
  datasetId: string,
  cases: Array<{ input: string; expectedOutput?: unknown; caseType: 'classification' | 'structural' }>,
) {
  return apiPost(`/admin/evaluation-datasets/${datasetId}/cases`, { cases });
}

export function runEvaluation(promptVersionId: string, evaluationDatasetId: string) {
  return apiPost<EvaluationRun>(`/admin/prompts/${promptVersionId}/evaluate`, { evaluationDatasetId });
}

export function getEvaluationRun(id: string) {
  return apiGet<EvaluationRun>(`/admin/evaluation-runs/${id}`);
}

// ── Calibration (§5.3) ──

export function getCalibrationStatus() {
  return apiGet<CalibrationStatus>('/admin/calibration/scenario-predictions');
}

// ── Telemetry (devils-advocate-telemetry-tz.md §4) ──

export function getTelemetrySummary(from?: string, to?: string) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  return apiGet<TelemetrySummaryRow[]>(`/admin/telemetry/summary${qs ? `?${qs}` : ''}`);
}

export function getTelemetryByModel(from?: string, to?: string) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  return apiGet<TelemetryByModelRow[]>(`/admin/telemetry/by-model${qs ? `?${qs}` : ''}`);
}

export function getTelemetryTaskDetail(taskType: string, limit = 50, status?: string) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (status) params.set('status', status);
  return apiGet<AIJobDetail[]>(`/admin/telemetry/tasks/${encodeURIComponent(taskType)}?${params.toString()}`);
}

// ── Доменные сценарии / intake / media-review (фаза F) ──
import type { DomainSummaryRow, DomainProjectList, DomainProjectDetail, IntakeSummary, AdminMediaReviewQueue } from './types';

export function getDomainsSummary() {
  return apiGet<DomainSummaryRow[]>('/admin/domains/summary');
}
export function listDomainProjects(domain: string, withConfig?: boolean, skip = 0) {
  const q = new URLSearchParams({ skip: String(skip), take: '50' });
  if (withConfig !== undefined) q.set('withConfig', String(withConfig));
  return apiGet<DomainProjectList>(`/admin/domains/${domain}/projects?${q.toString()}`);
}
export function getDomainProject(domain: string, id: string) {
  return apiGet<DomainProjectDetail>(`/admin/domains/${domain}/projects/${id}`);
}
export function getIntakeSummary() {
  return apiGet<IntakeSummary>('/admin/intake/summary');
}
export function listAdminMediaReviewQueues() {
  return apiGet<AdminMediaReviewQueue[]>('/admin/media-review/queues');
}
export function setDomainProjectFrozen(domain: string, id: string, frozen: boolean, note?: string) {
  return apiPatch<{ id: string; frozenAt: string | null; frozenNote: string | null }>(`/admin/domains/${domain}/projects/${id}/freeze`, { frozen, note });
}

// ── Sandbox (пункт [admin-sandbox] 2026-08-31) ──
// Прогон продовых сценариев от имени самого оператора; описание границ
// безопасности — в шапке apps/api/src/admin-sandbox/admin-sandbox.service.ts.
import type {
  SandboxStatus,
  SandboxYouTubeSearch,
  SandboxTranscriptionRun,
  SandboxConversation,
} from './types';

export function getSandboxStatus() {
  return apiGet<SandboxStatus>('/admin/sandbox/status');
}
export function grantSandboxConsents() {
  return apiPost<{ granted: string[]; alreadyHad: string[] }>('/admin/sandbox/consents');
}
export function sandboxYouTubeSearch(query: string) {
  return apiPost<SandboxYouTubeSearch>('/admin/sandbox/youtube-search', { query });
}
export function runSandboxTranscription() {
  return apiPost<SandboxTranscriptionRun>('/admin/sandbox/transcription');
}
export function getSandboxConversation(id: string) {
  return apiGet<SandboxConversation>(`/admin/sandbox/conversation/${id}`);
}
export function sandboxAnalyze(conversationId: string, kind: 'manipulation' | 'discrepancy' | 'turning-points') {
  return apiPost<unknown>('/admin/sandbox/analyze', { conversationId, kind });
}

// ── Sandbox: загрузка реального аудио/видео (вторая итерация 2026-08-31) ──
export function createSandboxUploadConversation(isVideo: boolean, durationSeconds?: number, targetProjectId?: string) {
  return apiPost<{ projectId: string; conversationId: string }>('/admin/sandbox/upload-conversation', {
    isVideo,
    durationSeconds,
    // Пункт [sandbox-domain-conversations]: загрузка в доменный проект
    // (b-подэтапы). Пусто = песочный проект, как раньше.
    targetProjectId,
  });
}
export function getSandboxUploadToken(conversationId: string, pathname: string) {
  return apiPost<{ clientToken: string }>('/admin/sandbox/upload-token', { conversationId, pathname });
}
export function confirmSandboxUpload(conversationId: string, pathname: string) {
  return apiPost<{ pathname: string; sizeBytes: number; contentType: string }>('/admin/sandbox/confirm-upload', {
    conversationId,
    pathname,
  });
}
export function sandboxTranscribe(conversationId: string, languageCode?: string) {
  return apiPost<{ conversationId: string; status: string; externalJobId: string | null }>('/admin/sandbox/transcribe', {
    conversationId,
    languageCode,
  });
}

// ── Sandbox: песочная очередь медиа-разбора (третья итерация 2026-08-31) ──
// Кнопка «Разобрать» у результата поиска. Скачивания ролика здесь НЕТ
// намеренно (ТЗ медиа-разбора §2.2): элемент очереди хранит метаданные,
// файл приносит сам оператор.
import type { SandboxAnalysis, SandboxDiagnosis, SandboxFactCheck, SandboxHealthDraft, SandboxIntakeState, SandboxQueue, SandboxYouTubeResult } from './types';

export function sandboxAddToQueue(video: SandboxYouTubeResult) {
  return apiPost<{ queueId: string; itemId: string }>('/admin/sandbox/queue/items', {
    youtubeVideoId: video.videoId,
    title: video.title,
    channelName: video.channelName,
    thumbnailUrl: video.thumbnailUrl,
    durationSeconds: video.durationSeconds ?? undefined,
    publishedAt: video.publishedAt ?? undefined,
  });
}
export function sandboxLinkQueueItem(itemId: string, conversationId: string) {
  return apiPost<{ id: string; status: string }>('/admin/sandbox/queue/link', { itemId, conversationId });
}
export function getSandboxQueue() {
  return apiGet<{ queue: SandboxQueue | null }>('/admin/sandbox/queue');
}
export function sandboxRetryQueueItem(itemId: string) {
  return apiPost<{ status: string; autoAnalysisError: string | null }>('/admin/sandbox/queue/retry', { itemId });
}
export function getSandboxAnalysis(conversationId: string) {
  return apiGet<SandboxAnalysis>(`/admin/sandbox/analysis/${conversationId}`);
}
export function sandboxIntakeStart(text: string) {
  return apiPost<SandboxIntakeState>('/admin/sandbox/intake/start', { text });
}
export function sandboxIntakeAnswer(sessionId: string, text: string) {
  return apiPost<SandboxIntakeState>('/admin/sandbox/intake/answer', { sessionId, text });
}
export function sandboxIntakeDispatch(sessionId: string, scenario: string, contractType?: string) {
  return apiPost<SandboxIntakeState>('/admin/sandbox/intake/dispatch', { sessionId, scenario, contractType });
}
export function sandboxHealthAnswer(conversationId: string, text: string) {
  return apiPost<{ ok: boolean }>('/admin/sandbox/health/answer', { conversationId, text });
}
export function sandboxHealthExtract(conversationId: string) {
  return apiPost<SandboxHealthDraft>('/admin/sandbox/health/extract', { conversationId });
}
export function sandboxHealthConfig(projectId: string, draft: SandboxHealthDraft) {
  return apiPost<{ id: string }>('/admin/sandbox/health/config', { projectId, ...draft });
}
export function sandboxTranscriptionToken() {
  return apiPost<{ token: string; expiresInSeconds: number }>('/admin/sandbox/transcription-token', {});
}
export function sandboxHealthLabDocument(configId: string, base64Content: string) {
  return apiPost<{ id: string; ocrText: string; verified: boolean }>('/admin/sandbox/health/lab-document', { configId, base64Content });
}
export function sandboxHealthLabVerify(draftId: string) {
  return apiPost<{ id: string; verified: boolean }>('/admin/sandbox/health/lab-verify', { draftId });
}
export function sandboxDiagnoseQueueItem(itemId: string) {
  return apiPost<SandboxDiagnosis>('/admin/sandbox/queue/diagnose', { itemId });
}
export function sandboxFactCheck(conversationId: string) {
  return apiPost<SandboxFactCheck>(`/admin/sandbox/fact-check/${conversationId}`, {});
}

// ── БД-состояние (Пункт [db-state] 2026-09-01) ──
// pg_cron расписание + лог запусков + ответы pg_net + сводка ai_jobs —
// то, что раньше пробивалось руками в SQL Editor Supabase.
import type { AdminDbState } from './types';

export function getAdminDbState() {
  return apiGet<AdminDbState>('/admin/db-state');
}

// ── Sandbox: крупная покупка (Пункт [sandbox-major-purchase] 2026-09-01) ──
// Этап 1 доменного покрытия: ответы → чек-лист (AI) → extract (AI) →
// конфиг → варианты → сравнительная таблица. Всё продовыми сервисами.
import type { SandboxMpComparison, SandboxMpDraft } from './types';

export function sandboxMpAnswer(conversationId: string, text: string) {
  return apiPost<{ ok: true }>('/admin/sandbox/major-purchase/answer', { conversationId, text });
}
export function sandboxMpChecklist(conversationId: string, category: 'REAL_ESTATE' | 'VEHICLE') {
  return apiPost<{ items: string[] }>('/admin/sandbox/major-purchase/checklist', { conversationId, category });
}
export function sandboxMpExtract(conversationId: string, category: 'REAL_ESTATE' | 'VEHICLE') {
  return apiPost<SandboxMpDraft>('/admin/sandbox/major-purchase/extract', { conversationId, category });
}
export function sandboxMpConfig(projectId: string, category: 'REAL_ESTATE' | 'VEHICLE', draft: SandboxMpDraft) {
  return apiPost<{ id: string }>('/admin/sandbox/major-purchase/config', { projectId, category, ...draft });
}
export function sandboxMpVariant(configId: string, label: string, askingPrice?: number, currency?: string) {
  return apiPost<{ id: string; label: string }>('/admin/sandbox/major-purchase/variant', { configId, label, askingPrice, currency });
}
export function sandboxMpComparison(configId: string) {
  return apiGet<SandboxMpComparison>(`/admin/sandbox/major-purchase/comparison/${configId}`);
}

// ── Sandbox: инвестиции (Пункт [sandbox-investment] 2026-09-01) ──
// Этап 2 доменного покрытия: extract → конфиг → возможность → сравнение
// с источником (сырой текст, без AI-оценки — продовая граница §3.2) →
// таблица (без score/rank). Плюс смоук групповой механики одним аккаунтом.
import type { SandboxInvComparison, SandboxInvDraft, SandboxInvGroupSmoke } from './types';

export function sandboxInvAnswer(conversationId: string, text: string) {
  return apiPost<{ ok: true }>('/admin/sandbox/investment/answer', { conversationId, text });
}
export function sandboxInvExtract(conversationId: string) {
  return apiPost<SandboxInvDraft>('/admin/sandbox/investment/extract', { conversationId });
}
export function sandboxInvConfig(projectId: string, draft: SandboxInvDraft) {
  return apiPost<{ id: string }>('/admin/sandbox/investment/config', { projectId, ...draft });
}
export function sandboxInvOpportunity(configId: string, label: string, advisorName?: string, advisorCompany?: string) {
  return apiPost<{ id: string; label: string }>('/admin/sandbox/investment/opportunity', { configId, label, advisorName, advisorCompany });
}
export function sandboxInvSourceComparison(opportunityId: string, sourceUrl: string) {
  return apiPost<{ id: string; sourceUrl: string; sourceTextLength: number; sourceTextPreview: string }>('/admin/sandbox/investment/source-comparison', { opportunityId, sourceUrl });
}
export function sandboxInvComparison(configId: string) {
  return apiGet<SandboxInvComparison>(`/admin/sandbox/investment/comparison/${configId}`);
}
export function sandboxInvGroupSmoke(pledgedAmount?: number) {
  return apiPost<SandboxInvGroupSmoke>('/admin/sandbox/investment/group-smoke', { pledgedAmount });
}

// ── Sandbox: подбор персонала (Пункт [sandbox-interview-pool] 2026-09-01) ──
// Этап 3 доменного покрытия: extract (с compliance-флагами) → конфиг →
// анкета (AI-черновик → фиксация) → кандидат → релевантность → отчёт.
import type { SandboxIpDraft, SandboxIpQuestionnaireItem, SandboxIpRelevance, SandboxIpSummaryReport, SandboxIpTeamSmoke } from './types';

export function sandboxIpAnswer(conversationId: string, text: string) {
  return apiPost<{ ok: true }>('/admin/sandbox/interview-pool/answer', { conversationId, text });
}
export function sandboxIpExtract(conversationId: string) {
  return apiPost<SandboxIpDraft>('/admin/sandbox/interview-pool/extract', { conversationId });
}
export function sandboxIpConfig(projectId: string, draft: SandboxIpDraft) {
  return apiPost<{ id: string }>('/admin/sandbox/interview-pool/config', { projectId, draft });
}
export function sandboxIpQuestionnaireDraft(projectId: string) {
  return apiPost<{ items: SandboxIpQuestionnaireItem[] }>('/admin/sandbox/interview-pool/questionnaire-draft', { projectId });
}
export function sandboxIpQuestionnaireFix(projectId: string, items: SandboxIpQuestionnaireItem[]) {
  return apiPost<{ count: number }>('/admin/sandbox/interview-pool/questionnaire-fix', { projectId, items });
}
export function sandboxIpCandidate(projectId: string, displayName: string, resumeText?: string) {
  return apiPost<{ candidateProfileId: string; statusId: string; stage: string }>('/admin/sandbox/interview-pool/candidate', { projectId, displayName, resumeText });
}
export function sandboxIpRelevance(projectId: string) {
  return apiPost<SandboxIpRelevance>('/admin/sandbox/interview-pool/relevance', { projectId });
}
export function sandboxIpSummaryReport(projectId: string) {
  return apiPost<SandboxIpSummaryReport>('/admin/sandbox/interview-pool/summary-report', { projectId });
}
export function sandboxIpTeamSmoke() {
  return apiPost<SandboxIpTeamSmoke>('/admin/sandbox/interview-pool/team-smoke', {});
}

// ── Sandbox: семейное право (Пункт [sandbox-family-law] 2026-09-01) ──
// Этап 4 доменного покрытия: extract → конфиг → стороны → активы →
// бюджет → черновик протокола урегулирования (с дисклеймером §3.6).
import type { SandboxFlBudget, SandboxFlDraft, SandboxFlSettlementDraft } from './types';

export function sandboxFlAnswer(conversationId: string, text: string) {
  return apiPost<{ ok: true }>('/admin/sandbox/family-law/answer', { conversationId, text });
}
export function sandboxFlExtract(conversationId: string) {
  return apiPost<SandboxFlDraft>('/admin/sandbox/family-law/extract', { conversationId });
}
export function sandboxFlConfig(projectId: string, draft: SandboxFlDraft) {
  return apiPost<{ id: string }>('/admin/sandbox/family-law/config', { projectId, ...draft });
}
export function sandboxFlParty(configId: string, role: 'SELF' | 'SPOUSE', displayName?: string) {
  return apiPost<{ id: string; role: string }>('/admin/sandbox/family-law/party', { configId, role, displayName });
}
export function sandboxFlAsset(configId: string, assetType: string, estimatedValue?: number, currency?: string, isMaritalProperty?: boolean) {
  return apiPost<{ id: string }>('/admin/sandbox/family-law/asset', { configId, assetType, estimatedValue, currency, isMaritalProperty });
}
export function sandboxFlBudgetItem(configId: string, category: string, direction: string, amount: number, currency?: string) {
  return apiPost<SandboxFlBudget>('/admin/sandbox/family-law/budget-item', { configId, category, direction, amount, currency });
}
export function sandboxFlSettlementDraft(configId: string) {
  return apiGet<SandboxFlSettlementDraft>(`/admin/sandbox/family-law/settlement-draft/${configId}`);
}

// ── Sandbox: ДТП (Пункт [sandbox-dtp] 2026-09-01) ──
// Этап 5 доменного покрытия: extract → конфиг → участники → вина →
// доказательства (chain of custody: sha256 сервером + журнал доступа) →
// черновик протокола. По доказательствам НИКОГДА нет AI (§3.1/3.4).
import type { SandboxDtpDraft, SandboxDtpEvidence } from './types';

export function sandboxDtpAnswer(conversationId: string, text: string) {
  return apiPost<{ ok: true }>('/admin/sandbox/dtp/answer', { conversationId, text });
}
export function sandboxDtpExtract(conversationId: string) {
  return apiPost<SandboxDtpDraft>('/admin/sandbox/dtp/extract', { conversationId });
}
export function sandboxDtpConfig(projectId: string, draft: SandboxDtpDraft) {
  return apiPost<{ id: string }>('/admin/sandbox/dtp/config', { projectId, ...draft });
}
export function sandboxDtpParticipant(configId: string, role: 'SELF' | 'OTHER_PARTY' | 'THIRD_PARTY', displayName?: string, hasFledScene?: boolean) {
  return apiPost<{ id: string; role: string }>('/admin/sandbox/dtp/participant', { configId, role, displayName, hasFledScene });
}
export function sandboxDtpFault(configId: string, source: string, statusText: string, isOfficial?: boolean) {
  return apiPost<{ id: string }>('/admin/sandbox/dtp/fault', { configId, source, statusText, isOfficial });
}
export function sandboxDtpEvidence(configId: string, base64Content: string, contentType: string) {
  return apiPost<SandboxDtpEvidence>('/admin/sandbox/dtp/evidence', { configId, base64Content, contentType });
}
export function sandboxDtpSettlementDraft(configId: string) {
  return apiGet<SandboxFlSettlementDraft>(`/admin/sandbox/dtp/settlement-draft/${configId}`);
}

// ── Sandbox: b-подэтапы (Пункт [sandbox-domain-conversations] 2026-09-01) ──
// Разговор, загруженный в доменный проект (Шаг 2 с целевым проектом),
// привязывается к встрече/консультации/интервью + продовый AI-разбор.

export function sandboxMpMeetingConclusion(variantId: string, conversationId: string) {
  return apiPost<{ meetingId: string; conclusionDraft: string | null; criteriaBreakdown: unknown }>('/admin/sandbox/major-purchase/meeting-conclusion', { variantId, conversationId });
}
export function sandboxInvMeetingBreakdown(opportunityId: string, conversationId: string) {
  return apiPost<{ meetingId: string; criteriaBreakdown: unknown }>('/admin/sandbox/investment/meeting-breakdown', { opportunityId, conversationId });
}
export function sandboxIpAttachInterview(projectId: string, conversationId: string) {
  return apiPost<{ statusId: string; stageName: string; note: string }>('/admin/sandbox/interview-pool/attach-interview', { projectId, conversationId });
}
export function sandboxFlConsultationBreakdown(configId: string, conversationId: string, advisorLabel?: string) {
  return apiPost<{ advisorId: string; consultationId: string; criteriaBreakdown: unknown }>('/admin/sandbox/family-law/consultation-breakdown', { configId, conversationId, advisorLabel });
}
export function sandboxDtpConsultationBreakdown(configId: string, conversationId: string, advisorLabel?: string) {
  return apiPost<{ advisorId: string; consultationId: string; criteriaBreakdown: unknown }>('/admin/sandbox/dtp/consultation-breakdown', { configId, conversationId, advisorLabel });
}

// ── Sandbox: поиск работы (Пункт [job-search] 2026-09-01, седьмой домен) ──
// CV (AI-черновик → утверждение) → вакансии по ссылкам с локальных
// джоб-сайтов (без кроулинга — ссылки приносит человек) → AI-сверка с
// CV → детерминированная статистика.
import type { SandboxJsCv, SandboxJsDraft, SandboxJsStatistics, SandboxJsVacancyMatch } from './types';

export function sandboxJsAnswer(conversationId: string, text: string) {
  return apiPost<{ ok: true }>('/admin/sandbox/job-search/answer', { conversationId, text });
}
export function sandboxJsExtract(conversationId: string) {
  return apiPost<SandboxJsDraft>('/admin/sandbox/job-search/extract', { conversationId });
}
export function sandboxJsConfig(projectId: string, draft: SandboxJsDraft) {
  return apiPost<{ id: string }>('/admin/sandbox/job-search/config', { projectId, draft });
}
export function sandboxJsCvDraft(projectId: string) {
  return apiPost<SandboxJsCv>('/admin/sandbox/job-search/cv-draft', { projectId });
}
export function sandboxJsCvReview(projectId: string) {
  return apiPost<{ cvReviewedAt: string | null }>('/admin/sandbox/job-search/cv-review', { projectId });
}
export function sandboxJsVacancy(projectId: string, sourceUrl: string) {
  return apiPost<{ id: string; siteHost: string; sourceUrl: string; rawTextLength: number }>('/admin/sandbox/job-search/vacancy', { projectId, sourceUrl });
}
export function sandboxJsVacancyMatch(vacancyId: string) {
  return apiPost<SandboxJsVacancyMatch>('/admin/sandbox/job-search/vacancy-match', { vacancyId });
}
export function sandboxJsStatistics(projectId: string) {
  return apiGet<SandboxJsStatistics>(`/admin/sandbox/job-search/statistics/${projectId}`);
}

// ── Sandbox: голосовая заметка ru/uk (Пункт [voice-note-ru] 2026-09-01) ──
// Стриминг AssemblyAI не поддерживает русский/украинский — короткая
// запись уходит async-путём (universal). Аудио у нас не персистуется.
export function sandboxVoiceNote(base64Content: string, languageCode?: string) {
  return apiPost<{ text: string; language: string | null }>('/admin/sandbox/voice-note', { base64Content, languageCode });
}

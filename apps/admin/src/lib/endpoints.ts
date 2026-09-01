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
export function createSandboxUploadConversation(isVideo: boolean, durationSeconds?: number) {
  return apiPost<{ projectId: string; conversationId: string }>('/admin/sandbox/upload-conversation', {
    isVideo,
    durationSeconds,
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
import type { SandboxAnalysis, SandboxFactCheck, SandboxQueue, SandboxYouTubeResult } from './types';

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
export function sandboxFactCheck(conversationId: string) {
  return apiPost<SandboxFactCheck>(`/admin/sandbox/fact-check/${conversationId}`, {});
}

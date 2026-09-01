// Пункт [admin-sandbox] 2026-08-31 — контроллер песочницы. Тонкий слой
// над AdminSandboxService: авторизация — AdminSessionGuard (та же
// httpOnly-cookie, что у остальной админки), проверка isOperator — в
// сервисе, как у admin-users (граница по роли живёт рядом с логикой,
// а не в декораторах, которые легко забыть на новом методе).

import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { AdminSandboxService, SandboxAnalysisKind } from './admin-sandbox.service';

class YouTubeSearchDto {
  query!: string;
}

class AnalyzeDto {
  conversationId!: string;
  kind!: SandboxAnalysisKind;
}

// Вторая итерация 2026-08-31 — загрузка реального файла из песочницы.
class CreateUploadConversationDto {
  isVideo?: boolean;
  durationSeconds?: number;
  /** Пункт [sandbox-domain-conversations]: загрузка прямо в доменный
   * проект (b-подэтапы). Пусто = песочный проект, как раньше. */
  targetProjectId?: string;
}

class UploadTokenDto {
  conversationId!: string;
  pathname!: string;
}

class ConfirmUploadDto {
  conversationId!: string;
  pathname!: string;
}

class TranscribeDto {
  conversationId!: string;
  languageCode?: string;
}

// Третья итерация 2026-08-31 — песочная очередь медиа-разбора.
class AddToQueueDto {
  youtubeVideoId!: string;
  title!: string;
  channelName!: string;
  thumbnailUrl!: string;
  durationSeconds?: number;
  publishedAt?: string;
}

class LinkQueueItemDto {
  itemId!: string;
  conversationId!: string;
}

class RetryQueueItemDto {
  itemId!: string;
}

class IntakeStartDto {
  text!: string;
}

class IntakeAnswerDto {
  sessionId!: string;
  text!: string;
}

class IntakeDispatchDto {
  sessionId!: string;
  scenario!: string;
  contractType?: 'PRENUP' | 'DIVORCE_SETTLEMENT';
}

class HealthAnswerDto {
  conversationId!: string;
  text!: string;
}

class HealthExtractDto {
  conversationId!: string;
}

class HealthConfigDto {
  projectId!: string;
  goalDescription!: string;
  targetBudget?: number | null;
  currency?: string | null;
  criteria!: Array<{ text: string; category: string; isRequired: boolean; orderIndex: number }>;
}

@Controller('admin/sandbox')
@UseGuards(AdminSessionGuard)
@UseInterceptors(ApiResponseInterceptor)
export class AdminSandboxController {
  constructor(private readonly sandbox: AdminSandboxService) {}

  @Get('status')
  async status(@CurrentUser() userId: string) {
    return this.sandbox.getStatus(userId);
  }

  @Post('consents')
  async grantConsents(@CurrentUser() userId: string) {
    return this.sandbox.grantOwnConsents(userId);
  }

  @Post('youtube-search')
  async youtubeSearch(@CurrentUser() userId: string, @Body() dto: YouTubeSearchDto) {
    return this.sandbox.youtubeSearch(userId, dto.query);
  }

  @Post('transcription')
  async runTranscription(@CurrentUser() userId: string) {
    return this.sandbox.runTranscriptionSmoke(userId);
  }

  @Get('conversation/:id')
  async conversation(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.sandbox.getConversation(userId, id);
  }

  @Post('analyze')
  async analyze(@CurrentUser() userId: string, @Body() dto: AnalyzeDto) {
    return this.sandbox.analyze(userId, dto.conversationId, dto.kind);
  }

  // ── Загрузка реального аудио/видео (вторая итерация 2026-08-31) ──
  // В отличие от TMA-эндпоинта выдачи токена (audio-upload.controller.ts,
  // без интерцептора — его ответ разбирает SDK), здесь ответ в НАШЕМ
  // конверте: клиентскую половину протокола админка выполняет сама
  // (put() с готовым токеном), поэтому обычный формат уместен.

  @Post('upload-conversation')
  async createUploadConversation(@CurrentUser() userId: string, @Body() dto: CreateUploadConversationDto) {
    return this.sandbox.createUploadConversation(userId, dto.isVideo ?? false, dto.durationSeconds, dto.targetProjectId);
  }

  @Post('upload-token')
  async uploadToken(@CurrentUser() userId: string, @Body() dto: UploadTokenDto) {
    return this.sandbox.issueUploadClientToken(userId, dto.conversationId, dto.pathname);
  }

  @Post('confirm-upload')
  async confirmUpload(@CurrentUser() userId: string, @Body() dto: ConfirmUploadDto) {
    return this.sandbox.confirmUpload(userId, dto.conversationId, dto.pathname);
  }

  @Post('transcribe')
  async transcribe(@CurrentUser() userId: string, @Body() dto: TranscribeDto) {
    return this.sandbox.transcribeUploaded(userId, dto.conversationId, dto.languageCode);
  }

  // ── Песочная очередь медиа-разбора (третья итерация 2026-08-31) ──

  @Post('queue/items')
  async addToQueue(@CurrentUser() userId: string, @Body() dto: AddToQueueDto) {
    return this.sandbox.addToQueue(userId, dto);
  }

  @Post('queue/link')
  async linkQueueItem(@CurrentUser() userId: string, @Body() dto: LinkQueueItemDto) {
    return this.sandbox.linkQueueItem(userId, dto.itemId, dto.conversationId);
  }

  @Get('queue')
  async queue(@CurrentUser() userId: string) {
    return this.sandbox.getSandboxQueue(userId);
  }

  @Post('queue/retry')
  async retryQueueItem(@CurrentUser() userId: string, @Body() dto: RetryQueueItemDto) {
    return this.sandbox.retryQueueItem(userId, dto.itemId);
  }

  @Get('analysis/:conversationId')
  async analysis(@CurrentUser() userId: string, @Param('conversationId') conversationId: string) {
    return this.sandbox.getAnalysis(userId, conversationId);
  }

  @Post('queue/diagnose')
  async diagnoseQueueItem(@CurrentUser() userId: string, @Body() dto: RetryQueueItemDto) {
    return this.sandbox.diagnoseQueueItem(userId, dto.itemId);
  }

  @Post('intake/start')
  async intakeStart(@CurrentUser() userId: string, @Body() dto: IntakeStartDto) {
    return this.sandbox.intakeStart(userId, dto.text);
  }

  @Post('intake/answer')
  async intakeAnswer(@CurrentUser() userId: string, @Body() dto: IntakeAnswerDto) {
    return this.sandbox.intakeAnswer(userId, dto.sessionId, dto.text);
  }

  @Post('intake/dispatch')
  async intakeDispatch(@CurrentUser() userId: string, @Body() dto: IntakeDispatchDto) {
    return this.sandbox.intakeDispatch(userId, dto.sessionId, dto.scenario as never, dto.contractType);
  }

  @Post('health/answer')
  async healthAnswer(@CurrentUser() userId: string, @Body() dto: HealthAnswerDto) {
    return this.sandbox.healthAppendAnswer(userId, dto.conversationId, dto.text);
  }

  @Post('health/extract')
  async healthExtract(@CurrentUser() userId: string, @Body() dto: HealthExtractDto) {
    return this.sandbox.healthExtract(userId, dto.conversationId);
  }

  @Post('health/config')
  async healthConfig(@CurrentUser() userId: string, @Body() dto: HealthConfigDto) {
    return this.sandbox.healthCreateConfig(userId, dto.projectId, {
      goalDescription: dto.goalDescription,
      targetBudget: dto.targetBudget ?? null,
      currency: dto.currency ?? null,
      criteria: dto.criteria as never,
    });
  }

  @Post('transcription-token')
  async transcriptionToken(@CurrentUser() userId: string) {
    return this.sandbox.mintTranscriptionToken(userId);
  }

  // Пункт [voice-note-ru] 2026-09-01 — голосовая заметка для ru/uk
  // (стриминг AssemblyAI эти языки не поддерживает).
  @Post('voice-note')
  async voiceNote(@CurrentUser() userId: string, @Body() dto: { base64Content: string; languageCode?: string }) {
    return this.sandbox.sandboxVoiceNote(userId, dto.base64Content, dto.languageCode);
  }

  @Post('health/lab-document')
  async healthLabDocument(@CurrentUser() userId: string, @Body() dto: { configId: string; base64Content: string }) {
    return this.sandbox.healthUploadLabDocument(userId, dto.configId, dto.base64Content);
  }

  @Post('health/lab-verify')
  async healthLabVerify(@CurrentUser() userId: string, @Body() dto: { draftId: string }) {
    return this.sandbox.healthVerifyLabDocument(userId, dto.draftId);
  }

  @Post('fact-check/:conversationId')
  async factCheck(@CurrentUser() userId: string, @Param('conversationId') conversationId: string) {
    return this.sandbox.factCheckConversation(userId, conversationId);
  }

  // ── Пункт [sandbox-major-purchase] 2026-09-01 — этап 1 доменного
  // покрытия: цикл крупной покупки до сравнительной таблицы. ──

  @Post('major-purchase/answer')
  async mpAnswer(@CurrentUser() userId: string, @Body() dto: { conversationId: string; text: string }) {
    return this.sandbox.mpAppendAnswer(userId, dto.conversationId, dto.text);
  }

  @Post('major-purchase/checklist')
  async mpChecklist(@CurrentUser() userId: string, @Body() dto: { conversationId: string; category: 'REAL_ESTATE' | 'VEHICLE' }) {
    return this.sandbox.mpChecklist(userId, dto.conversationId, dto.category as never);
  }

  @Post('major-purchase/extract')
  async mpExtract(@CurrentUser() userId: string, @Body() dto: { conversationId: string; category: 'REAL_ESTATE' | 'VEHICLE' }) {
    return this.sandbox.mpExtract(userId, dto.conversationId, dto.category as never);
  }

  @Post('major-purchase/config')
  async mpConfig(
    @CurrentUser() userId: string,
    @Body()
    dto: {
      projectId: string;
      category: 'REAL_ESTATE' | 'VEHICLE';
      goalDescription: string;
      budgetMin?: number | null;
      budgetMax?: number | null;
      currency?: string | null;
      financingMethod?: string | null;
      timeline?: string | null;
      criteria: Array<{ text: string; isRequired: boolean; orderIndex: number }>;
    },
  ) {
    return this.sandbox.mpCreateConfig(userId, dto.projectId, dto.category as never, {
      goalDescription: dto.goalDescription,
      budgetMin: dto.budgetMin ?? null,
      budgetMax: dto.budgetMax ?? null,
      currency: dto.currency ?? null,
      financingMethod: dto.financingMethod ?? null,
      timeline: dto.timeline ?? null,
      criteria: dto.criteria,
    });
  }

  @Post('major-purchase/variant')
  async mpVariant(@CurrentUser() userId: string, @Body() dto: { configId: string; label: string; askingPrice?: number; currency?: string }) {
    return this.sandbox.mpAddVariant(userId, dto.configId, dto.label, dto.askingPrice, dto.currency);
  }

  @Get('major-purchase/comparison/:configId')
  async mpComparison(@CurrentUser() userId: string, @Param('configId') configId: string) {
    return this.sandbox.mpComparisonTable(userId, configId);
  }

  // ── Пункт [sandbox-investment] 2026-09-01 — этап 2 доменного
  // покрытия: цикл инвестиций + смоук групповой механики. ──

  @Post('investment/answer')
  async invAnswer(@CurrentUser() userId: string, @Body() dto: { conversationId: string; text: string }) {
    return this.sandbox.invAppendAnswer(userId, dto.conversationId, dto.text);
  }

  @Post('investment/extract')
  async invExtract(@CurrentUser() userId: string, @Body() dto: { conversationId: string }) {
    return this.sandbox.invExtract(userId, dto.conversationId);
  }

  @Post('investment/config')
  async invConfig(
    @CurrentUser() userId: string,
    @Body()
    dto: {
      projectId: string;
      goalDescription: string;
      targetBudget?: number | null;
      currency?: string | null;
      criteria: Array<{ text: string; category: string; isRequired: boolean; orderIndex: number }>;
    },
  ) {
    return this.sandbox.invCreateConfig(userId, dto.projectId, {
      goalDescription: dto.goalDescription,
      targetBudget: dto.targetBudget ?? null,
      currency: dto.currency ?? null,
      criteria: dto.criteria as never,
    });
  }

  @Post('investment/opportunity')
  async invOpportunity(
    @CurrentUser() userId: string,
    @Body() dto: { configId: string; label: string; advisorName?: string; advisorCompany?: string },
  ) {
    return this.sandbox.invAddOpportunity(userId, dto.configId, dto.label, dto.advisorName, dto.advisorCompany);
  }

  @Post('investment/source-comparison')
  async invSource(@CurrentUser() userId: string, @Body() dto: { opportunityId: string; sourceUrl: string }) {
    return this.sandbox.invSourceComparison(userId, dto.opportunityId, dto.sourceUrl);
  }

  @Get('investment/comparison/:configId')
  async invComparison(@CurrentUser() userId: string, @Param('configId') configId: string) {
    return this.sandbox.invComparisonTable(userId, configId);
  }

  @Post('investment/group-smoke')
  async invGroupSmoke(@CurrentUser() userId: string, @Body() dto: { pledgedAmount?: number }) {
    return this.sandbox.invGroupSmoke(userId, dto.pledgedAmount ?? 50000);
  }

  // ── Пункт [sandbox-interview-pool] 2026-09-01 — этап 3 доменного
  // покрытия: подбор персонала до сводного отчёта. ──

  @Post('interview-pool/answer')
  async ipAnswer(@CurrentUser() userId: string, @Body() dto: { conversationId: string; text: string }) {
    return this.sandbox.ipAppendAnswer(userId, dto.conversationId, dto.text);
  }

  @Post('interview-pool/extract')
  async ipExtract(@CurrentUser() userId: string, @Body() dto: { conversationId: string }) {
    return this.sandbox.ipExtract(userId, dto.conversationId);
  }

  @Post('interview-pool/config')
  async ipConfig(@CurrentUser() userId: string, @Body() dto: { projectId: string; draft: Record<string, unknown> }) {
    return this.sandbox.ipCreateConfig(userId, dto.projectId, dto.draft as never);
  }

  @Post('interview-pool/questionnaire-draft')
  async ipQuestionnaireDraft(@CurrentUser() userId: string, @Body() dto: { projectId: string }) {
    return this.sandbox.ipQuestionnaireDraft(userId, dto.projectId);
  }

  @Post('interview-pool/questionnaire-fix')
  async ipQuestionnaireFix(
    @CurrentUser() userId: string,
    @Body() dto: { projectId: string; items: Array<{ text: string; category: string | null; orderIndex: number; isRequired: boolean }> },
  ) {
    return this.sandbox.ipFixQuestionnaire(userId, dto.projectId, dto.items as never);
  }

  @Post('interview-pool/candidate')
  async ipCandidate(@CurrentUser() userId: string, @Body() dto: { projectId: string; displayName: string; resumeText?: string }) {
    return this.sandbox.ipAddCandidate(userId, dto.projectId, dto.displayName, dto.resumeText);
  }

  @Post('interview-pool/relevance')
  async ipRelevance(@CurrentUser() userId: string, @Body() dto: { projectId: string }) {
    return this.sandbox.ipRelevance(userId, dto.projectId);
  }

  @Post('interview-pool/summary-report')
  async ipSummaryReport(@CurrentUser() userId: string, @Body() dto: { projectId: string }) {
    return this.sandbox.ipSummaryReport(userId, dto.projectId);
  }

  @Post('interview-pool/team-smoke')
  async ipTeamSmoke(@CurrentUser() userId: string) {
    return this.sandbox.ipTeamSmoke(userId);
  }

  // ── Пункт [sandbox-family-law] 2026-09-01 — этап 4 доменного
  // покрытия: семейное право до черновика протокола урегулирования. ──

  @Post('family-law/answer')
  async flAnswer(@CurrentUser() userId: string, @Body() dto: { conversationId: string; text: string }) {
    return this.sandbox.flAppendAnswer(userId, dto.conversationId, dto.text);
  }

  @Post('family-law/extract')
  async flExtract(@CurrentUser() userId: string, @Body() dto: { conversationId: string }) {
    return this.sandbox.flExtract(userId, dto.conversationId);
  }

  @Post('family-law/config')
  async flConfig(
    @CurrentUser() userId: string,
    @Body()
    dto: {
      projectId: string;
      goalDescription: string;
      targetBudget?: number | null;
      currency?: string | null;
      criteria: Array<{ text: string; category: string; isRequired: boolean; orderIndex: number }>;
    },
  ) {
    return this.sandbox.flCreateConfig(userId, dto.projectId, {
      goalDescription: dto.goalDescription,
      targetBudget: dto.targetBudget ?? null,
      currency: dto.currency ?? null,
      criteria: dto.criteria as never,
    });
  }

  @Post('family-law/party')
  async flParty(@CurrentUser() userId: string, @Body() dto: { configId: string; role: 'SELF' | 'SPOUSE'; displayName?: string }) {
    return this.sandbox.flAddParty(userId, dto.configId, dto.role, dto.displayName);
  }

  @Post('family-law/asset')
  async flAsset(
    @CurrentUser() userId: string,
    @Body() dto: { configId: string; assetType: string; estimatedValue?: number; currency?: string; isMaritalProperty?: boolean },
  ) {
    return this.sandbox.flAddAsset(userId, dto.configId, dto.assetType, dto.estimatedValue, dto.currency, dto.isMaritalProperty);
  }

  @Post('family-law/budget-item')
  async flBudgetItem(
    @CurrentUser() userId: string,
    @Body() dto: { configId: string; category: string; direction: string; amount: number; currency?: string },
  ) {
    return this.sandbox.flAddBudgetItem(userId, dto.configId, dto.category, dto.direction, dto.amount, dto.currency);
  }

  @Get('family-law/settlement-draft/:configId')
  async flSettlementDraft(@CurrentUser() userId: string, @Param('configId') configId: string) {
    return this.sandbox.flSettlementDraft(userId, configId);
  }

  // ── Пункт [sandbox-dtp] 2026-09-01 — этап 5 доменного покрытия:
  // ДТП до реестра доказательств и черновика протокола. ──

  @Post('dtp/answer')
  async dtpAnswer(@CurrentUser() userId: string, @Body() dto: { conversationId: string; text: string }) {
    return this.sandbox.dtpAppendAnswer(userId, dto.conversationId, dto.text);
  }

  @Post('dtp/extract')
  async dtpExtract(@CurrentUser() userId: string, @Body() dto: { conversationId: string }) {
    return this.sandbox.dtpExtract(userId, dto.conversationId);
  }

  @Post('dtp/config')
  async dtpConfig(
    @CurrentUser() userId: string,
    @Body()
    dto: {
      projectId: string;
      goalDescription: string;
      targetBudget?: number | null;
      currency?: string | null;
      occurredAt?: string | null;
      criteria: Array<{ text: string; category: string; isRequired: boolean; orderIndex: number }>;
    },
  ) {
    return this.sandbox.dtpCreateConfig(userId, dto.projectId, {
      goalDescription: dto.goalDescription,
      targetBudget: dto.targetBudget ?? null,
      currency: dto.currency ?? null,
      occurredAt: dto.occurredAt ?? null,
      criteria: dto.criteria as never,
    });
  }

  @Post('dtp/participant')
  async dtpParticipant(
    @CurrentUser() userId: string,
    @Body() dto: { configId: string; role: 'SELF' | 'OTHER_PARTY' | 'THIRD_PARTY'; displayName?: string; hasFledScene?: boolean },
  ) {
    return this.sandbox.dtpAddParticipant(userId, dto.configId, dto.role, dto.displayName, dto.hasFledScene);
  }

  @Post('dtp/fault')
  async dtpFault(
    @CurrentUser() userId: string,
    @Body() dto: { configId: string; source: string; statusText: string; isOfficial?: boolean },
  ) {
    return this.sandbox.dtpFault(userId, dto.configId, dto.source, dto.statusText, dto.isOfficial);
  }

  @Post('dtp/evidence')
  async dtpEvidence(
    @CurrentUser() userId: string,
    @Body() dto: { configId: string; base64Content: string; contentType: string },
  ) {
    return this.sandbox.dtpUploadEvidence(userId, dto.configId, dto.base64Content, dto.contentType);
  }

  @Get('dtp/settlement-draft/:configId')
  async dtpSettlementDraft(@CurrentUser() userId: string, @Param('configId') configId: string) {
    return this.sandbox.dtpSettlementDraft(userId, configId);
  }

  // ── Пункт [job-search] 2026-09-01 — седьмой домен: CV + вакансии. ──

  @Post('job-search/answer')
  async jsAnswer(@CurrentUser() userId: string, @Body() dto: { conversationId: string; text: string }) {
    return this.sandbox.jsAppendAnswer(userId, dto.conversationId, dto.text);
  }

  @Post('job-search/extract')
  async jsExtract(@CurrentUser() userId: string, @Body() dto: { conversationId: string }) {
    return this.sandbox.jsExtract(userId, dto.conversationId);
  }

  @Post('job-search/config')
  async jsConfig(@CurrentUser() userId: string, @Body() dto: { projectId: string; draft: Record<string, unknown> }) {
    return this.sandbox.jsCreateConfig(userId, dto.projectId, dto.draft as never);
  }

  @Post('job-search/cv-draft')
  async jsCvDraft(@CurrentUser() userId: string, @Body() dto: { projectId: string }) {
    return this.sandbox.jsCvDraft(userId, dto.projectId);
  }

  @Post('job-search/cv-review')
  async jsCvReview(@CurrentUser() userId: string, @Body() dto: { projectId: string }) {
    return this.sandbox.jsCvReview(userId, dto.projectId);
  }

  @Post('job-search/vacancy')
  async jsVacancy(@CurrentUser() userId: string, @Body() dto: { projectId: string; sourceUrl: string }) {
    return this.sandbox.jsAddVacancy(userId, dto.projectId, dto.sourceUrl);
  }

  @Post('job-search/vacancy-match')
  async jsVacancyMatch(@CurrentUser() userId: string, @Body() dto: { vacancyId: string }) {
    return this.sandbox.jsMatchVacancy(userId, dto.vacancyId);
  }

  @Get('job-search/statistics/:projectId')
  async jsStatistics(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.sandbox.jsStatistics(userId, projectId);
  }

  // ── Пункт [sandbox-domain-conversations] 2026-09-01 — b-подэтапы:
  // привязка расшифрованного разговора + продовый AI-разбор. ──

  @Post('major-purchase/meeting-conclusion')
  async mpMeetingConclusion(@CurrentUser() userId: string, @Body() dto: { variantId: string; conversationId: string }) {
    return this.sandbox.mpMeetingConclusion(userId, dto.variantId, dto.conversationId);
  }

  @Post('investment/meeting-breakdown')
  async invMeetingBreakdown(@CurrentUser() userId: string, @Body() dto: { opportunityId: string; conversationId: string }) {
    return this.sandbox.invMeetingBreakdown(userId, dto.opportunityId, dto.conversationId);
  }

  @Post('interview-pool/attach-interview')
  async ipAttachInterview(
    @CurrentUser() userId: string,
    @Body() dto: { projectId: string; conversationId: string; candidateStatusId?: string },
  ) {
    return this.sandbox.ipAttachInterview(userId, dto.projectId, dto.conversationId, dto.candidateStatusId);
  }

  @Post('family-law/consultation-breakdown')
  async flConsultationBreakdown(
    @CurrentUser() userId: string,
    @Body() dto: { configId: string; advisorLabel?: string; conversationId: string },
  ) {
    return this.sandbox.flConsultationBreakdown(userId, dto.configId, dto.advisorLabel ?? '', dto.conversationId);
  }

  @Post('dtp/consultation-breakdown')
  async dtpConsultationBreakdown(
    @CurrentUser() userId: string,
    @Body() dto: { configId: string; advisorLabel?: string; conversationId: string },
  ) {
    return this.sandbox.dtpConsultationBreakdown(userId, dto.configId, dto.advisorLabel ?? '', dto.conversationId);
  }
}

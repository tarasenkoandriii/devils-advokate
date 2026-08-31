// Пункт [interview-pool]: контролер поверх усіх сервісів модуля,
// devils-advocate-interview-pool-tz.md §5.
//
// Шляхи ВІДРІЗНЯЮТЬСЯ від буквального §5 ТЗ у кількох місцях —
// розбіжності задокументовані в самих сервісах: (1) окремий
// POST /interview-pool/projects перед онбордінгом (той самий фікс, що
// вже застосований у Пункті [major-purchase]); (2) окремий
// POST .../answers для запису відповідей онбордінг-розмови;
// (3) POST .../stage-progress — відсутній у ТЗ ендпоінт, без якого
// PoolRelevanceSnapshot не мав би способу знайти "співбесіди
// кандидата" (CandidateProfile НЕ пов'язаний з Person напряму).

import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { NotRestrictedGuard } from '../telegram-auth/not-restricted.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getOnboardingAnswers, listDomainProjects } from '../common/domain-onboarding-reads';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { InterviewPoolOnboardingService, ExtractedPoolConfigDraft } from './interview-pool-onboarding.service';
import { InterviewPoolService, DraftQuestionnaireItem } from './interview-pool.service';
import { InterviewPoolTeamService } from './interview-pool-team.service';
import { InterviewPoolCandidateService } from './interview-pool-candidate.service';
import { InterviewPoolRelevanceService } from './interview-pool-relevance.service';
import { InterviewPoolReportService } from './interview-pool-report.service';

class CreateProjectDto {
  question!: string;
  recruitingTeamId?: string;
}

class AppendAnswerDto {
  text!: string;
}

class ConfirmConfigDto {
  jobTitle!: string;
  extendedDescription!: string;
  salaryRange?: string;
  employmentLoad?: 'FULL_TIME' | 'PART_TIME';
  workArrangement?: 'OFFICE' | 'REMOTE' | 'HYBRID';
  officeLocation?: string;
  employmentFormat?: string;
  perks!: string[];
  genderRequirement!: 'NOT_IMPORTANT' | 'MALE' | 'FEMALE' | 'OTHER';
  ageRequirement!: 'NOT_IMPORTANT' | 'RANGE';
  minAge?: number;
  maxAge?: number;
  isPhysicallyDemanding!: boolean;
  interviewStages!: Array<{ name: string; orderIndex: number; isTestAssignment: boolean; interviewerRole?: string | null }>;
  complianceFlags!: Array<{ category: string; quotedText: string }>;
}

class FixQuestionnaireDto {
  items!: DraftQuestionnaireItem[];
}

class AddCandidateDto {
  candidateProfileId!: string;
  reuseHistory?: boolean;
}

class RecordStageProgressDto {
  stageDefinitionId!: string;
  conversationId?: string;
  completedAt?: string;
}

class MarkFollowUpDto {
  fulfilled!: boolean;
}

class CreateTeamDto {
  name!: string;
}

class JoinTeamDto {
  token!: string;
}

class CreateCandidateDto {
  displayName!: string;
  contactInfo?: string;
  resumeText?: string;
  recruitingTeamId?: string;
}

class ShareCandidateDto {
  candidateConsentConfirmed!: boolean;
}

class ShareAllDto {
  candidateConsentConfirmed!: string[];
}

class SendReportDto {
  sentViaShare!: string;
}

class UpdateReportContentDto {
  content!: unknown;
}

@Controller()
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class InterviewPoolController {
  constructor(
    private readonly prisma: PrismaService, // фаза A — read-helper'ы списка/онбординга
    private readonly onboarding: InterviewPoolOnboardingService,
    private readonly pool: InterviewPoolService,
    private readonly team: InterviewPoolTeamService,
    private readonly candidates: InterviewPoolCandidateService,
    private readonly relevance: InterviewPoolRelevanceService,
    private readonly reports: InterviewPoolReportService,
  ) {}

  // ── Онбордінг (§4.8 ТЗ) ──

  @Get('interview-pool/projects')
  async listDomainProjects(@CurrentUser() userId: string, @Query('take') take?: string, @Query('skip') skip?: string) {
    return listDomainProjects(this.prisma, userId, ProjectMode.INTERVIEW_POOL, { take: take ? Number(take) : undefined, skip: skip ? Number(skip) : undefined });
  }

  @Get('interview-pool/onboarding-conversations/:id')
  async getOnboardingConversation(@CurrentUser() userId: string, @Param('id') conversationId: string) {
    return getOnboardingAnswers(this.prisma, userId, conversationId);
  }

  @Post('interview-pool/projects')
  @UseGuards(NotRestrictedGuard) // devils-advocate-admin-panel-tz.md §4.3
  async createProject(@CurrentUser() userId: string, @Body() dto: CreateProjectDto) {
    return this.onboarding.createProject(userId, dto.question, dto.recruitingTeamId);
  }

  @Get('interview-pool/onboarding-checklist')
  getChecklist() {
    return this.onboarding.getChecklist();
  }

  @Post('interview-pool/projects/:projectId/onboarding-conversations')
  async createOnboardingConversation(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.onboarding.createOnboardingConversation(userId, projectId);
  }

  @Post('interview-pool/onboarding-conversations/:id/answers')
  async appendAnswer(@CurrentUser() userId: string, @Param('id') conversationId: string, @Body() dto: AppendAnswerDto) {
    return this.onboarding.appendAnswer(userId, conversationId, dto.text);
  }

  @Post('interview-pool/onboarding-conversations/:id/extract')
  async extract(@CurrentUser() userId: string, @Param('id') conversationId: string) {
    return this.onboarding.extract(userId, conversationId);
  }

  // ── Конфіг пулу (§4.1/§4.8 ТЗ) ──

  @Post('interview-pool/projects/:projectId/config')
  async createConfig(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: ConfirmConfigDto) {
    const draft: ExtractedPoolConfigDraft = {
      jobTitle: dto.jobTitle,
      extendedDescription: dto.extendedDescription,
      salaryRange: dto.salaryRange ?? null,
      employmentLoad: (dto.employmentLoad as any) ?? null,
      workArrangement: (dto.workArrangement as any) ?? null,
      officeLocation: dto.officeLocation ?? null,
      employmentFormat: dto.employmentFormat ?? null,
      perks: dto.perks,
      genderRequirement: dto.genderRequirement as any,
      ageRequirement: dto.ageRequirement as any,
      minAge: dto.minAge ?? null,
      maxAge: dto.maxAge ?? null,
      isPhysicallyDemanding: dto.isPhysicallyDemanding,
      interviewStages: dto.interviewStages.map((s) => ({ ...s, interviewerRole: s.interviewerRole ?? null })),
      complianceFlags: dto.complianceFlags,
    };
    return this.pool.createConfig(userId, projectId, draft);
  }

  @Get('interview-pool/projects/:projectId/config')
  async getConfig(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.pool.getConfig(userId, projectId);
  }

  @Get('interview-pool/projects/:projectId/compliance-flags')
  async getComplianceFlags(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.pool.getComplianceFlags(userId, projectId);
  }

  // ── Квіз (§4.1 ТЗ) ──

  @Post('interview-pool/projects/:projectId/questionnaire/generate-draft')
  async generateQuestionnaireDraft(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.pool.generateQuestionnaireDraft(userId, projectId);
  }

  @Post('interview-pool/projects/:projectId/questionnaire')
  async fixQuestionnaire(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: FixQuestionnaireDto) {
    return this.pool.fixQuestionnaire(userId, projectId, dto.items);
  }

  // ── Кандидати (§4.7 ТЗ) ──

  @Post('interview-pool/projects/:projectId/candidates')
  async addCandidate(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: AddCandidateDto) {
    return this.pool.addCandidate(userId, projectId, dto.candidateProfileId, dto.reuseHistory ?? false);
  }

  @Get('interview-pool/projects/:projectId/candidates')
  async listCandidates(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.pool.listCandidates(userId, projectId);
  }

  @Get('interview-pool/projects/:projectId/candidates/:candidateProfileId/agenda')
  async getAgenda(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('candidateProfileId') candidateProfileId: string,
  ) {
    return this.pool.getAgenda(userId, projectId, candidateProfileId);
  }

  // Пункт [interview-pool], знахідка при реалізації — відсутній у ТЗ
  // ендпоінт, без якого CandidateStageProgress.conversationId ніколи
  // б не заповнювався (див. коментар над InterviewPoolService.recordStageProgress).
  @Post('interview-pool/pipeline-statuses/:statusId/stage-progress')
  async recordStageProgress(
    @CurrentUser() userId: string,
    @Param('statusId') statusId: string,
    @Body() dto: RecordStageProgressDto,
  ) {
    return this.pool.recordStageProgress(userId, statusId, dto.stageDefinitionId, dto.conversationId, dto.completedAt);
  }

  @Patch('interview-pool/pipeline-statuses/:statusId/follow-up/:id')
  async markFollowUp(
    @CurrentUser() userId: string,
    @Param('id') requestId: string,
    @Body() dto: MarkFollowUpDto,
  ) {
    return this.candidates.markFollowUpFulfilled(userId, requestId, dto.fulfilled);
  }

  @Get('interview-pool/pipeline-statuses/:statusId/follow-up')
  async listFollowUp(@CurrentUser() userId: string, @Param('statusId') statusId: string) {
    return this.candidates.listFollowUpRequests(userId, statusId);
  }

  // ── Порівняльне ранжування (§4.3 ТЗ) ──

  @Post('interview-pool/projects/:projectId/relevance-snapshot/regenerate')
  async regenerateSnapshot(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Query('triggerConversationId') triggerConversationId?: string,
  ) {
    return this.relevance.regenerate(userId, projectId, triggerConversationId);
  }

  @Get('interview-pool/projects/:projectId/relevance-snapshot/latest')
  async getLatestSnapshot(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.relevance.getLatest(userId, projectId);
  }

  @Get('interview-pool/projects/:projectId/relevance-snapshot/history')
  async getSnapshotHistory(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.relevance.getHistory(userId, projectId);
  }

  // ── Команди (§4.5 ТЗ) ──

  @Get('recruiting-teams')
  async listMyTeams(@CurrentUser() userId: string) {
    return this.team.listMyTeams(userId);
  }

  @Post('recruiting-teams')
  async createTeam(@CurrentUser() userId: string, @Body() dto: CreateTeamDto) {
    return this.team.createTeam(userId, dto.name);
  }

  @Post('recruiting-teams/:id/invite-link')
  async createInviteLink(@CurrentUser() userId: string, @Param('id') teamId: string) {
    return this.team.createInviteLink(userId, teamId);
  }

  @Post('recruiting-teams/:id/join')
  async joinTeam(@CurrentUser() userId: string, @Body() dto: JoinTeamDto) {
    return this.team.joinTeam(userId, dto.token);
  }

  @Get('recruiting-teams/:id/candidates')
  async listTeamCandidates(@CurrentUser() userId: string, @Param('id') teamId: string) {
    return this.team.listCandidates(userId, teamId);
  }

  // ── Кандидати й обмін (§4.6 ТЗ) ──

  @Get('candidate-profiles')
  async listMyCandidates(@CurrentUser() userId: string) {
    return this.candidates.listMyCandidates(userId);
  }

  @Post('candidate-profiles')
  async createCandidate(@CurrentUser() userId: string, @Body() dto: CreateCandidateDto) {
    return this.candidates.createCandidate(userId, dto.displayName, dto.contactInfo, dto.resumeText, dto.recruitingTeamId);
  }

  @Post('candidate-profiles/:id/share')
  async shareCandidate(@CurrentUser() userId: string, @Param('id') candidateProfileId: string, @Body() dto: ShareCandidateDto) {
    return this.candidates.shareCandidate(userId, candidateProfileId, dto.candidateConsentConfirmed);
  }

  @Post('interview-pool/projects/:projectId/share-all')
  async shareAll(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: ShareAllDto) {
    return this.candidates.shareAllInPool(userId, projectId, dto.candidateConsentConfirmed);
  }
}

// Публічний (share-preview/accept) контролер — окремий клас, БЕЗ
// TelegramAuthGuard на preview (той самий принцип, що
// PublicDiscussionPublicController: знання токена в URL і є
// "авторизація"), accept вимагає авторизації (створює новий запис
// власнику).
@Controller('candidate-shares')
@UseInterceptors(ApiResponseInterceptor)
export class InterviewPoolShareController {
  constructor(private readonly candidates: InterviewPoolCandidateService) {}

  @Get(':token/preview')
  async preview(@Param('token') token: string) {
    return this.candidates.previewShare(token);
  }

  @Post(':shareId/accept')
  @UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
  async accept(@CurrentUser() userId: string, @Param('shareId') shareId: string) {
    return this.candidates.acceptShare(userId, shareId);
  }
}

// Звіти для замовника (§4.9 ТЗ) — окремий контролер, той самий guard.
@Controller('client-reports')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ClientReportController {
  constructor(private readonly reports: InterviewPoolReportService) {}

  @Post('projects/:projectId/candidate/:candidateProfileId')
  async generateCandidateReport(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('candidateProfileId') candidateProfileId: string,
  ) {
    return this.reports.generateCandidateReport(userId, projectId, candidateProfileId);
  }

  @Post('projects/:projectId/summary')
  async generateSummaryReport(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.reports.generateSummaryReport(userId, projectId);
  }

  @Patch(':id')
  async updateContent(@CurrentUser() userId: string, @Param('id') reportId: string, @Body() dto: UpdateReportContentDto) {
    return this.reports.updateContent(userId, reportId, dto.content);
  }

  @Post(':id/review')
  async review(@CurrentUser() userId: string, @Param('id') reportId: string) {
    return this.reports.review(userId, reportId);
  }

  @Post(':id/send')
  async send(@CurrentUser() userId: string, @Param('id') reportId: string, @Body() dto: SendReportDto) {
    return this.reports.send(userId, reportId, dto.sentViaShare);
  }
}

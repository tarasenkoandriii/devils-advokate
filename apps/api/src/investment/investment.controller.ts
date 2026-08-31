// Пункт [investment]: контролер поверх усіх сервісів модуля,
// devils-advocate-investment-tz.md §6.
//
// Шляхи ВІДРІЗНЯЮТЬСЯ від буквального §6 ТЗ у кількох місцях —
// розбіжності задокументовані в самих сервісах: (1) investmentGroupId
// переміщено на Project напряму (не InvestmentConfig — виправлений
// chicken-egg, знайдений аудитом); (2) прогрес групи прив'язаний до
// конкретного проєкту (InvestmentGroup.projects — one-to-many, немає
// єдиного targetBudget групи).

import { Body, Controller, Get, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { NotRestrictedGuard } from '../telegram-auth/not-restricted.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getOnboardingAnswers, listDomainProjects } from '../common/domain-onboarding-reads';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { InvestmentOnboardingService, ExtractedInvestmentConfigDraft } from './investment-onboarding.service';
import { InvestmentService } from './investment.service';
import { InvestmentGroupService } from './investment-group.service';

class CreateProjectDto {
  question!: string;
  investmentGroupId?: string;
}

class AppendAnswerDto {
  text!: string;
}

class ConfirmConfigDto {
  goalDescription!: string;
  targetBudget?: number;
  currency?: string;
  criteria!: Array<{ text: string; category: string; isRequired: boolean; orderIndex: number }>;
}

class CreateOpportunityDto {
  label!: string;
  advisorName?: string;
  advisorCompany?: string;
}

class CreateMeetingDto {
  conversationId?: string;
  occurredAt!: string;
}

class ReviewMeetingDto {
  reviewNotes?: string;
}

class AddSourceComparisonDto {
  sourceUrl!: string;
}

class CreateGroupDto {
  name!: string;
}

class JoinGroupDto {
  token!: string;
}

class SetPledgeDto {
  pledgedAmount!: number;
}

@Controller()
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class InvestmentController {
  constructor(
    private readonly prisma: PrismaService, // фаза A — read-helper'ы списка/онбординга
    private readonly onboarding: InvestmentOnboardingService,
    private readonly investment: InvestmentService,
    private readonly group: InvestmentGroupService,
  ) {}

  // ── Онбординг (§5.1 ТЗ) ──

  @Get('investment/projects')
  async listDomainProjects(@CurrentUser() userId: string, @Query('take') take?: string, @Query('skip') skip?: string) {
    return listDomainProjects(this.prisma, userId, ProjectMode.INVESTMENT, { take: take ? Number(take) : undefined, skip: skip ? Number(skip) : undefined });
  }

  @Get('investment/onboarding-conversations/:id')
  async getOnboardingConversation(@CurrentUser() userId: string, @Param('id') conversationId: string) {
    return getOnboardingAnswers(this.prisma, userId, conversationId);
  }

  @Post('investment/projects')
  @UseGuards(NotRestrictedGuard) // devils-advocate-admin-panel-tz.md §4.3
  async createProject(@CurrentUser() userId: string, @Body() dto: CreateProjectDto) {
    return this.onboarding.createProject(userId, dto.question, dto.investmentGroupId);
  }

  @Post('investment/projects/:projectId/onboarding-conversations')
  async createOnboardingConversation(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.onboarding.createOnboardingConversation(userId, projectId);
  }

  @Post('investment/onboarding-conversations/:id/answers')
  async appendAnswer(@CurrentUser() userId: string, @Param('id') conversationId: string, @Body() dto: AppendAnswerDto) {
    return this.onboarding.appendAnswer(userId, conversationId, dto.text);
  }

  @Post('investment/onboarding-conversations/:id/extract')
  async extract(@CurrentUser() userId: string, @Param('id') conversationId: string) {
    return this.onboarding.extract(userId, conversationId);
  }

  // ── Конфіг (§5.1 ТЗ) ──

  @Post('investment/projects/:projectId/config')
  async createConfig(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: ConfirmConfigDto) {
    const draft: ExtractedInvestmentConfigDraft = {
      goalDescription: dto.goalDescription,
      targetBudget: dto.targetBudget ?? null,
      currency: dto.currency ?? null,
      criteria: dto.criteria.map((c) => ({ ...c, category: c.category as any })),
    };
    return this.investment.createConfig(userId, projectId, draft);
  }

  @Get('investment/projects/:projectId/config')
  async getConfig(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.investment.getConfig(userId, projectId);
  }

  // ── Варіанти й зустрічі (§5.2 ТЗ) ──

  @Post('investment/configs/:id/opportunities')
  async createOpportunity(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: CreateOpportunityDto) {
    return this.investment.createOpportunity(userId, configId, dto.label, dto.advisorName, dto.advisorCompany);
  }

  @Get('investment/configs/:id/opportunities')
  async listOpportunities(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.investment.listOpportunities(userId, configId);
  }

  @Get('investment/opportunities/:id')
  async getOpportunity(@CurrentUser() userId: string, @Param('id') opportunityId: string) {
    return this.investment.getOpportunity(userId, opportunityId);
  }

  @Post('investment/opportunities/:id/meetings')
  async createMeeting(@CurrentUser() userId: string, @Param('id') opportunityId: string, @Body() dto: CreateMeetingDto) {
    return this.investment.createMeeting(userId, opportunityId, dto.conversationId, dto.occurredAt);
  }

  @Post('investment/meetings/:id/generate-breakdown')
  async generateBreakdown(@CurrentUser() userId: string, @Param('id') meetingId: string) {
    return this.investment.generateBreakdown(userId, meetingId);
  }

  @Post('investment/meetings/:id/review')
  async reviewMeeting(@CurrentUser() userId: string, @Param('id') meetingId: string, @Body() dto: ReviewMeetingDto) {
    return this.investment.reviewMeeting(userId, meetingId, dto.reviewNotes);
  }

  // ── Звірка (§5.3 ТЗ) ──

  @Post('investment/opportunities/:id/source-comparisons')
  async addSourceComparison(@CurrentUser() userId: string, @Param('id') opportunityId: string, @Body() dto: AddSourceComparisonDto) {
    return this.investment.addSourceComparison(userId, opportunityId, dto.sourceUrl);
  }

  // ── Порівняльний вивід (§5.4 ТЗ) ──

  @Get('investment/configs/:id/comparison-table')
  async getComparisonTable(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.investment.getComparisonTable(userId, configId);
  }

  // ── Група (§5.5 ТЗ) ──

  @Get('investment-groups')
  async listMyGroups(@CurrentUser() userId: string) {
    return this.group.listMyGroups(userId);
  }

  @Post('investment-groups')
  async createGroup(@CurrentUser() userId: string, @Body() dto: CreateGroupDto) {
    return this.group.createGroup(userId, dto.name);
  }

  @Post('investment-groups/:id/invite-link')
  async createInviteLink(@CurrentUser() userId: string, @Param('id') groupId: string) {
    return this.group.createInviteLink(userId, groupId);
  }

  @Post('investment-groups/:id/join')
  async joinGroup(@CurrentUser() userId: string, @Body() dto: JoinGroupDto) {
    return this.group.joinGroup(userId, dto.token);
  }

  @Post('investment-groups/:id/pledge')
  async setPledge(@CurrentUser() userId: string, @Param('id') groupId: string, @Body() dto: SetPledgeDto) {
    return this.group.setPledge(userId, groupId, dto.pledgedAmount);
  }

  // АУДИТ: прив'язано до проєкту, не до групи самої по собі (розбіжність
  // із буквальним §6 ТЗ "GET /investment-groups/:id/progress" — виправлено,
  // див. коментар над InvestmentGroupService.getProjectProgress()).
  @Get('investment/projects/:projectId/group-progress')
  async getProjectProgress(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.group.getProjectProgress(userId, projectId);
  }
}

// Пункт [family-law]: контролер поверх усіх сервісів модуля,
// devils-advocate-family-law-tz.md §6.

import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { NotRestrictedGuard } from '../telegram-auth/not-restricted.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getOnboardingAnswers, listDomainProjects } from '../common/domain-onboarding-reads';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { FamilyLawOnboardingService, ExtractedFamilyLawConfigDraft } from './family-law-onboarding.service';
import { FamilyLawService } from './family-law.service';
import { FamilyLawV2Service } from './family-law-v2.service';

class CreateProjectDto {
  question!: string;
  contractType!: 'PRENUP' | 'DIVORCE_SETTLEMENT';
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

class CreateAdvisorDto {
  label!: string;
  advisorName?: string;
  role?: string;
}

class CreateConsultationDto {
  conversationId?: string;
  occurredAt!: string;
  estimatedCost?: number;
  isMediationSession?: boolean;
}

class ReviewConsultationDto {
  reviewNotes?: string;
}

class CreatePartyDto {
  role!: string;
  displayName?: string;
}

class CreateAssetDto {
  assetType!: string;
  description?: string;
  ownerId?: string;
  isMaritalProperty?: boolean;
  estimatedValue?: number;
  currency?: string;
}

class CreateStatusDeterminationDto {
  source!: string;
  statusText!: string;
  determinedAt!: string;
  isOfficial?: boolean;
  referenceDocumentNumber?: string;
}

class CreateBudgetLineItemDto {
  category!: string;
  direction!: string;
  amount!: number;
  currency?: string;
  description?: string;
  partyId?: string;
  consultationId?: string;
}

class UpdateGoalDto {
  goalDescription!: string;
}

@Controller('family-law')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class FamilyLawController {
  constructor(
    private readonly prisma: PrismaService, // фаза A — read-helper'ы списка/онбординга
    private readonly onboarding: FamilyLawOnboardingService,
    private readonly familyLaw: FamilyLawService,
    private readonly familyLawV2: FamilyLawV2Service,
  ) {}

  // ── Онбординг (§5.1 ТЗ) ──

  @Get('projects')
  async listDomainProjects(@CurrentUser() userId: string, @Query('take') take?: string, @Query('skip') skip?: string) {
    return listDomainProjects(this.prisma, userId, ProjectMode.FAMILY_LAW, { take: take ? Number(take) : undefined, skip: skip ? Number(skip) : undefined });
  }

  @Get('onboarding-conversations/:id')
  async getOnboardingConversation(@CurrentUser() userId: string, @Param('id') conversationId: string) {
    return getOnboardingAnswers(this.prisma, userId, conversationId);
  }

  @Post('projects')
  @UseGuards(NotRestrictedGuard) // devils-advocate-admin-panel-tz.md §4.3
  async createProject(@CurrentUser() userId: string, @Body() dto: CreateProjectDto) {
    return this.onboarding.createProject(userId, dto.question, dto.contractType as any);
  }

  @Post('projects/:projectId/onboarding-conversations')
  async createOnboardingConversation(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.onboarding.createOnboardingConversation(userId, projectId);
  }

  @Post('onboarding-conversations/:id/answers')
  async appendAnswer(@CurrentUser() userId: string, @Param('id') conversationId: string, @Body() dto: AppendAnswerDto) {
    return this.onboarding.appendAnswer(userId, conversationId, dto.text);
  }

  @Post('onboarding-conversations/:id/extract')
  async extract(@CurrentUser() userId: string, @Param('id') conversationId: string) {
    return this.onboarding.extract(userId, conversationId);
  }

  // ── Конфіг (§5.1 ТЗ) ──

  @Post('projects/:projectId/config')
  async createConfig(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: ConfirmConfigDto) {
    const draft: ExtractedFamilyLawConfigDraft = {
      goalDescription: dto.goalDescription,
      targetBudget: dto.targetBudget ?? null,
      currency: dto.currency ?? null,
      criteria: dto.criteria.map((c) => ({ ...c, category: c.category as any })),
    };
    return this.familyLaw.createConfig(userId, projectId, draft);
  }

  @Get('projects/:projectId/config')
  async getConfig(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.familyLaw.getConfig(userId, projectId);
  }

  // ── Юристи/медіатори й консультації (§5.2 ТЗ) ──

  @Post('configs/:id/advisors')
  async createAdvisor(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: CreateAdvisorDto) {
    return this.familyLaw.createAdvisor(userId, configId, dto.label, dto.advisorName, dto.role);
  }

  @Get('configs/:id/advisors')
  async listAdvisors(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.familyLaw.listAdvisors(userId, configId);
  }

  @Post('advisors/:id/consultations')
  async createConsultation(@CurrentUser() userId: string, @Param('id') advisorId: string, @Body() dto: CreateConsultationDto) {
    return this.familyLaw.createConsultation(userId, advisorId, dto.conversationId, dto.occurredAt, dto.estimatedCost, dto.isMediationSession);
  }

  @Get('advisors/:id/consultations')
  async listConsultations(@CurrentUser() userId: string, @Param('id') advisorId: string) {
    return this.familyLaw.listConsultations(userId, advisorId);
  }

  @Get('consultations/:id')
  async getConsultation(@CurrentUser() userId: string, @Param('id') consultationId: string) {
    return this.familyLaw.getConsultation(userId, consultationId);
  }

  @Post('consultations/:id/generate-breakdown')
  async generateBreakdown(@CurrentUser() userId: string, @Param('id') consultationId: string) {
    return this.familyLaw.generateBreakdown(userId, consultationId);
  }

  @Post('consultations/:id/review')
  async reviewConsultation(@CurrentUser() userId: string, @Param('id') consultationId: string, @Body() dto: ReviewConsultationDto) {
    return this.familyLaw.reviewConsultation(userId, consultationId, dto.reviewNotes);
  }

  // ── Попередження про медіацію (§5.3 ТЗ) ──

  @Get('consultations/:id/mediation-notice')
  async getMediationNotice(@CurrentUser() userId: string, @Param('id') consultationId: string) {
    return this.familyLaw.getMediationNotice(userId, consultationId);
  }

  // ── Порівняльний вивід (§5.4 ТЗ) ──

  @Get('configs/:id/comparison-table')
  async getComparisonTable(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.familyLaw.getComparisonTable(userId, configId);
  }

  // ── v2: Сторони й активи (§5.2 ТЗ) ──

  @Post('configs/:id/parties')
  async createParty(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: CreatePartyDto) {
    return this.familyLawV2.createParty(userId, configId, dto.role as any, dto.displayName);
  }

  @Get('configs/:id/parties')
  async listParties(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.familyLawV2.listParties(userId, configId);
  }

  @Post('configs/:id/assets')
  async createAsset(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: CreateAssetDto) {
    return this.familyLawV2.createAsset(
      userId, configId, dto.assetType, dto.description, dto.ownerId, dto.isMaritalProperty, dto.estimatedValue, dto.currency,
    );
  }

  @Get('configs/:id/assets')
  async listAssets(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.familyLawV2.listAssets(userId, configId);
  }

  // ── v2: Статус процесу (§5.3 ТЗ) ──

  @Post('configs/:id/status-determinations')
  async createStatusDetermination(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: CreateStatusDeterminationDto) {
    return this.familyLawV2.createStatusDetermination(
      userId, configId, dto.source, dto.statusText, dto.determinedAt, dto.isOfficial, dto.referenceDocumentNumber,
    );
  }

  @Get('configs/:id/status-determinations')
  async listStatusDeterminations(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.familyLawV2.listStatusDeterminations(userId, configId);
  }

  // ── v2: Бюджет (§5.4 ТЗ v2) ──

  @Post('configs/:id/budget-line-items')
  async createBudgetLineItem(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: CreateBudgetLineItemDto) {
    return this.familyLawV2.createBudgetLineItem(
      userId, configId, dto.category, dto.direction, dto.amount, dto.currency, dto.description, dto.partyId, dto.consultationId,
    );
  }

  @Get('configs/:id/budget')
  async getBudget(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.familyLawV2.getBudget(userId, configId);
  }

  // ── v2: Зіставлення слів між консультаціями (§5.1 ТЗ, спільний сервіс) ──

  @Get('criteria/:criterionId/cross-consultation-check')
  async crossConsultationCheck(@CurrentUser() userId: string, @Param('criterionId') criterionId: string) {
    return this.familyLawV2.crossConsultationCheck(userId, criterionId);
  }

  @Get('configs/:id/cross-consultation-check')
  async crossConsultationCheckAll(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.familyLawV2.crossConsultationCheckAll(userId, configId);
  }

  // ── v2: Чернетка-компіляція (§5.5 ТЗ) ──

  @Get('configs/:id/settlement-protocol-draft')
  async getSettlementProtocolDraft(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.familyLawV2.getSettlementProtocolDraft(userId, configId);
  }

  // ── v2: Повістка питання (§5.6 ТЗ) ──

  @Patch('configs/:id/goal')
  async updateGoal(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: UpdateGoalDto) {
    return this.familyLawV2.updateGoal(userId, configId, dto.goalDescription);
  }

  @Get('configs/:id/goal-history')
  async getGoalHistory(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.familyLawV2.getGoalHistory(userId, configId);
  }
}

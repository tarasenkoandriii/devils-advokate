// Пункт [health]: контролер поверх усіх сервісів модуля,
// devils-advocate-health-tz.md §6.
//
// АУДИТ: §6 первинного документа не мав ендпоінта під source-
// reference, попри §3.3, що прямо обіцяв цю можливість — додано
// POST /health/providers/:id/source-references.

import { Body, Controller, Get, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { NotRestrictedGuard } from '../telegram-auth/not-restricted.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getOnboardingAnswers, listDomainProjects } from '../common/domain-onboarding-reads';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { HealthOnboardingService, ExtractedHealthConfigDraft } from './health-onboarding.service';
import { HealthService } from './health.service';
import { HealthV2Service } from './health-v2.service';

class CreateProjectDto {
  question!: string;
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

class CreateProviderDto {
  label!: string;
  providerName?: string;
  specialty?: string;
}

class CreateConsultationDto {
  conversationId?: string;
  occurredAt!: string;
  estimatedCost?: number;
}

class ReviewConsultationDto {
  reviewNotes?: string;
}

class AddSourceReferenceDto {
  sourceUrl!: string;
}

class UploadLabDocumentDto {
  base64Content!: string;
}

class CreateBudgetLineItemDto {
  category!: string;
  direction!: string;
  amount!: number;
  currency?: string;
  description?: string;
  consultationId?: string;
}

@Controller('health')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class HealthController {
  constructor(
    private readonly prisma: PrismaService, // фаза A — read-helper'ы списка/онбординга
    private readonly onboarding: HealthOnboardingService,
    private readonly health: HealthService,
    private readonly healthV2: HealthV2Service,
  ) {}

  // ── Онбординг (§5.1 ТЗ) ──

  @Get('projects')
  async listDomainProjects(@CurrentUser() userId: string, @Query('take') take?: string, @Query('skip') skip?: string) {
    return listDomainProjects(this.prisma, userId, ProjectMode.HEALTH, { take: take ? Number(take) : undefined, skip: skip ? Number(skip) : undefined });
  }

  @Get('onboarding-conversations/:id')
  async getOnboardingConversation(@CurrentUser() userId: string, @Param('id') conversationId: string) {
    return getOnboardingAnswers(this.prisma, userId, conversationId);
  }

  @Post('projects')
  @UseGuards(NotRestrictedGuard) // devils-advocate-admin-panel-tz.md §4.3
  async createProject(@CurrentUser() userId: string, @Body() dto: CreateProjectDto) {
    return this.onboarding.createProject(userId, dto.question);
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
    const draft: ExtractedHealthConfigDraft = {
      goalDescription: dto.goalDescription,
      targetBudget: dto.targetBudget ?? null,
      currency: dto.currency ?? null,
      criteria: dto.criteria.map((c) => ({ ...c, category: c.category as any })),
    };
    return this.health.createConfig(userId, projectId, draft);
  }

  @Get('projects/:projectId/config')
  async getConfig(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.health.getConfig(userId, projectId);
  }

  // ── Провайдери й консультації (§5.2 ТЗ) ──

  @Post('configs/:id/providers')
  async createProvider(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: CreateProviderDto) {
    return this.health.createProvider(userId, configId, dto.label, dto.providerName, dto.specialty);
  }

  @Get('configs/:id/providers')
  async listProviders(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.health.listProviders(userId, configId);
  }

  @Post('providers/:id/consultations')
  async createConsultation(@CurrentUser() userId: string, @Param('id') providerId: string, @Body() dto: CreateConsultationDto) {
    return this.health.createConsultation(userId, providerId, dto.conversationId, dto.occurredAt, dto.estimatedCost);
  }

  @Get('providers/:id/consultations')
  async listConsultations(@CurrentUser() userId: string, @Param('id') providerId: string) {
    return this.health.listConsultations(userId, providerId);
  }

  @Get('consultations/:id')
  async getConsultation(@CurrentUser() userId: string, @Param('id') consultationId: string) {
    return this.health.getConsultation(userId, consultationId);
  }

  @Get('providers/:id/source-references')
  async listSourceReferences(@CurrentUser() userId: string, @Param('id') providerId: string) {
    return this.health.listSourceReferences(userId, providerId);
  }

  @Post('consultations/:id/generate-breakdown')
  async generateBreakdown(@CurrentUser() userId: string, @Param('id') consultationId: string) {
    return this.health.generateBreakdown(userId, consultationId);
  }

  @Post('consultations/:id/review')
  async reviewConsultation(@CurrentUser() userId: string, @Param('id') consultationId: string, @Body() dto: ReviewConsultationDto) {
    return this.health.reviewConsultation(userId, consultationId, dto.reviewNotes);
  }

  // ── Публічні джерела (§3.3 ТЗ, доповнено при реалізації) ──

  @Post('providers/:id/source-references')
  async addSourceReference(@CurrentUser() userId: string, @Param('id') providerId: string, @Body() dto: AddSourceReferenceDto) {
    return this.health.addSourceReference(userId, providerId, dto.sourceUrl);
  }

  // ── Чернетка OCR результатів аналізів (Пункт [health-lab-ocr]) —
  // НІКОЛИ не факт, НІКОЛИ не йде в generateBreakdown. ──

  @Post('configs/:id/lab-documents')
  async uploadLabDocument(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: UploadLabDocumentDto) {
    return this.health.uploadLabDocument(userId, configId, dto.base64Content);
  }

  @Get('configs/:id/lab-documents')
  async listLabDocuments(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.health.listLabDocuments(userId, configId);
  }

  @Post('lab-documents/:id/verify')
  async verifyLabDocument(@CurrentUser() userId: string, @Param('id') draftId: string) {
    return this.health.verifyLabDocument(userId, draftId);
  }

  // ── Порівняльний вивід (§5.4 ТЗ) ──

  @Get('configs/:id/comparison-table')
  async getComparisonTable(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.health.getComparisonTable(userId, configId);
  }

  // ── Пункт [health-budget]: структурований бюджет, byCurrency/hasLegacyEstimatedCosts ──

  @Post('configs/:id/budget-line-items')
  async createBudgetLineItem(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: CreateBudgetLineItemDto) {
    return this.healthV2.createBudgetLineItem(
      userId, configId, dto.category, dto.direction, dto.amount, dto.currency, dto.description, dto.consultationId,
    );
  }

  @Get('configs/:id/budget')
  async getBudget(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.healthV2.getBudget(userId, configId);
  }
}

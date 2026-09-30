// Пункт [dtp]: контролер поверх усіх сервісів модуля,
// devils-advocate-dtp-tz.md §6.
//
// Звірка тверджень (§3.5 ТЗ) — переюз уже наявного генеричного
// POST /conversations/:conversationId/discrepancies/detect
// (DiscrepancyAnalysisController), не додається сюди окремим маршрутом.

import { Body, Controller, Get, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { NotRestrictedGuard } from '../telegram-auth/not-restricted.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getOnboardingAnswers, listDomainProjects } from '../common/domain-onboarding-reads';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { DtpOnboardingService, ExtractedDtpConfigDraft } from './dtp-onboarding.service';
import { DtpService } from './dtp.service';
import { DtpV2Service } from './dtp-v2.service';

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
  occurredAt?: string;
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
  // Аудит денег 2026-09-03: валюта оценки. Пусто = валюта проекта.
  currency?: string | null;
}

class ReviewConsultationDto {
  reviewNotes?: string;
}

class CreateEvidenceDto {
  mediaType!: 'PHOTO' | 'VIDEO';
  hasAudio!: boolean;
  base64Content!: string;
  contentType!: string;
  capturedAt!: string;
  latitude?: number;
  longitude?: number;
}

class CreateParticipantDto {
  role!: string;
  displayName?: string;
  hasFledScene?: boolean;
}

class UpsertInsuranceDto {
  hasInsurance!: boolean;
  insurerName?: string;
  policyType?: string;
  coverageAmount?: number;
  currency?: string;
}

class CreateFaultDeterminationDto {
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
  participantId?: string;
  consultationId?: string;
}

@Controller('dtp')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class DtpController {
  constructor(
    private readonly prisma: PrismaService, // фаза A — read-helper'ы списка/онбординга
    private readonly onboarding: DtpOnboardingService,
    private readonly dtp: DtpService,
    private readonly dtpV2: DtpV2Service,
  ) {}

  // ── Онбординг (§5.1 ТЗ) ──

  @Get('projects')
  async listDomainProjects(@CurrentUser() userId: string, @Query('take') take?: string, @Query('skip') skip?: string) {
    return listDomainProjects(this.prisma, userId, ProjectMode.DTP, { take: take ? Number(take) : undefined, skip: skip ? Number(skip) : undefined });
  }

  @Get('onboarding-conversations/:id')
  async getOnboardingConversation(@CurrentUser() userId: string, @Param('id') conversationId: string) {
    return getOnboardingAnswers(this.prisma, userId, conversationId);
  }

  @Post('projects')
  @UseGuards(NotRestrictedGuard) // devils-advocate-admin-panel-tz.md §4.3 — раніше свідомо відкладене рішення, тепер закрито
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
    const draft: ExtractedDtpConfigDraft = {
      goalDescription: dto.goalDescription,
      targetBudget: dto.targetBudget ?? null,
      currency: dto.currency ?? null,
      occurredAt: dto.occurredAt ?? null,
      criteria: dto.criteria.map((c) => ({ ...c, category: c.category as any })),
    };
    return this.dtp.createConfig(userId, projectId, draft);
  }

  @Get('projects/:projectId/config')
  async getConfig(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.dtp.getConfig(userId, projectId);
  }

  // ── Доказова фіксація (§5.2 ТЗ) ──

  @Post('configs/:id/evidence')
  async createEvidence(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: CreateEvidenceDto) {
    return this.dtp.createEvidence(
      userId,
      configId,
      dto.mediaType as any,
      dto.hasAudio,
      dto.base64Content,
      dto.contentType,
      dto.capturedAt,
      dto.latitude,
      dto.longitude,
    );
  }

  @Get('configs/:id/evidence')
  async listEvidence(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.dtp.listEvidence(userId, configId);
  }

  @Get('evidence/:id')
  async getEvidence(@CurrentUser() userId: string, @Param('id') evidenceId: string) {
    const evidence = await this.dtp.getEvidence(userId, evidenceId);
    // §5.7 ТЗ — побічний ефект наявного read-методу, не окремий виклик користувача.
    await this.dtpV2.logEvidenceAccess(userId, evidenceId, 'VIEWED_METADATA' as any);
    return evidence;
  }

  /** Пункт [the-log-that-logged-nothing] 2026-09-30 — экран обещал
   * «каждый просмотр пишется в журнал», а журнал был ВСЕГДА ПУСТ.
   *
   * Единственной записью в него был побочный эффект `GET
   * /dtp/evidence/:id` — маршрута, который НЕ ВЫЗЫВАЛ НИ ОДИН клиент:
   * экран доказательств рисуется из списка (`listEvidence`, в журнал
   * не пишет), а файл открывается ПРЯМОЙ ссылкой на Blob, минуя
   * сервер вообще. Значение `DOWNLOADED` перечисления при этом не
   * записывалось нигде во всём проекте.
   *
   * Человек открывал свои доказательства сколько угодно раз, жал
   * «Журнал доступа» и видел «Доступов не было». Обещание
   * «доказательной фиксации» подкреплялось хешем (это правда) и не
   * подкреплялось журналом.
   *
   * Отдельный POST, а не побочный эффект чтения: открытие файла — это
   * ДЕЙСТВИЕ человека, и записывать его надо там, где оно происходит.
   * Отказ записи не мешает открыть файл — отказать человеку в доступе
   * к его собственному доказательству из-за неудачной записи в журнал
   * было бы хуже, — но экран об этом скажет. */
  @Post('evidence/:id/opened')
  async markEvidenceOpened(@CurrentUser() userId: string, @Param('id') evidenceId: string) {
    // Проверка владения — в `getEvidence`; без неё запись в журнал
    // была бы доступна по чужому id.
    await this.dtp.getEvidence(userId, evidenceId);
    await this.dtpV2.logEvidenceAccess(userId, evidenceId, 'DOWNLOADED' as any);
    return { recorded: true };
  }

  // ── Фахівці й консультації (§5.3 ТЗ) ──

  @Post('configs/:id/advisors')
  async createAdvisor(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: CreateAdvisorDto) {
    return this.dtp.createAdvisor(userId, configId, dto.label, dto.advisorName, dto.role);
  }

  @Get('configs/:id/advisors')
  async listAdvisors(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.dtp.listAdvisors(userId, configId);
  }

  @Post('advisors/:id/consultations')
  async createConsultation(@CurrentUser() userId: string, @Param('id') advisorId: string, @Body() dto: CreateConsultationDto) {
    return this.dtp.createConsultation(userId, advisorId, dto.conversationId, dto.occurredAt, dto.estimatedCost, dto.currency);
  }

  @Get('advisors/:id/consultations')
  async listConsultations(@CurrentUser() userId: string, @Param('id') advisorId: string) {
    return this.dtp.listConsultations(userId, advisorId);
  }

  @Get('consultations/:id')
  async getConsultation(@CurrentUser() userId: string, @Param('id') consultationId: string) {
    return this.dtp.getConsultation(userId, consultationId);
  }

  @Post('consultations/:id/generate-breakdown')
  async generateBreakdown(@CurrentUser() userId: string, @Param('id') consultationId: string) {
    return this.dtp.generateBreakdown(userId, consultationId);
  }

  @Post('consultations/:id/review')
  async reviewConsultation(@CurrentUser() userId: string, @Param('id') consultationId: string, @Body() dto: ReviewConsultationDto) {
    return this.dtp.reviewConsultation(userId, consultationId, dto.reviewNotes);
  }

  // ── Порівняльний вивід + бюджет (§5.4/5.5 ТЗ) ──

  @Get('configs/:id/comparison-table')
  async getComparisonTable(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.dtp.getComparisonTable(userId, configId);
  }

  // ── v2: Учасники (§5.1 ТЗ) ──

  @Post('configs/:id/participants')
  async createParticipant(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: CreateParticipantDto) {
    return this.dtpV2.createParticipant(userId, configId, dto.role as any, dto.displayName, dto.hasFledScene);
  }

  @Get('configs/:id/participants')
  async listParticipants(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.dtpV2.listParticipants(userId, configId);
  }

  @Post('participants/:id/insurance')
  async upsertParticipantInsurance(@CurrentUser() userId: string, @Param('id') participantId: string, @Body() dto: UpsertInsuranceDto) {
    return this.dtpV2.upsertParticipantInsurance(userId, participantId, dto.hasInsurance, dto.insurerName, dto.policyType, dto.coverageAmount, dto.currency);
  }

  @Get('participants/:id/insurance')
  async getParticipantInsurance(@CurrentUser() userId: string, @Param('id') participantId: string) {
    return this.dtpV2.getParticipantInsurance(userId, participantId);
  }

  // ── v2: Статус вини (§5.2 ТЗ) ──

  @Post('configs/:id/fault-determinations')
  async createFaultDetermination(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: CreateFaultDeterminationDto) {
    return this.dtpV2.createFaultDetermination(userId, configId, dto.source, dto.statusText, dto.determinedAt, dto.isOfficial, dto.referenceDocumentNumber);
  }

  @Get('configs/:id/fault-determinations')
  async listFaultDeterminations(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.dtpV2.listFaultDeterminations(userId, configId);
  }

  // ── v2: Бюджет (§5.3 ТЗ) ──

  @Post('configs/:id/budget-line-items')
  async createBudgetLineItem(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: CreateBudgetLineItemDto) {
    return this.dtpV2.createBudgetLineItem(
      userId, configId, dto.category, dto.direction, dto.amount, dto.currency, dto.description, dto.participantId, dto.consultationId,
    );
  }

  @Get('configs/:id/budget')
  async getBudget(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.dtpV2.getBudget(userId, configId);
  }

  // ── v2: Зіставлення слів між консультаціями (§5.6 ТЗ) ──

  @Get('criteria/:criterionId/cross-consultation-check')
  async crossConsultationCheck(@CurrentUser() userId: string, @Param('criterionId') criterionId: string) {
    return this.dtpV2.crossConsultationCheck(userId, criterionId);
  }

  @Get('configs/:id/cross-consultation-check')
  async crossConsultationCheckAll(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.dtpV2.crossConsultationCheckAll(userId, configId);
  }

  // ── v2: Журнал цілісності доказів (§5.7 ТЗ) ──

  @Get('evidence/:id/access-log')
  async getEvidenceAccessLog(@CurrentUser() userId: string, @Param('id') evidenceId: string) {
    return this.dtpV2.getEvidenceAccessLog(userId, evidenceId);
  }

  // ── v2: Чернетка-компіляція (§5.4 ТЗ v2) ──

  @Get('configs/:id/settlement-protocol-draft')
  async getSettlementProtocolDraft(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.dtpV2.getSettlementProtocolDraft(userId, configId);
  }
}

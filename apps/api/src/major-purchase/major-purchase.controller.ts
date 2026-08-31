// Пункт [major-purchase]: контролер поверх MajorPurchaseOnboardingService/
// MajorPurchaseService, devils-advocate-major-purchase-tz.md §6.
//
// Шляхи ВІДРІЗНЯЮТЬСЯ від буквального §6 ТЗ у двох місцях — обидві
// розбіжності задокументовані в самих сервісах: (1) окремий
// POST /major-purchase/projects перед онбордінгом (Conversation.projectId
// обов'язковий, ТЗ помилково проєктував projectId як опційний);
// (2) окремий POST /major-purchase/onboarding-conversations/:id/answers
// для запису відповідей користувача перед extract (ТЗ не деталізував,
// як саме заповнюється транскрипт текстової розмови).

import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { NotRestrictedGuard } from '../telegram-auth/not-restricted.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getOnboardingAnswers, listDomainProjects } from '../common/domain-onboarding-reads';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PurchaseCategory } from '@prisma/client';
import { MajorPurchaseOnboardingService } from './major-purchase-onboarding.service';
import { MajorPurchaseService } from './major-purchase.service';

class CreateProjectDto {
  question!: string;
}

class CreateConfigDto {
  category!: PurchaseCategory;
  goalDescription!: string;
  budgetMin?: number;
  budgetMax?: number;
  currency?: string;
  financingMethod?: string;
  timeline?: string;
  criteria!: Array<{ text: string; isRequired: boolean; orderIndex: number }>;
}

class CreateVariantDto {
  label!: string;
  askingPrice?: number;
  currency?: string;
}

class SetLocationByPlaceIdDto {
  placeId!: string;
}

class SetLocationByGeolocationDto {
  latitude!: number;
  longitude!: number;
}

class CreateMeetingDto {
  conversationId?: string;
  occurredAt!: string;
}

class AddComparisonDto {
  sourceUrl!: string;
}

class ReviewConclusionDto {
  conclusionFinal!: string;
}

class AppendAnswerDto {
  text!: string;
}

class GrantLocationConsentDto {
  version!: string;
}

@Controller('major-purchase')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class MajorPurchaseController {
  constructor(
    private readonly prisma: PrismaService, // фаза A — read-helper'ы списка/онбординга
    private readonly onboarding: MajorPurchaseOnboardingService,
    private readonly majorPurchase: MajorPurchaseService,
  ) {}

  @Get('projects')
  async listDomainProjects(@CurrentUser() userId: string, @Query('take') take?: string, @Query('skip') skip?: string) {
    return listDomainProjects(this.prisma, userId, ProjectMode.MAJOR_PURCHASE, { take: take ? Number(take) : undefined, skip: skip ? Number(skip) : undefined });
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

  @Get('onboarding-conversations/:id/checklist')
  async getChecklist(@CurrentUser() userId: string, @Param('id') conversationId: string, @Query('category') category: PurchaseCategory) {
    return this.onboarding.getChecklist(userId, conversationId, category);
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
  async extract(
    @CurrentUser() userId: string,
    @Param('id') conversationId: string,
    @Query('category') category: PurchaseCategory,
  ) {
    return this.onboarding.extract(userId, conversationId, category);
  }

  @Post('projects/:projectId/configs')
  async createConfig(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: CreateConfigDto) {
    return this.majorPurchase.createConfig(userId, projectId, dto.category, {
      goalDescription: dto.goalDescription,
      budgetMin: dto.budgetMin ?? null,
      budgetMax: dto.budgetMax ?? null,
      currency: dto.currency ?? null,
      financingMethod: dto.financingMethod ?? null,
      timeline: dto.timeline ?? null,
      criteria: dto.criteria,
    });
  }

  @Get('projects/:projectId/config')
  async getConfig(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.majorPurchase.getConfig(userId, projectId);
  }

  @Get('configs/:id/variants')
  async listVariants(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.majorPurchase.listVariants(userId, configId);
  }

  @Post('configs/:id/variants')
  async createVariant(@CurrentUser() userId: string, @Param('id') configId: string, @Body() dto: CreateVariantDto) {
    return this.majorPurchase.createVariant(userId, configId, dto.label, dto.askingPrice, dto.currency);
  }

  @Get('variants/:id')
  async getVariant(@CurrentUser() userId: string, @Param('id') variantId: string) {
    return this.majorPurchase.getVariant(userId, variantId);
  }

  @Get('configs/:id/comparison-table')
  async getComparisonTable(@CurrentUser() userId: string, @Param('id') configId: string) {
    return this.majorPurchase.getComparisonTable(userId, configId);
  }

  @Patch('variants/:id/location/place-id')
  async setLocationByPlaceId(@CurrentUser() userId: string, @Param('id') variantId: string, @Body() dto: SetLocationByPlaceIdDto) {
    return this.majorPurchase.setLocationByPlaceId(userId, variantId, dto.placeId);
  }

  @Patch('variants/:id/location/geolocation')
  async setLocationByGeolocation(@CurrentUser() userId: string, @Param('id') variantId: string, @Body() dto: SetLocationByGeolocationDto) {
    return this.majorPurchase.setLocationByGeolocation(userId, variantId, dto.latitude, dto.longitude);
  }

  @Get('variants/:id/location-search')
  async searchLocationByText(@CurrentUser() userId: string, @Param('id') variantId: string, @Query('query') query: string) {
    return this.majorPurchase.searchLocationByText(userId, variantId, query);
  }

  @Post('location-consent')
  async grantLocationConsent(@CurrentUser() userId: string, @Body() dto: GrantLocationConsentDto) {
    return this.majorPurchase.grantLocationConsent(userId, dto.version);
  }

  @Post('variants/:id/meetings')
  async createMeeting(@CurrentUser() userId: string, @Param('id') variantId: string, @Body() dto: CreateMeetingDto) {
    return this.majorPurchase.createMeeting(userId, variantId, dto.conversationId, dto.occurredAt);
  }

  @Post('variants/:id/comparisons')
  async addComparison(@CurrentUser() userId: string, @Param('id') variantId: string, @Body() dto: AddComparisonDto) {
    return this.majorPurchase.addComparison(userId, variantId, dto.sourceUrl);
  }

  @Post('meetings/:id/generate-conclusion')
  async generateConclusion(@CurrentUser() userId: string, @Param('id') meetingId: string) {
    return this.majorPurchase.generateConclusion(userId, meetingId);
  }

  @Get('meetings/:id')
  async getMeeting(@CurrentUser() userId: string, @Param('id') meetingId: string) {
    return this.majorPurchase.getMeeting(userId, meetingId);
  }

  @Post('meetings/:id/review-conclusion')
  async reviewConclusion(@CurrentUser() userId: string, @Param('id') meetingId: string, @Body() dto: ReviewConclusionDto) {
    return this.majorPurchase.reviewConclusion(userId, meetingId, dto.conclusionFinal);
  }
}

// Пункт [job-domain-v2] §6.5 / §8.3 — маршруты поддомена работодателя и
// передач между проектами (engagement, оффер копией). Гварды — как у всех
// доменов; в таблице RESOLVERS гварда заморозки — 'employer-hiring',
// 'engagements', 'offers'.
import { Body, Controller, Get, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { EmploymentLoad, ProjectMode, WorkArrangement } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { getOnboardingAnswers, listDomainProjects } from '../common/domain-onboarding-reads';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { NotRestrictedGuard } from '../telegram-auth/not-restricted.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { EmployerHiringService } from './employer-hiring.service';
import { EngagementService } from './engagement.service';
import { OfferExchangeService } from './offer-exchange.service';

class CreateProjectDto {
  @IsString() @MinLength(1) @MaxLength(2000) question!: string;
  @IsOptional() @IsString() recruitingTeamId?: string;
}
class AppendAnswerDto {
  @IsString() @MinLength(1) @MaxLength(8000) text!: string;
}
class ConfigDto {
  @IsOptional() @IsString() @MaxLength(200) jobTitle?: string;
  @IsOptional() @IsString() @MaxLength(8000) extendedDescription?: string;
  @IsOptional() @IsString() @MaxLength(200) salaryRange?: string | null;
  @IsOptional() @IsEnum(EmploymentLoad) employmentLoad?: EmploymentLoad | null;
  @IsOptional() @IsEnum(WorkArrangement) workArrangement?: WorkArrangement | null;
  @IsOptional() @IsString() @MaxLength(200) officeLocation?: string | null;
  @IsOptional() @IsString() @MaxLength(200) employmentFormat?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) perks?: string[];
}
class InviteDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(4) @IsString({ each: true }) sharedItems!: string[];
  @IsOptional() @IsString() expiresAt?: string | null;
}
class AcceptDto {
  @IsString() @MinLength(8) token!: string;
  @IsString() teamId!: string;
  @IsOptional() @IsString() agencyProjectId?: string | null;
}
class FollowUpDto {
  @IsString() candidateProfileId!: string;
  @IsString() @MinLength(1) @MaxLength(2000) text!: string;
}
class PostingReviewDto {
  @IsString() revisionId!: string;
  @IsString() @MinLength(1) @MaxLength(2000) text!: string;
}
class DeliverDto {
  @IsString() reportId!: string;
}
class ShareOfferDto {
  @IsOptional() @IsString() candidateShareId?: string | null;
  @IsOptional() @IsString() token?: string | null;
}

@Controller('employer-hiring')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class EmployerHiringController {
  constructor(
    private readonly employer: EmployerHiringService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('projects')
  list(@CurrentUser() userId: string, @Query('take') take?: string, @Query('skip') skip?: string) {
    return listDomainProjects(this.prisma, userId, ProjectMode.EMPLOYER_HIRING, { take: take ? Number(take) : undefined, skip: skip ? Number(skip) : undefined });
  }

  @Post('projects')
  @UseGuards(NotRestrictedGuard)
  create(@CurrentUser() userId: string, @Body() dto: CreateProjectDto) {
    return this.employer.createProject(userId, dto.question, dto.recruitingTeamId);
  }

  @Get('onboarding-checklist')
  checklist() {
    return this.employer.getChecklist();
  }

  @Get('onboarding-conversations/:id')
  getOnboarding(@CurrentUser() userId: string, @Param('id') id: string) {
    return getOnboardingAnswers(this.prisma, userId, id);
  }

  @Post('projects/:projectId/onboarding-conversations')
  createOnboarding(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.employer.createOnboardingConversation(userId, projectId);
  }

  @Post('onboarding-conversations/:id/answers')
  answer(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: AppendAnswerDto) {
    return this.employer.appendAnswer(userId, id, dto.text);
  }

  @Post('onboarding-conversations/:id/extract')
  extract(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.employer.extract(userId, id);
  }

  @Post('projects/:projectId/config')
  updateConfig(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: ConfigDto) {
    return this.employer.updateConfig(userId, projectId, dto);
  }

  @Get('projects/:projectId/config')
  getConfig(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.employer.getConfig(userId, projectId);
  }

  @Get('projects/:projectId/state')
  state(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.employer.getState(userId, projectId);
  }
}

@Controller('engagements')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class EngagementController {
  constructor(private readonly engagements: EngagementService) {}

  @Post('projects/:employerProjectId')
  invite(@CurrentUser() userId: string, @Param('employerProjectId') projectId: string, @Body() dto: InviteDto) {
    return this.engagements.invite(userId, projectId, dto);
  }

  @Get('projects/:employerProjectId')
  listForEmployer(@CurrentUser() userId: string, @Param('employerProjectId') projectId: string) {
    return this.engagements.listForEmployer(userId, projectId);
  }

  @Get('projects/:employerProjectId/reports')
  deliveredReports(@CurrentUser() userId: string, @Param('employerProjectId') projectId: string) {
    return this.engagements.deliveredReports(userId, projectId);
  }

  @Get('agency-projects/:agencyProjectId')
  listForAgency(@CurrentUser() userId: string, @Param('agencyProjectId') projectId: string) {
    return this.engagements.listForAgency(userId, projectId);
  }

  @Post('accept')
  accept(@CurrentUser() userId: string, @Body() dto: AcceptDto) {
    return this.engagements.accept(userId, dto);
  }

  @Post(':id/revoke')
  revoke(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.engagements.revoke(userId, id);
  }

  @Post(':id/follow-up')
  followUp(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: FollowUpDto) {
    return this.engagements.forwardFollowUp(userId, id, dto);
  }

  @Post(':id/posting-review')
  postingReview(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: PostingReviewDto) {
    return this.engagements.postingReview(userId, id, dto);
  }

  @Get(':id/posting')
  agencyPosting(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.engagements.agencyPosting(userId, id);
  }

  @Post(':id/deliver')
  deliver(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: DeliverDto) {
    return this.engagements.deliverReport(userId, dto.reportId, id);
  }
}

@Controller('offers')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class OfferExchangeController {
  constructor(private readonly offers: OfferExchangeService) {}

  @Post(':id/review')
  review(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.offers.review(userId, id);
  }

  @Get(':id/promises-check')
  promises(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.offers.promisesCheck(userId, id);
  }

  @Post(':id/share-to-candidate')
  share(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: ShareOfferDto) {
    return this.offers.shareToCandidate(userId, id, dto);
  }

  @Post(':id/withdraw')
  withdraw(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.offers.withdraw(userId, id);
  }
}

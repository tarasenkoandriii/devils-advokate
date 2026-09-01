// Пункт [job-search] 2026-09-01 — контроллер домена кандидата. Та же
// связка гвардов, что у остальных доменов (investment как образец).

import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { JobSearchOnboardingService, ExtractedJobSearchConfigDraft } from './job-search-onboarding.service';
import { JobSearchService } from './job-search.service';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

class CreateProjectDto {
  // Пункт [validation] 2026-09-01: лимиты на тексты, уходящие в LLM.
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  question!: string;
}

class AppendAnswerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  text!: string;
}

class CreateConfigDto {
  desiredRole!: string;
  city?: string | null;
  region?: string | null;
  salaryExpectation?: number | null;
  currency?: string | null;
  employmentFormat?: string | null;
  experienceSummary?: string | null;
  criteria!: Array<{ text: string; category: string; isRequired: boolean; orderIndex: number }>;
}

class AddVacancyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  sourceUrl!: string;
}

// Гварды — как у остальных доменов (investment): TelegramAuthGuard +
// ProjectFrozenGuard на классе; заморозка мутирующих роутов идёт через
// таблицу RESOLVERS гварда (запись 'job-search' добавлена туда же).
@Controller('job-search')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class JobSearchController {
  constructor(
    private readonly onboarding: JobSearchOnboardingService,
    private readonly jobSearch: JobSearchService,
  ) {}

  @Post('projects')
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

  @Post('projects/:projectId/config')
  async createConfig(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: CreateConfigDto) {
    return this.jobSearch.createConfig(userId, projectId, {
      desiredRole: dto.desiredRole,
      city: dto.city ?? null,
      region: dto.region ?? null,
      salaryExpectation: dto.salaryExpectation ?? null,
      currency: dto.currency ?? null,
      employmentFormat: dto.employmentFormat ?? null,
      experienceSummary: dto.experienceSummary ?? null,
      criteria: dto.criteria as never,
    } as ExtractedJobSearchConfigDraft);
  }

  @Get('projects/:projectId/config')
  async getConfig(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.jobSearch.getConfig(userId, projectId);
  }

  @Post('projects/:projectId/cv/draft')
  async generateCv(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.jobSearch.generateCvDraft(userId, projectId);
  }

  @Post('projects/:projectId/cv/review')
  async reviewCv(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.jobSearch.reviewCv(userId, projectId);
  }

  @Post('projects/:projectId/vacancies')
  async addVacancy(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: AddVacancyDto) {
    return this.jobSearch.addVacancy(userId, projectId, dto.sourceUrl);
  }

  @Get('projects/:projectId/vacancies')
  async listVacancies(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.jobSearch.listVacancies(userId, projectId);
  }

  @Post('vacancies/:id/match')
  async matchVacancy(@CurrentUser() userId: string, @Param('id') vacancyId: string) {
    return this.jobSearch.matchVacancy(userId, vacancyId);
  }

  @Get('projects/:projectId/statistics')
  async statistics(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.jobSearch.getStatistics(userId, projectId);
  }
}

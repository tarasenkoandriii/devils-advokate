// Пункт [job-domain-v2] §6.5 — приток и инструменты соискателя (связка П +
// К-13/К-17/К-18/К-19/К-25/К-26/К-27). Внутренние маршруты (тик refetch,
// пересылка боту) — за x-dispatch-secret, как остальные /internal.
import { JobVacancyResponseStatus } from '@prisma/client';
import { Body, Controller, Get, Headers, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength , IsNotEmpty} from 'class-validator';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { SecretsService } from '../secrets/secrets.service';
import { VacancyIntakeService } from './vacancy-intake.service';
import { JobSearchToolsService } from './job-search-tools.service';
import { assertSharedSecret } from '../common/dispatch-secret';

// Тот же секрет, что у остальных плановых тиков (scheduler, calibration, intake) — один класс server-to-server вызова.
const DISPATCH_SECRET_REF = 'SCHEDULER_DISPATCH_SECRET';

class SearchPageDto {
  @IsOptional() @IsString() @MaxLength(2048) url?: string | null;
  @IsOptional() @IsString() @MaxLength(2_000_000) html?: string | null;
}
class EmailAlertDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) links!: Array<{ url: string; title?: string | null; company?: string | null }>;
}
class PastedDto {
  @IsString() @MinLength(20) @MaxLength(20_000) text!: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) title?: string | null;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(2048) sourceUrl?: string | null;
}
class ResponsesDto {
  @IsString() @MinLength(1) @MaxLength(200_000) text!: string;
}
class WatchDto {
  @IsBoolean() enabled!: boolean;
}
class ResponseStatusDto {
  // null — «снять отметку»: человек мог отметить отклик по ошибке.
  @IsOptional() @IsIn([...Object.values(JobVacancyResponseStatus), null]) status!: JobVacancyResponseStatus | null;
}
class FavoriteDto {
  @IsBoolean() favorite!: boolean;
}
class BatchDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsString({ each: true }) @IsNotEmpty({ each: true }) vacancyIds!: string[];
}
class CriterionDto {
  @IsString() @MinLength(1) @MaxLength(300) text!: string;
  @IsString() @IsNotEmpty() category!: string;
  @IsBoolean() isRequired!: boolean;
}
class CoverLetterDto {
  @IsIn(['name_honestly', 'skip']) notCoveredHandling!: 'name_honestly' | 'skip';
  @IsOptional() @IsString() cvVariantId?: string | null;
}
class PackageDto {
  @IsIn(['name_honestly', 'skip']) notCoveredHandling!: 'name_honestly' | 'skip';
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @IsNotEmpty({ each: true }) questions?: string[];
}
class ForwardedDto {
  @IsString() telegramId!: string;
  @IsString() projectId!: string;
  @IsString() @MinLength(1) @MaxLength(20_000) text!: string;
}

@Controller('job-search')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class VacancyIntakeController {
  constructor(
    private readonly intake: VacancyIntakeService,
    private readonly tools: JobSearchToolsService,
  ) {}

  // приток
  @Post('projects/:projectId/intake/search-page')
  searchPage(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: SearchPageDto) {
    return this.intake.fromSearchPage(userId, projectId, dto);
  }

  @Post('projects/:projectId/intake/email-alert')
  emailAlert(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: EmailAlertDto) {
    return this.intake.fromEmailAlert(userId, projectId, dto.links);
  }

  @Post('projects/:projectId/intake/pasted')
  pasted(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: PastedDto) {
    return this.intake.fromPastedText(userId, projectId, dto);
  }

  @Post('projects/:projectId/intake/responses')
  responses(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: ResponsesDto) {
    return this.intake.importResponses(userId, projectId, dto.text);
  }

  @Get('projects/:projectId/intake/candidates')
  candidates(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.intake.listCandidates(userId, projectId);
  }

  @Post('vacancy-candidates/:id/fetch')
  fetchCandidate(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.intake.fetchCandidate(userId, id);
  }

  @Post('projects/:projectId/dedupe')
  dedupe(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.intake.dedupe(userId, projectId);
  }

  @Post('vacancies/:id/unlink-duplicate')
  unlink(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.intake.unlinkDuplicate(userId, id);
  }

  @Patch('vacancies/:id/watch')
  watch(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: WatchDto) {
    return this.intake.setWatch(userId, id, dto.enabled);
  }

  @Post('vacancies/:id/refetch')
  refetch(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.intake.refetch(userId, id);
  }

  @Get('vacancies/:id/changes')
  changes(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.intake.changes(userId, id);
  }

  /** К-3: отметить, что откликнулся (или сменить статус отклика). */
  @Patch('vacancies/:id/response-status')
  setResponseStatus(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: ResponseStatusDto) {
    return this.intake.setResponseStatus(userId, id, dto.status ?? null);
  }

  @Patch('vacancies/:id/favorite')
  favorite(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: FavoriteDto) {
    return this.intake.setFavorite(userId, id, dto.favorite);
  }

  @Get('projects/:projectId/silence')
  silence(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Query('days') days?: string) {
    return this.intake.silence(userId, projectId, days ? Number(days) : 7);
  }

  // инструменты
  @Get('projects/:projectId/query-builder')
  queryBuilder(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.tools.queryBuilder(userId, projectId);
  }

  @Post('projects/:projectId/batch-match')
  batch(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: BatchDto) {
    return this.tools.enqueueBatch(userId, projectId, dto.vacancyIds);
  }

  @Get('projects/:projectId/matrix')
  matrix(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Query('filter') filter?: string, @Query('sort') sort?: string) {
    return this.tools.matrix(userId, projectId, { filter: filter as never, sort: sort === 'true' });
  }

  @Get('projects/:projectId/criteria-suggestions')
  suggestCriteria(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.tools.suggestCriteria(userId, projectId);
  }

  @Post('projects/:projectId/criteria')
  acceptCriterion(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: CriterionDto) {
    return this.tools.acceptCriterion(userId, projectId, dto);
  }

  @Get('projects/:projectId/gap-map')
  gapMap(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.tools.gapMap(userId, projectId);
  }

  @Post('projects/:projectId/cover-letter/:sheetId')
  coverLetter(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Param('sheetId') sheetId: string, @Body() dto: CoverLetterDto) {
    return this.tools.coverLetter(userId, projectId, sheetId, dto);
  }

  @Post('projects/:projectId/application-package/:sheetId')
  applicationPackage(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Param('sheetId') sheetId: string, @Body() dto: PackageDto) {
    return this.tools.applicationPackage(userId, projectId, sheetId, dto);
  }

  @Post('vacancies/:id/scam-signals')
  scam(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.tools.scamSignals(userId, id);
  }

  @Get('projects/:projectId/similar/:vacancyId')
  similar(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Param('vacancyId') vacancyId: string) {
    return this.tools.similar(userId, projectId, vacancyId);
  }
}

@Controller('internal/job-search')
@UseInterceptors(ApiResponseInterceptor)
export class JobSearchInternalController {
  constructor(
    private readonly intake: VacancyIntakeService,
    private readonly secrets: SecretsService,
  ) {}

  private async assertSecret(provided: string) {
    // Пункт [the-registry-promised-401-and-gave-500] 2026-09-30.
    await assertSharedSecret(this.secrets, DISPATCH_SECRET_REF, provided);
  }

  /** Тик pg_cron (К-16): раз в сутки, порция 20. */
  @Post('refetch')
  async refetch(@Headers('x-dispatch-secret') secret: string) {
    await this.assertSecret(secret);
    return this.intake.refetchDue();
  }

  /** К-20: приёмник пересланных сообщений бота — только text; forward_origin не принимается. */
  @Post('forwarded')
  async forwarded(@Headers('x-dispatch-secret') secret: string, @Body() dto: ForwardedDto) {
    await this.assertSecret(secret);
    return this.intake.fromForwardedMessage(dto.telegramId, dto.projectId, dto.text);
  }
}

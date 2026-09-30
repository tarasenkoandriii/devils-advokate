// Пункт [job-domain-v2] §6.5 — компания (все роли; у работодателя — досье на себя).
import { Body, Controller, Get, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { EmployerFactCategory } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength , IsNotEmpty} from 'class-validator';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { EmployerDossierService } from './employer-dossier.service';

class IdentifyDto {
  @IsOptional() @IsString() @MaxLength(300) legalName?: string | null;
  @IsOptional() @IsString() @MaxLength(20) registryCode?: string | null;
  @IsOptional() @IsString() @MaxLength(253) domain?: string | null;
  @IsOptional() @IsString() @MaxLength(2) jurisdiction?: string | null;
}

class ConfirmDto {
  @IsOptional() @IsString() @MaxLength(300) legalName?: string | null;
}

class SourceDto {
  @IsString() @MinLength(8) @MaxLength(2048) url!: string;
  @IsOptional() @IsEnum(EmployerFactCategory) category?: EmployerFactCategory | null;
}

class RepresentativeDto {
  @IsString() @MinLength(1) @MaxLength(120) displayName!: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) claimedRole?: string | null;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(253) contactDomain?: string | null;
  @IsOptional() @IsString() personId?: string | null;
}

@Controller('employer-dossiers')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class EmployerDossierController {
  constructor(private readonly dossiers: EmployerDossierService) {}

  @Post('projects/:projectId')
  identify(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: IdentifyDto) {
    return this.dossiers.identify(userId, projectId, dto);
  }

  @Get('projects/:projectId')
  list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.dossiers.list(userId, projectId);
  }

  @Get('projects/:projectId/shipment-checklist')
  shipment(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.dossiers.shipmentChecklist(userId, projectId);
  }

  @Get(':id')
  get(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.dossiers.get(userId, id);
  }

  @Post(':id/confirm')
  confirm(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: ConfirmDto) {
    return this.dossiers.confirm(userId, id, dto.legalName);
  }

  @Post(':id/refresh')
  refresh(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.dossiers.refresh(userId, id);
  }

  @Post(':id/sources')
  addSource(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: SourceDto) {
    return this.dossiers.addUserSource(userId, id, dto);
  }

  @Post(':id/representatives')
  addRepresentative(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: RepresentativeDto) {
    return this.dossiers.addRepresentative(userId, id, dto);
  }

  @Post('representatives/:id/check')
  check(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.dossiers.check(userId, id);
  }

  @Get(':id/discrepancies')
  discrepancies(@CurrentUser() userId: string, @Param('id') id: string, @Query('briefId') briefId?: string, @Query('vacancyId') vacancyId?: string, @Query('postingId') postingId?: string) {
    return this.dossiers.discrepancies(userId, id, { briefId, vacancyId, postingId });
  }

  @Post(':id/vacancies/:vacancyId')
  linkVacancy(@CurrentUser() userId: string, @Param('id') id: string, @Param('vacancyId') vacancyId: string) {
    return this.dossiers.linkVacancy(userId, id, vacancyId);
  }

  /** А-28: выжимка о компании для кандидата (аудит 2026-09-03). */
  @Get(':id/candidate-summary')
  candidateSummary(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.dossiers.candidateSummary(userId, id);
  }

  @Get(':id/history')
  history(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.dossiers.history(userId, id);
  }
}

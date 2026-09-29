// Пункт [job-domain-v2] §6.5 — бриф (агентство: внешний; работодатель: внутренний).
import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ClientBriefOrigin } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ClientBriefService, MAX_BRIEF_CHARS } from './client-brief.service';

class IngestDto {
  @IsString() @MinLength(1) @MaxLength(MAX_BRIEF_CHARS) rawText!: string;
  @IsOptional() @IsString() @MaxLength(200) source?: string | null;
  @IsOptional() @IsEnum(ClientBriefOrigin) origin?: ClientBriefOrigin;
}

@Controller('client-briefs')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ClientBriefController {
  constructor(private readonly briefs: ClientBriefService) {}

  @Post('projects/:projectId')
  ingest(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: IngestDto) {
    return this.briefs.ingest(userId, projectId, dto);
  }

  @Get('projects/:projectId')
  list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.briefs.list(userId, projectId);
  }

  @Get('projects/:projectId/diff')
  diff(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.briefs.diffAgainstPrevious(userId, projectId);
  }

  @Post(':id/extract')
  extract(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.briefs.extract(userId, id);
  }

  @Get(':id/questions')
  questions(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.briefs.questions(userId, id);
  }

  @Get(':id/compliance')
  compliance(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.briefs.complianceScan(userId, id);
  }
}

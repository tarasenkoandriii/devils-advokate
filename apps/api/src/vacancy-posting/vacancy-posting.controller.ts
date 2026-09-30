// Пункт [job-domain-v2] §6.5 — текст вакансии (агентство и работодатель) и
// публичное согласование по токену (А-30).
import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength, IsNotEmpty } from 'class-validator';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { VacancyPostingService, MAX_POSTING_CHARS } from './vacancy-posting.service';

class RevisionDto {
  @IsString() @MinLength(1) @MaxLength(MAX_POSTING_CHARS) text!: string;
}
class VariantsDto {
  @IsOptional() @IsArray() @ArrayMaxSize(4) @IsString({ each: true }) @IsNotEmpty({ each: true }) channels?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) @IsNotEmpty({ each: true }) langs?: string[];
}
class ReasonDto {
  @IsString() @MinLength(1) @MaxLength(300) reason!: string;
}
class CommentDto {
  @IsString() @MinLength(1) @MaxLength(2000) text!: string;
}

@Controller('vacancy-postings')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class VacancyPostingController {
  constructor(private readonly postings: VacancyPostingService) {}

  @Get('projects/:projectId')
  get(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.postings.get(userId, projectId);
  }

  @Post('projects/:projectId/draft')
  draft(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.postings.draftFromSheet(userId, projectId);
  }

  @Post('projects/:projectId/revisions')
  addRevision(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: RevisionDto) {
    return this.postings.addRevision(userId, projectId, dto.text);
  }

  @Post('revisions/:id/check')
  check(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.postings.check(userId, id);
  }

  @Get('revisions/:id/trace')
  trace(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.postings.trace(userId, id);
  }

  @Get('revisions/:id/reader-questions')
  readerQuestions(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.postings.readerQuestions(userId, id);
  }

  @Post('revisions/:id/variants')
  variants(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: VariantsDto) {
    return this.postings.deriveVariants(userId, id, dto);
  }

  @Get('revisions/:id/publish-checklist')
  checklist(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.postings.publishChecklist(userId, id);
  }

  @Post('revisions/:id/salary-omission')
  salaryOmission(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.postings.setSalaryOmissionReason(userId, id, dto.reason);
  }

  @Post('revisions/:id/review')
  review(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.postings.review(userId, id);
  }

  @Post('revisions/:id/review-share')
  reviewShare(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.postings.createReviewShare(userId, id);
  }

  @Post('variants/:id/review')
  reviewVariant(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.postings.reviewVariant(userId, id);
  }
}

@Controller('posting-review')
@UseInterceptors(ApiResponseInterceptor)
export class PostingReviewPublicController {
  constructor(private readonly postings: VacancyPostingService) {}

  @Get(':token')
  view(@Param('token') token: string) {
    return this.postings.publicReview(token);
  }

  @Post(':token/comments')
  comment(@Param('token') token: string, @Body() dto: CommentDto) {
    return this.postings.publicComment(token, dto.text);
  }
}

// Пункт [job-domain-v2] — остальные функции этапа 2 (К-2/А-8, К-4, К-6, К-9/А-5,
// К-10, А-2, А-3, А-7, А-9, А-10, Р-8, Р-10, Р-12, Р-14).
//
// Маршруты нарочно висят на уже известных guard'у префиксах: /terms-sheets/:id/...
// и /terms-sheets/projects/:projectId/... (ProjectFrozenGuard → лист/проект),
// /interview-pool/pipeline-statuses/:id/... (→ кандидат). Публичная анкета
// кандидата — /pre-questionnaire/:token без авторизации: только вопросы,
// два согласия и приём ответов.
import { Body, Controller, Get, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested , IsNotEmpty} from 'class-validator';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { HiringExtrasService } from './hiring-extras.service';

class RehearsalDto {
  @IsString() @MinLength(1) sparringSessionId!: string;
}
class TextDto {
  @IsString() @MinLength(1) @MaxLength(60_000) text!: string;
}
class LiveHintDto {
  @IsString() @MinLength(1) @MaxLength(20_000) transcriptWindow!: string;
}
class TestAssignmentDto {
  @IsString() @MinLength(1) @MaxLength(60_000) assignmentText!: string;
  @IsString() @MinLength(1) @MaxLength(120_000) answerText!: string;
}
class PredictionDto {
  @IsString() @MinLength(1) @MaxLength(1000) predictedOutcome!: string;
}
class PromiseDto {
  @IsString() @MinLength(1) @MaxLength(1000) description!: string;
  @IsOptional() @IsString() @IsNotEmpty() dueDate?: string | null;
}
class ExistingCandidateDto {
  @IsString() @MinLength(1) candidateProfileId!: string;
  @IsBoolean() candidateConsentReconfirmed!: boolean;
}
class MergeDto {
  @IsString() @MinLength(1) keepStatusId!: string;
  @IsString() @MinLength(1) mergeStatusId!: string;
}
class AiNoticeShownDto {
  @IsString() @MinLength(1) candidateProfileId!: string;
  /** Пункт [log-says-we-saw-it] 2026-09-24: уведомление показывает
   * человек, вне продукта. Запись делается с его слов, и подтверждение
   * обязательно — как `candidateAskedToRevoke` у отзыва согласия. */
  @IsBoolean() noticeShownToCandidate!: boolean;
}
class StatusLetterSentDto {
  /** Письмо отправляет человек своей почтой — так и написано в рамке
   * самого письма. Продукт отправку не наблюдает. */
  @IsBoolean() recruiterSentIt!: boolean;
}
class SilenceQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days?: number;
}
class PreAnswerDto {
  @IsString() questionId!: string;
  @IsString() @MaxLength(4000) text!: string;
}
class PreSubmitDto {
  @IsBoolean() aiNoticeAccepted!: boolean;
  @IsBoolean() transferConsentAccepted!: boolean;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => PreAnswerDto) answers!: PreAnswerDto[];
}

@Controller('terms-sheets')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class HiringExtrasSheetController {
  constructor(private readonly extras: HiringExtrasService) {}

  // ── по листу ──

  @Post(':id/rehearsal-positions') // К-2
  rehearsal(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: RehearsalDto) {
    return this.extras.positionsFromRehearsal(userId, id, dto.sparringSessionId);
  }

  @Post(':id/debrief') // А-8
  debrief(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: TextDto) {
    return this.extras.debrief(userId, id, dto.text);
  }

  @Post(':id/salary-scenarios') // К-4
  salary(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.extras.salaryScenarios(userId, id);
  }

  @Post(':id/live-hint') // К-6
  liveHint(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: LiveHintDto) {
    return this.extras.liveHint(userId, id, dto.transcriptWindow);
  }

  @Post(':id/test-assignment') // К-9 / А-5
  testAssignment(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: TestAssignmentDto) {
    return this.extras.testAssignment(userId, id, dto);
  }

  @Post(':id/predictions') // К-10
  prediction(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: PredictionDto) {
    return this.extras.createPrediction(userId, id, dto.predictedOutcome);
  }

  @Post(':id/promises') // А-7
  promise(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: PromiseDto) {
    return this.extras.promiseToCandidate(userId, id, dto);
  }

  @Get(':id/status-letter/:kind') // Р-10
  statusLetter(@CurrentUser() userId: string, @Param('id') id: string, @Param('kind') kind: string) {
    return this.extras.statusLetter(userId, id, kind === 'declined' ? 'declined' : 'waiting');
  }

  @Post(':id/status-letter/sent') // Р-10
  statusLetterSent(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: StatusLetterSentDto) {
    return this.extras.markStatusLetterSent(userId, id, dto);
  }

  // ── по проекту ──

  @Get('projects/:projectId/coverage-matrix') // А-3
  matrix(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.extras.coverageMatrix(userId, projectId);
  }

  @Get('projects/:projectId/silence') // А-7
  silence(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Query() q: SilenceQuery) {
    return this.extras.silenceReport(userId, projectId, q.days ?? 7);
  }

  @Get('projects/:projectId/bias-export') // А-9
  biasExport(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.extras.biasExport(userId, projectId);
  }

  @Post('projects/:projectId/existing-candidate') // А-10
  existingCandidate(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: ExistingCandidateDto) {
    return this.extras.addExistingCandidateToProject(userId, projectId, dto);
  }

  @Post('projects/:projectId/merge-candidates') // Р-8
  merge(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: MergeDto) {
    return this.extras.mergeCandidates(userId, projectId, dto);
  }

  @Get('projects/:projectId/ai-notice') // Р-12
  aiNotice(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.extras.aiNotice(userId, projectId);
  }

  @Post('projects/:projectId/ai-notice/shown') // Р-12
  aiNoticeShown(@CurrentUser() userId: string, @Param('projectId') projectId: string, @Body() dto: AiNoticeShownDto) {
    return this.extras.recordAiNoticeShown(userId, projectId, dto.candidateProfileId, dto);
  }

  @Get('projects/:projectId/closing-checklist') // Р-14
  closing(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.extras.closingChecklist(userId, projectId);
  }
}

@Controller('interview-pool')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class PreQuestionnaireController {
  constructor(private readonly extras: HiringExtrasService) {}

  @Post('pipeline-statuses/:id/pre-questionnaire') // А-2
  create(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.extras.createPreQuestionnaire(userId, id);
  }
}

/** Публичная анкета кандидата (по токену из ссылки). Без авторизации — кандидат
 * не пользователь продукта. Ответы принимаются только с обоими согласиями. */
@Controller('pre-questionnaire')
@UseInterceptors(ApiResponseInterceptor)
export class PreQuestionnairePublicController {
  constructor(private readonly extras: HiringExtrasService) {}

  @Get(':token')
  form(@Param('token') token: string) {
    return this.extras.preQuestionnaireForm(token);
  }

  @Post(':token')
  submit(@Param('token') token: string, @Body() dto: PreSubmitDto) {
    return this.extras.submitPreQuestionnaire(token, dto);
  }

  /** Пункт [candidate-rights] 2026-09-04 — отзыв согласия САМИМ кандидатом.
   *
   * Без авторизации намеренно и по той же причине, что и вся анкета:
   * кандидат не пользователь продукта, аккаунта у него нет. Доступ даёт
   * тот же токен, по которому он отвечал; требовать большего значило бы
   * оставить обещанное право без способа им воспользоваться. Отзыв
   * идемпотентен: повторное нажатие — не ошибка, а тот же ответ. */
  @Post(':token/revoke-consent')
  revokeConsent(@Param('token') token: string) {
    return this.extras.revokePreQuestionnaireConsent(token);
  }
}

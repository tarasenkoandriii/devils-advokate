// Пункт [job-domain-v2] §6.5 — маршруты листа условий и CV-варианта. Та же
// связка гвардов, что у доменных контроллеров: TelegramAuthGuard +
// ProjectFrozenGuard (плоский домен `terms-sheets` в таблице RESOLVERS).

import { Body, Controller, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ClauseCoverage, ClauseStance, EvidenceKind, TermsClauseKind, TermsSheetStatus, TermsSide } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength , IsNotEmpty} from 'class-validator';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ProjectFrozenGuard } from '../project-freeze/project-frozen.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { TermsSheetService } from './terms-sheet.service';
import { CvVariantService, HighlightMapEntry } from './cv-variant.service';
import { CvDialogueService } from './cv-dialogue.service';

class IdsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsString({ each: true }) @IsNotEmpty({ each: true })
  ids!: string[];
}

class AddClauseDto {
  @IsEnum(TermsSide) side!: TermsSide;
  @IsEnum(TermsClauseKind) kind!: TermsClauseKind;
  @IsString() @MinLength(1) @MaxLength(500) text!: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) category?: string | null;
  @IsOptional() @IsBoolean() isRequired?: boolean;
}

class CounterpartDto {
  @IsOptional() @IsString() counterpartClauseId?: string | null;
}

class ProposeDto {
  @IsEnum(EvidenceKind) evidenceKind!: EvidenceKind;
  @IsOptional() @IsString() evidenceRef?: string | null;
  @IsOptional() @IsString() @MaxLength(20_000) text?: string | null;
  @IsOptional() @IsEnum(TermsSide) bySide?: TermsSide;
}

class AddPositionDto {
  @IsString() clauseId!: string;
  @IsEnum(TermsSide) bySide!: TermsSide;
  @IsOptional() @IsEnum(ClauseCoverage) coverage?: ClauseCoverage | null;
  @IsOptional() @IsEnum(ClauseStance) stance?: ClauseStance | null;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(600) note?: string | null;
  @IsString() @MinLength(1) @MaxLength(500) evidenceQuote!: string;
}

class AddOfferDto {
  @IsString() @MinLength(1) @MaxLength(20_000) rawText!: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) source?: string | null;
}

class StatusDto {
  @IsEnum(TermsSheetStatus) status!: TermsSheetStatus;
}

class CompileDto {
  @IsArray() highlightMap!: HighlightMapEntry[];
  @IsOptional() @IsString() @MaxLength(2) lang?: string;
}

class RefsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsString({ each: true }) @IsNotEmpty({ each: true })
  refs!: string[];
}

class LangDto {
  @IsString() @MinLength(2) @MaxLength(2) lang!: string;
}

class DialogueAnswerDto {
  @IsString() clauseId!: string;
  @IsOptional() @IsString() @MaxLength(8000) text?: string | null;
  @IsOptional() @IsString() segmentId?: string | null;
}

@Controller('terms-sheets')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class TermsSheetController {
  constructor(
    private readonly sheets: TermsSheetService,
    private readonly cv: CvVariantService,
    private readonly dialogue: CvDialogueService,
  ) {}

  @Post('projects/:projectId/vacancy')
  openVacancy(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.sheets.openVacancySheet(userId, projectId);
  }

  @Post('from-candidate/:pipelineStatusId')
  openForCandidate(@CurrentUser() userId: string, @Param('pipelineStatusId') id: string) {
    return this.sheets.openForCandidate(userId, id);
  }

  @Post('from-vacancy/:vacancyId')
  openForVacancy(@CurrentUser() userId: string, @Param('vacancyId') id: string) {
    return this.sheets.openForVacancy(userId, id);
  }

  /** К-23 (аудит 2026-09-03): расхождения между вариантами CV одного
   * соискателя. Сервис был написан целиком, но маршрута к нему не было —
   * функция существовала только в исходниках. */
  @Get('projects/:projectId/cv-consistency')
  cvConsistency(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.cv.consistency(userId, projectId);
  }

  @Get('projects/:projectId')
  list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.sheets.listForProject(userId, projectId);
  }

  @Get(':id')
  get(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.sheets.get(userId, id);
  }

  @Get(':id/revisions/:clauseId')
  revisions(@CurrentUser() userId: string, @Param('id') id: string, @Param('clauseId') clauseId: string) {
    return this.sheets.revisions(userId, id, clauseId);
  }

  /** К-5: открытые пункты → нейтральные вопросы для письма или собеседования. */
  @Post(':id/clarifying-questions')
  clarifyingQuestions(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.sheets.clarifyingQuestions(userId, id);
  }

  @Get(':id/agenda')
  agenda(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.sheets.agenda(userId, id);
  }

  @Post(':id/clauses')
  addClause(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: AddClauseDto) {
    return this.sheets.addClause(userId, id, dto);
  }

  @Post(':id/clauses/confirm')
  confirmClauses(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: IdsDto) {
    return this.sheets.confirmClauses(userId, id, dto.ids);
  }

  @Post(':id/clauses/reject')
  rejectClauses(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: IdsDto) {
    return this.sheets.rejectClauses(userId, id, dto.ids);
  }

  @Patch(':id/clauses/:clauseId')
  setCounterpart(@CurrentUser() userId: string, @Param('id') id: string, @Param('clauseId') clauseId: string, @Body() dto: CounterpartDto) {
    return this.sheets.setCounterpart(userId, id, clauseId, dto.counterpartClauseId ?? null);
  }

  @Post(':id/counterparts/propose')
  proposeCounterparts(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.sheets.proposeCounterparts(userId, id);
  }

  @Post(':id/propose')
  propose(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: ProposeDto) {
    return this.sheets.propose(userId, id, dto);
  }

  @Post(':id/positions')
  addPosition(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: AddPositionDto) {
    return this.sheets.addPosition(userId, id, dto);
  }

  @Post(':id/positions/confirm')
  confirmPositions(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: IdsDto) {
    return this.sheets.confirmPositions(userId, id, dto.ids);
  }

  @Post(':id/positions/reject')
  rejectPositions(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: IdsDto) {
    return this.sheets.rejectPositions(userId, id, dto.ids);
  }

  @Post(':id/offers')
  addOffer(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: AddOfferDto) {
    return this.sheets.addOffer(userId, id, dto);
  }

  @Post(':id/offer-draft')
  offerDraft(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.sheets.offerDraft(userId, id);
  }

  @Patch(':id/status')
  setStatus(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: StatusDto) {
    return this.sheets.setStatus(userId, id, dto.status);
  }

  // ── CV-вариант ──

  @Post(':id/cv-variant/propose')
  proposeHighlightMap(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.cv.proposeHighlightMap(userId, id);
  }

  @Post(':id/cv-variant/compile')
  compile(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: CompileDto) {
    return this.cv.compile(userId, id, dto.highlightMap, dto.lang ?? 'ru');
  }

  // ── Диалог по пунктам (К-21) ──

  @Get(':id/dialogue/next')
  dialogueNext(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.dialogue.nextQuestion(userId, id);
  }

  @Post(':id/dialogue/answer')
  dialogueAnswer(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: DialogueAnswerDto) {
    return this.dialogue.recordAnswer(userId, id, dto.clauseId, { text: dto.text ?? null, segmentId: dto.segmentId ?? null });
  }
}

@Controller('cv-variants')
@UseGuards(TelegramAuthGuard, ProjectFrozenGuard)
@UseInterceptors(ApiResponseInterceptor)
export class CvVariantController {
  constructor(private readonly cv: CvVariantService) {}

  /** Вариант целиком (текст, карта, обратная сверка) — экран TMA. */
  @Get(':id')
  get(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.cv.getOwned(userId, id);
  }

  @Post(':id/review')
  review(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.cv.review(userId, id);
  }

  @Post(':id/rephrase')
  rephrase(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: RefsDto) {
    return this.cv.rephrase(userId, id, dto.refs);
  }

  @Post(':id/rephrase/confirm')
  confirmRephrase(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: RefsDto) {
    return this.cv.confirmRephrase(userId, id, dto.refs);
  }

  @Post(':id/translate')
  translate(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: LangDto) {
    return this.cv.translate(userId, id, dto.lang);
  }
}

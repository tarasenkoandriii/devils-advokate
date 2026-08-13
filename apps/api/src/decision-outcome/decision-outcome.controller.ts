import { Body, Controller, Get, Param, Post, Put, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { DecisionOutcomeService } from './decision-outcome.service';
import { DecisionOutcomeRating, EscalationCategory } from '@prisma/client';

class RecordOutcomeDto {
  actualOutcome!: DecisionOutcomeRating;
  outcomeNotes?: string;
  category?: string;
}

class LogEscalationCategoryDto {
  sessionId!: string;
  category!: EscalationCategory;
}

@Controller()
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class DecisionOutcomeController {
  constructor(private readonly decisionOutcome: DecisionOutcomeService) {}

  @Put('projects/:projectId/outcome')
  async record(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: RecordOutcomeDto,
  ) {
    return this.decisionOutcome.recordOutcome(userId, projectId, dto);
  }

  @Get('projects/:projectId/outcome')
  async get(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.decisionOutcome.getOutcome(userId, projectId);
  }

  // Уровень пользователя, не проекта — калибровка агрегирует по ВСЕМ
  // проектам разом, поэтому не вложен в /projects/:projectId/.
  @Get('calibration-summary')
  async summary(@CurrentUser() userId: string) {
    return this.decisionOutcome.getCalibrationSummary(userId);
  }

  // Пункт 73 (§3.34 ТЗ) — та же логика "уровень пользователя", что и
  // calibration-summary выше.
  @Get('success-stats')
  async successStats(@CurrentUser() userId: string) {
    return this.decisionOutcome.getSuccessStats(userId);
  }

  // Пункт 85 — след категории накала во времени (§3.34 ТЗ, вторая
  // метрика). Уровень проекта, не пользователя — событие относится к
  // конкретному разговору.
  @Post('projects/:projectId/escalation-category-events')
  async logEscalationCategory(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: LogEscalationCategoryDto,
  ) {
    return this.decisionOutcome.logEscalationCategory(userId, projectId, dto.sessionId, dto.category);
  }
}

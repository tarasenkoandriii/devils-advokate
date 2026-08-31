// Пункт [prompt-framework]: контролер поверх EvaluationService,
// devils-advocate-prompt-framework-tz.md §5.2.

import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { EvaluationService } from './evaluation.service';

class CreateDatasetDto {
  name!: string;
  version!: string;
  description?: string;
}

class AddCasesDto {
  cases!: Array<{ input: string; expectedOutput?: unknown; caseType: 'classification' | 'structural' }>;
}

class EvaluateDto {
  evaluationDatasetId!: string;
}

@UseGuards(AdminSessionGuard)
@UseInterceptors(ApiResponseInterceptor)
@Controller()
export class EvaluationController {
  constructor(private readonly evaluation: EvaluationService) {}

  @Post('admin/evaluation-datasets')
  async createDataset(@CurrentUser() userId: string, @Body() dto: CreateDatasetDto) {
    return this.evaluation.createDataset(userId, dto.name, dto.version, dto.description);
  }

  @Post('admin/evaluation-datasets/:id/cases')
  async addCases(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: AddCasesDto) {
    return this.evaluation.addCases(userId, id, dto.cases);
  }

  @Post('admin/prompts/:id/evaluate')
  async evaluate(@CurrentUser() userId: string, @Param('id') id: string, @Body() dto: EvaluateDto) {
    return this.evaluation.evaluate(userId, id, dto.evaluationDatasetId);
  }

  @Get('admin/evaluation-runs/:id')
  async getRun(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.evaluation.getRun(userId, id);
  }
}

import { Body, Controller, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PredictionService } from './prediction.service';

class CreatePredictionDto {
  predictedOutcome!: string;
}

class RecordActualOutcomeDto {
  actualOutcome!: string;
}

@Controller()
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class PredictionController {
  constructor(private readonly prediction: PredictionService) {}

  @Post('projects/:projectId/predictions')
  async create(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreatePredictionDto,
  ) {
    return this.prediction.create(userId, projectId, dto.predictedOutcome);
  }

  @Get('projects/:projectId/predictions')
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.prediction.list(userId, projectId);
  }

  @Patch('predictions/:id/actual-outcome')
  async recordActualOutcome(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body() dto: RecordActualOutcomeDto,
  ) {
    return this.prediction.recordActualOutcome(userId, id, dto.actualOutcome);
  }
}

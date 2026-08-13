import { Body, Controller, Get, Param, Put, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { DecisionObjectiveService, SaveDecisionObjectiveInput } from './decision-objective.service';

@Controller('projects/:projectId/objective')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class DecisionObjectiveController {
  constructor(private readonly objectiveService: DecisionObjectiveService) {}

  @Get()
  async get(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.objectiveService.get(userId, projectId);
  }

  @Put()
  async save(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: SaveDecisionObjectiveInput,
  ) {
    return this.objectiveService.save(userId, projectId, dto);
  }
}

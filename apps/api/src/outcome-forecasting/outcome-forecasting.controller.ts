import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { OutcomeForecastingService } from './outcome-forecasting.service';

class GenerateScenariosDto {
  userScenarioDescriptions?: string[];
  engineId?: string;
}

@Controller('projects/:projectId/outcome-scenarios')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class OutcomeForecastingController {
  constructor(private readonly outcomeForecasting: OutcomeForecastingService) {}

  @Post()
  async generateScenarios(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: GenerateScenariosDto,
  ) {
    return this.outcomeForecasting.generateScenarios(
      userId,
      projectId,
      dto?.userScenarioDescriptions ?? [],
      dto?.engineId,
    );
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.outcomeForecasting.list(userId, projectId);
  }
}

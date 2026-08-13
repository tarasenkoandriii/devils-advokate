import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { MotiveAnalysisService } from './motive-analysis.service';

class AnalyzeMotivesDto {
  engineId?: string;
}

@Controller('projects/:projectId/people/:personId/motive-hypotheses')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class MotiveAnalysisController {
  constructor(private readonly motiveAnalysis: MotiveAnalysisService) {}

  @Post()
  async analyze(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('personId') personId: string,
    @Body() dto: AnalyzeMotivesDto,
  ) {
    return this.motiveAnalysis.analyze(userId, projectId, personId, dto?.engineId);
  }

  @Get()
  async list(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('personId') personId: string,
  ) {
    return this.motiveAnalysis.list(userId, projectId, personId);
  }
}

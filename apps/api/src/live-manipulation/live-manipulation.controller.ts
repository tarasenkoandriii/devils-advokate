import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { LiveManipulationService } from './live-manipulation.service';

class AnalyzeDto {
  transcriptWindow!: string;
  engineId?: string;
}

@Controller('projects/:projectId/live-manipulation-flags')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class LiveManipulationController {
  constructor(private readonly liveManipulation: LiveManipulationService) {}

  @Post()
  async analyze(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: AnalyzeDto,
  ) {
    return this.liveManipulation.analyze(userId, projectId, dto.transcriptWindow, dto?.engineId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.liveManipulation.list(userId, projectId);
  }
}

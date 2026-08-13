import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ProbingDetectorService } from './probing-detector.service';

class AnalyzeDto {
  transcriptWindow!: string;
  engineId?: string;
}

@Controller('projects/:projectId/probing-topics')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ProbingDetectorController {
  constructor(private readonly probingDetector: ProbingDetectorService) {}

  @Post()
  async analyze(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: AnalyzeDto,
  ) {
    return this.probingDetector.analyze(userId, projectId, dto.transcriptWindow, dto?.engineId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.probingDetector.list(userId, projectId);
  }
}

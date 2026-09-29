import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ProbingDetectorService } from './probing-detector.service';

class AnalyzeDto {
  transcriptWindow!: string;
  engineId?: string;
  // Пункт [project-log-v2] — с кем идёт разговор, если пользователь выбрал.
  personId?: string | null;
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
    return this.probingDetector.analyze(userId, projectId, dto.transcriptWindow, dto?.engineId, dto?.personId ?? null);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.probingDetector.list(userId, projectId);
  }
}

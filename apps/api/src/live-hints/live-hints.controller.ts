import { Body, Controller, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { LiveHintsService } from './live-hints.service';

class AnalyzeDto {
  transcriptWindow!: string;
  engineId?: string;
}

@Controller('projects/:projectId/live-hints')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class LiveHintsController {
  constructor(private readonly liveHints: LiveHintsService) {}

  @Post()
  async analyze(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: AnalyzeDto,
  ) {
    return this.liveHints.analyze(userId, projectId, dto.transcriptWindow, dto?.engineId);
  }

  // Пункт [interview-pool] §4.2/§5 ТЗ — ТЗ проєктував це як той самий
  // ендпоінт з полем mode:'interview_pool' у тілі запиту; тут — окремий
  // маршрут, той самий принцип, що вже застосований у цьому проекті
  // (не диспетчеризація за прапорцем у тілі, окремий явний шлях).
  @Post('interview')
  async analyzeForInterview(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: AnalyzeDto,
  ) {
    return this.liveHints.analyzeForInterview(userId, projectId, dto.transcriptWindow, dto?.engineId);
  }

  @Patch(':eventId/dismiss')
  async dismiss(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.liveHints.markDismissed(userId, projectId, eventId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.liveHints.list(userId, projectId);
  }
}

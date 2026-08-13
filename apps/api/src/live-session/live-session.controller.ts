import { Body, Controller, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { LiveSessionService } from './live-session.service';

class LogNudgeEventDto {
  peakVolumeDb?: number;
  escalationScore?: number;
}

@Controller()
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class LiveSessionController {
  constructor(private readonly liveSession: LiveSessionService) {}

  // Уровень пользователя, не проекта — токен не привязан к конкретному
  // проекту, клиент решает, для какого разговора его использовать.
  @Post('live-session/transcription-token')
  async mintToken() {
    return this.liveSession.mintTranscriptionToken();
  }

  @Post('projects/:projectId/cooldown-nudge-events')
  async logEvent(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: LogNudgeEventDto,
  ) {
    return this.liveSession.logNudgeEvent(userId, projectId, dto?.peakVolumeDb ?? null, dto?.escalationScore ?? null);
  }

  @Patch('projects/:projectId/cooldown-nudge-events/:eventId/dismiss')
  async dismiss(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.liveSession.markDismissed(userId, projectId, eventId);
  }

  @Get('projects/:projectId/cooldown-nudge-events')
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.liveSession.list(userId, projectId);
  }
}

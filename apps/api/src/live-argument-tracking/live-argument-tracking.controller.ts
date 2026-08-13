import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { LiveArgumentTrackingService } from './live-argument-tracking.service';

class CheckStatusDto {
  transcriptWindow!: string;
  engineId?: string;
}

@Controller('projects/:projectId/live-argument-tracking')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class LiveArgumentTrackingController {
  constructor(private readonly liveArgumentTracking: LiveArgumentTrackingService) {}

  @Post('initialize')
  async initialize(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.liveArgumentTracking.initialize(userId, projectId);
  }

  @Post('check')
  async checkStatus(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CheckStatusDto,
  ) {
    return this.liveArgumentTracking.checkStatus(userId, projectId, dto.transcriptWindow, dto?.engineId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.liveArgumentTracking.list(userId, projectId);
  }
}

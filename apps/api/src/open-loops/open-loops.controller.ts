import { Controller, Get, Param, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { OpenLoopsService } from './open-loops.service';

// GET, не POST — чистая агрегация уже существующих данных, не
// AI-вызов, тот же принцип, что EvidenceGapController/StaleFactController.
@Controller('projects/:projectId/open-loops')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class OpenLoopsController {
  constructor(private readonly openLoops: OpenLoopsService) {}

  @Get()
  async getSummary(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.openLoops.getSummary(userId, projectId);
  }
}

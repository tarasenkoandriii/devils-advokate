import { Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ManipulationDetectorService } from './manipulation-detector.service';

@Controller('conversations/:conversationId/manipulation-patterns')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ManipulationDetectorController {
  constructor(private readonly manipulationDetector: ManipulationDetectorService) {}

  @Post('detect')
  async detect(@CurrentUser() userId: string, @Param('conversationId') conversationId: string) {
    return this.manipulationDetector.detect(userId, conversationId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('conversationId') conversationId: string) {
    return this.manipulationDetector.list(userId, conversationId);
  }
}

import { Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { DoNotSayService } from './do-not-say.service';

@Controller('conversations/:conversationId/do-not-say')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class DoNotSayController {
  constructor(private readonly doNotSay: DoNotSayService) {}

  @Post('detect')
  async detect(@CurrentUser() userId: string, @Param('conversationId') conversationId: string) {
    return this.doNotSay.detect(userId, conversationId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('conversationId') conversationId: string) {
    return this.doNotSay.list(userId, conversationId);
  }
}

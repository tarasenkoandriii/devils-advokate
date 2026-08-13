import { Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { BestNextMoveService } from './best-next-move.service';

@Controller('conversations/:conversationId/best-next-move')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class BestNextMoveController {
  constructor(private readonly bestNextMove: BestNextMoveService) {}

  @Post('detect')
  async detect(@CurrentUser() userId: string, @Param('conversationId') conversationId: string) {
    return this.bestNextMove.detect(userId, conversationId);
  }

  @Get()
  async getLatest(@CurrentUser() userId: string, @Param('conversationId') conversationId: string) {
    return this.bestNextMove.getLatest(userId, conversationId);
  }
}

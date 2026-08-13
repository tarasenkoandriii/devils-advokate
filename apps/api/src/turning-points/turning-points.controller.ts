import { Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { TurningPointsService } from './turning-points.service';

@Controller('conversations/:conversationId/turning-points')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class TurningPointsController {
  constructor(private readonly turningPoints: TurningPointsService) {}

  @Post('detect')
  async detect(@CurrentUser() userId: string, @Param('conversationId') conversationId: string) {
    return this.turningPoints.detect(userId, conversationId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('conversationId') conversationId: string) {
    return this.turningPoints.list(userId, conversationId);
  }
}

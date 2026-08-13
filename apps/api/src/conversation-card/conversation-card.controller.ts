import { Controller, Get, Param, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ConversationCardService } from './conversation-card.service';

@Controller('projects/:projectId/card')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ConversationCardController {
  constructor(private readonly cardService: ConversationCardService) {}

  @Get()
  async get(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.cardService.get(userId, projectId);
  }
}

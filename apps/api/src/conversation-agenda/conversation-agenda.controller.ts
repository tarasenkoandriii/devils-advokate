import { Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ConversationAgendaService } from './conversation-agenda.service';

@Controller('projects/:projectId/agenda')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ConversationAgendaController {
  constructor(private readonly agenda: ConversationAgendaService) {}

  @Post('generate')
  async generate(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.agenda.generate(userId, projectId);
  }

  @Get()
  async getLatest(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.agenda.getLatest(userId, projectId);
  }
}

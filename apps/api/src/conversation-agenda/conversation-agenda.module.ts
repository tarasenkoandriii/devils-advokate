import { Module } from '@nestjs/common';
import { ConversationAgendaController } from './conversation-agenda.controller';
import { ConversationAgendaService } from './conversation-agenda.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [ConversationAgendaController],
  providers: [ConversationAgendaService],
  exports: [ConversationAgendaService],
})
export class ConversationAgendaModule {}

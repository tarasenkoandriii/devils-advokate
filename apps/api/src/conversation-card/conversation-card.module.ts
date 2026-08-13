import { Module } from '@nestjs/common';
import { ConversationCardController } from './conversation-card.controller';
import { ConversationCardService } from './conversation-card.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { DoNotSayModule } from '../do-not-say/do-not-say.module';
import { StaleFactModule } from '../stale-fact/stale-fact.module';
import { ConversationAgendaModule } from '../conversation-agenda/conversation-agenda.module';
import { ProtectedNoteModule } from '../protected-note/protected-note.module';

@Module({
  imports: [TelegramAuthModule, DoNotSayModule, StaleFactModule, ConversationAgendaModule, ProtectedNoteModule],
  controllers: [ConversationCardController],
  providers: [ConversationCardService],
})
export class ConversationCardModule {}

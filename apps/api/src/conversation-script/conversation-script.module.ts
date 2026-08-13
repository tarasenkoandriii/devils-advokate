import { Module } from '@nestjs/common';
import { ConversationScriptController } from './conversation-script.controller';
import { ConversationScriptService } from './conversation-script.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [ConversationScriptController],
  providers: [ConversationScriptService],
  exports: [ConversationScriptService],
})
export class ConversationScriptModule {}

import { Module } from '@nestjs/common';
import { MaterialChatController } from './material-chat.controller';
import { MaterialChatService } from './material-chat.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { SecretsModule } from '../secrets/secrets.module';
import { TextToSpeechModule } from '../text-to-speech/text-to-speech.module';

// Пункт 91 (§3.27 ТЗ) — тот же набор импортов, что SparringModule
// (Пункт 69/90): ConversationsModule ради TranscriptionService,
// SecretsModule ради ключа AssemblyAI, TextToSpeechModule ради уже
// существующего ElevenLabs-синтеза — все три уже проверены в бою
// на спарринге, здесь просто ещё один потребитель.
@Module({
  imports: [TelegramAuthModule, AIRouterModule, ConversationsModule, SecretsModule, TextToSpeechModule],
  controllers: [MaterialChatController],
  providers: [MaterialChatService],
  exports: [MaterialChatService],
})
export class MaterialChatModule {}

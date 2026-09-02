import { Module } from '@nestjs/common';
import { SttModule } from '../stt/stt.module';
import { SparringController } from './sparring.controller';
import { SparringService } from './sparring.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { SecretsModule } from '../secrets/secrets.module';
import { TextToSpeechModule } from '../text-to-speech/text-to-speech.module';

// Пункт 69 (§3.26 ТЗ) — ConversationsModule импортирован ради
// TranscriptionService (голосовой ввод реплики), SecretsModule ради
// ключа AssemblyAI — тот же провайдер, что уже используется для
// транскрибации разговоров, не задублирован.
// Пункт 90 (§3.26 ТЗ) — TextToSpeechModule ради уже существующего
// TextToSpeechService (Пункт 63), впервые реально подключаемого к
// голосовому выводу реплик оппонента, не задублирован новой
// интеграцией ElevenLabs.
@Module({
  imports: [TelegramAuthModule, AIRouterModule, ConversationsModule, SecretsModule, TextToSpeechModule, SttModule],
  controllers: [SparringController],
  providers: [SparringService],
  exports: [SparringService],
})
export class SparringModule {}

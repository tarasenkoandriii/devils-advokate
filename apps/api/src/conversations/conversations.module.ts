import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { TranscriptionService } from './transcription.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { ConsentModule } from '../consent/consent.module';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [TelegramAuthModule, ConsentModule, SecretsModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, TranscriptionService],
  // TranscriptionService экспортирован дополнительно к
  // ConversationsService (Пункт 69, §3.26 ТЗ) — переиспользуется в
  // SparringModule для голосового ввода реплик, не задублирован.
  exports: [ConversationsService, TranscriptionService],
})
export class ConversationsModule {}

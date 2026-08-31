import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { TranscriptionService } from './transcription.service';
import { AudioUploadController } from './audio-upload.controller';
import { AudioBlobService } from './audio-blob.service';
import { ParalinguisticsService } from './paralinguistics.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { ConsentModule } from '../consent/consent.module';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [TelegramAuthModule, ConsentModule, SecretsModule],
  // Пункт [blob-upload] 2026-08-31: AudioUploadController — второй
  // контроллер модуля, а не метод в первом, потому что у эндпоинта
  // выдачи blob-токена чужой формат ответа (его разбирает клиентский
  // SDK @vercel/blob). Подробное объяснение — в шапке того файла.
  controllers: [ConversationsController, AudioUploadController],
  providers: [ConversationsService, TranscriptionService, AudioBlobService, ParalinguisticsService],
  // TranscriptionService экспортирован дополнительно к
  // ConversationsService (Пункт 69, §3.26 ТЗ) — переиспользуется в
  // SparringModule для голосового ввода реплик, не задублирован.
  // AudioBlobService — для AdminSandboxModule (загрузка реального файла
  // из песочницы идёт тем же протоколом, что у TMA). Отсутствие этого
  // экспорта поймал app-bootstrap.spec.ts — тот самый тест, ради
  // которого он и был написан после инцидента с SecretsService.
  exports: [ConversationsService, TranscriptionService, AudioBlobService],
})
export class ConversationsModule {}

// Пункт [blob-upload] 2026-08-31 — контроллер выдачи клиентского токена
// на прямую загрузку в Vercel Blob.
//
// ОТДЕЛЬНЫЙ контроллер, а не ещё один метод в ConversationsController,
// по одной конкретной причине: у эндпоинта выдачи токена ЧУЖОЙ формат
// ответа. Его разбирает клиентская половина @vercel/blob, и она ждёт
// ровно ту JSON-структуру, которую вернул handleUpload — а
// ApiResponseInterceptor, висящий на ConversationsController, завернул
// бы её в наш конверт {success, data}, и клиентский SDK не понял бы
// ответ. Убирать интерцептор с общего контроллера ради одного метода
// нельзя, а точечного «не оборачивай меня» в проекте нет — поэтому
// граница проведена по контроллеру. Здесь же и объяснение, почему это
// единственное место в API без общего конверта.
//
// Эндпоинт ПОДТВЕРЖДЕНИЯ загрузки (шаг 3) намеренно живёт в обычном
// ConversationsController — у него наш собственный формат ответа, и
// исключение из правила должно быть минимальным.

import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { HandleUploadBody } from '@vercel/blob/client';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { AudioBlobService } from './audio-blob.service';

@Controller()
export class AudioUploadController {
  constructor(private readonly audioBlob: AudioBlobService) {}

  @Post('conversations/:id/audio-upload-token')
  @UseGuards(TelegramAuthGuard)
  async issueToken(
    @CurrentUser() userId: string,
    @Param('id') conversationId: string,
    @Body() body: HandleUploadBody,
    @Req() req: Request,
  ) {
    return this.audioBlob.issueUploadToken(userId, conversationId, body, req);
  }
}

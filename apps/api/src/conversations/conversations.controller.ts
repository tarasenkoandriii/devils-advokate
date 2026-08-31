// Пункт 13: ConversationsController.
//
// Webhook-эндпоинт (/webhook/transcription) НЕ под TelegramAuthGuard —
// AssemblyAI не может пройти Telegram-авторизацию, сопоставление с
// конкретным Conversation идёт по externalTranscriptionJobId внутри
// ConversationsService, не по userId из guard'а. Остальные эндпоинты —
// как обычно, под TelegramAuthGuard.

import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { AssemblyAiWebhookGuard } from '../common/webhook/assemblyai-webhook.guard';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { RequestTranscriptionDto } from './dto/request-transcription.dto';
import type { AssemblyAiWebhookPayload } from './transcription.service';

class AssignParticipantDto {
  personId?: string;
  isSelf?: boolean;
}

/** Пункт [blob-upload] 2026-08-31. Только pathname — намеренно: размер
 * и тип содержимого мы берём из head() у самого стора, а не со слов
 * клиента (см. AudioBlobService.confirmUpload). Класс, а не интерфейс,
 * по той же причине, что и AssignParticipantDto выше — Nest нужен
 * рантайм-тип для @Body(). */
class ConfirmAudioBlobDto {
  pathname!: string;
}

@Controller()
@UseInterceptors(ApiResponseInterceptor)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Post('projects/:projectId/conversations')
  @UseGuards(TelegramAuthGuard)
  async create(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversations.create(userId, projectId, dto);
  }

  @Get('projects/:projectId/conversations')
  @UseGuards(TelegramAuthGuard)
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.conversations.list(userId, projectId);
  }

  @Get('conversations/:id')
  @UseGuards(TelegramAuthGuard)
  async get(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.conversations.get(userId, id);
  }

  // Пункт [blob-upload] 2026-08-31 — шаг 3 протокола прямой загрузки:
  // клиент сообщает, что файл записан в приватный Vercel Blob. Шаг 1
  // (выдача токена) живёт в отдельном AudioUploadController — у него
  // чужой формат ответа, объяснение там.
  @Post('conversations/:id/audio-blob')
  @UseGuards(TelegramAuthGuard)
  async confirmAudioBlob(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body() dto: ConfirmAudioBlobDto,
  ) {
    return this.conversations.confirmAudioUpload(userId, id, dto);
  }

  // Потоковая загрузка аудио без буферизации — см. обоснование в
  // TranscriptionService.streamUpload().
  //
  // Пункт [blob-upload] 2026-08-31 — ПУТЬ СОХРАНЁН, НО НЕ ОСНОВНОЙ.
  // На Vercel он неработоспособен: тело запроса к serverless-функции
  // ограничено 4,5 МБ, и отказ приходит на уровне платформы, до этого
  // кода. Оставлен потому, что локально и в докере лимита нет, а для
  // отладки цепочки одним curl'ом он в разы проще трёхшагового
  // протокола. Удалять его ради «одного правильного способа» было бы
  // ухудшением: прод получил бы рабочий путь, а разработка — лишний
  // обязательный внешний сервис (blob-стор) там, где он не нужен.
  //
  // @Req() используется напрямую
  // для доступа к сырому телу запроса как ReadableStream — стандартный
  // Nest @Body() декоратор здесь не подходит, он парсит/буферизует
  // тело под конкретный Content-Type, что для потоковой передачи
  // произвольного бинарного файла ровно то, чего нужно избежать.
  @Post('conversations/:id/upload')
  @UseGuards(TelegramAuthGuard)
  async upload(@CurrentUser() userId: string, @Param('id') id: string, @Req() req: Request) {
    // req как Node.js IncomingMessage — это уже ReadableStream в
    // Node.js-смысле, но TranscriptionService.streamUpload() ожидает
    // Web-standard ReadableStream<Uint8Array> (fetch API), не Node
    // Readable — конвертация через Readable.toWeb() (Node 18+, тот же
    // рантайм, на который уже рассчитан весь остальной проект).
    const { Readable } = await import('node:stream');
    const webStream = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    return this.conversations.streamUploadAudio(userId, id, webStream);
  }

  @Post('conversations/:id/transcribe')
  @UseGuards(TelegramAuthGuard)
  async transcribe(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body() dto: RequestTranscriptionDto,
  ) {
    return this.conversations.requestTranscription(userId, id, dto);
  }

  @Post('conversations/webhook/transcription')
  @UseGuards(AssemblyAiWebhookGuard)
  async transcriptionWebhook(@Body() payload: AssemblyAiWebhookPayload) {
    return this.conversations.handleTranscriptionWebhook(payload);
  }

  // Пункт 26 — сопоставление лейбла диаризации фигуранту/пользователю.
  @Patch('conversation-participants/:id')
  @UseGuards(TelegramAuthGuard)
  async assignParticipant(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body() dto: AssignParticipantDto,
  ) {
    return this.conversations.assignParticipant(userId, id, dto);
  }
}

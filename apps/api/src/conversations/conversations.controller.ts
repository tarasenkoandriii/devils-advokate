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

  // Потоковая загрузка аудио без буферизации — см. обоснование в
  // TranscriptionService.streamUpload(). @Req() используется напрямую
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

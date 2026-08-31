// Пункт 55 — базовые эндпоинты спарринга. Пункт 69 (§3.26 ТЗ) добавил
// выбор архетипа при старте и голосовой ввод реплики. Webhook-
// эндпоинт (/webhook/voice-reply) НЕ под TelegramAuthGuard — тот же
// принцип, что ConversationsController: AssemblyAI не может пройти
// Telegram-авторизацию, сопоставление по externalTranscriptionJobId.

import { Body, Controller, Get, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request } from 'express';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { AssemblyAiWebhookGuard } from '../common/webhook/assemblyai-webhook.guard';
import { SparringService } from './sparring.service';
import type { AssemblyAiWebhookPayload } from '../conversations/transcription.service';
import { ArchetypeType } from '@prisma/client';

class StartSessionDto {
  targetPersonId?: string;
  engineId?: string;
  archetypeType?: ArchetypeType;
  customArchetypeDescription?: string;
  // Пункт 90 (§3.26 ТЗ) — если передан и для этой встречи есть
  // предзаготовленная реплика (см. preGenerateSparringOpener()),
  // сессия стартует с неё мгновенно, без повторного AI+TTS вызова.
  scheduledConversationId?: string;
}

class ReplyDto {
  text!: string;
  engineId?: string;
}

class SubmitVoiceReplyDto {
  audioUrl!: string;
}

@Controller()
@UseInterceptors(ApiResponseInterceptor)
export class SparringController {
  constructor(private readonly sparring: SparringService) {}

  @Post('projects/:projectId/sparring-sessions')
  @UseGuards(TelegramAuthGuard)
  async start(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: StartSessionDto,
  ) {
    return this.sparring.startSession(
      userId,
      projectId,
      dto?.targetPersonId,
      dto?.engineId,
      dto?.archetypeType,
      dto?.customArchetypeDescription,
      dto?.scheduledConversationId,
    );
  }

  @Get('projects/:projectId/sparring-sessions')
  @UseGuards(TelegramAuthGuard)
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.sparring.listSessions(userId, projectId);
  }

  @Get('sparring-sessions/:sessionId')
  @UseGuards(TelegramAuthGuard)
  async get(@CurrentUser() userId: string, @Param('sessionId') sessionId: string) {
    return this.sparring.getSession(userId, sessionId);
  }

  @Post('sparring-sessions/:sessionId/reply')
  @UseGuards(TelegramAuthGuard)
  async reply(
    @CurrentUser() userId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: ReplyDto,
  ) {
    return this.sparring.reply(userId, sessionId, dto.text, dto?.engineId);
  }

  @Post('sparring-sessions/:sessionId/end')
  @UseGuards(TelegramAuthGuard)
  async end(@CurrentUser() userId: string, @Param('sessionId') sessionId: string) {
    return this.sparring.endSession(userId, sessionId);
  }

  // ── Пункт 69: голосовой ввод (§3.26 ТЗ) ──

  // Потоковая загрузка без буферизации — тот же паттерн, что
  // ConversationsController.upload().
  @Post('sparring-sessions/:sessionId/voice-upload')
  @UseGuards(TelegramAuthGuard)
  async voiceUpload(
    @CurrentUser() userId: string,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
  ) {
    const { Readable } = await import('node:stream');
    const webStream = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    return this.sparring.streamUploadVoiceReply(userId, sessionId, webStream);
  }

  @Post('sparring-sessions/:sessionId/voice-reply')
  @UseGuards(TelegramAuthGuard)
  async submitVoiceReply(
    @CurrentUser() userId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: SubmitVoiceReplyDto,
  ) {
    return this.sparring.submitVoiceReply(userId, sessionId, dto.audioUrl);
  }

  @Get('sparring-sessions/:sessionId/voice-reply/:jobId')
  @UseGuards(TelegramAuthGuard)
  async getVoiceReplyStatus(
    @CurrentUser() userId: string,
    @Param('sessionId') sessionId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.sparring.getVoiceReplyStatus(userId, sessionId, jobId);
  }

  @Post('sparring-sessions/webhook/voice-reply')
  @UseGuards(AssemblyAiWebhookGuard)
  async voiceReplyWebhook(@Body() payload: AssemblyAiWebhookPayload) {
    return this.sparring.handleVoiceReplyWebhook(payload);
  }
}

// Пункт 91 (§3.27 ТЗ) — эндпоинты голосового чата для критики
// материалов. Тот же принцип, что SparringController — webhook-
// эндпоинт НЕ под TelegramAuthGuard (AssemblyAI не может пройти
// Telegram-авторизацию, сопоставление по externalTranscriptionJobId).

import { Body, Controller, Get, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request } from 'express';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { SttWebhookGuard } from '../common/webhook/stt-webhook.guard';
import { MaterialChatService } from './material-chat.service';

class StartSessionDto {
  engineId?: string;
}

class ReplyDto {
  text!: string;
  engineId?: string;
}

class SubmitVoiceReplyDto {
  audioUrl!: string;
  /** Пункт [stt-multi] 2026-09-02 — см. sparring.controller.ts. */
  sttProvider?: 'soniox' | 'assemblyai' | 'elevenlabs';
}

@Controller()
@UseInterceptors(ApiResponseInterceptor)
export class MaterialChatController {
  constructor(private readonly materialChat: MaterialChatService) {}

  @Post('projects/:projectId/working-materials/:workingMaterialId/chat-sessions')
  @UseGuards(TelegramAuthGuard)
  async start(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('workingMaterialId') workingMaterialId: string,
    @Body() dto: StartSessionDto,
  ) {
    return this.materialChat.startSession(userId, projectId, workingMaterialId, dto?.engineId);
  }

  @Get('projects/:projectId/working-materials/:workingMaterialId/chat-sessions')
  @UseGuards(TelegramAuthGuard)
  async list(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('workingMaterialId') workingMaterialId: string,
  ) {
    return this.materialChat.listSessions(userId, projectId, workingMaterialId);
  }

  @Get('material-chat-sessions/:sessionId')
  @UseGuards(TelegramAuthGuard)
  async get(@CurrentUser() userId: string, @Param('sessionId') sessionId: string) {
    return this.materialChat.getSession(userId, sessionId);
  }

  @Post('material-chat-sessions/:sessionId/reply')
  @UseGuards(TelegramAuthGuard)
  async reply(
    @CurrentUser() userId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: ReplyDto,
  ) {
    return this.materialChat.reply(userId, sessionId, dto.text, dto?.engineId);
  }

  @Post('material-chat-sessions/:sessionId/end')
  @UseGuards(TelegramAuthGuard)
  async end(@CurrentUser() userId: string, @Param('sessionId') sessionId: string) {
    return this.materialChat.endSession(userId, sessionId);
  }

  @Post('material-chat-sessions/:sessionId/voice-upload')
  @UseGuards(TelegramAuthGuard)
  async voiceUpload(
    @CurrentUser() userId: string,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
  ) {
    const { Readable } = await import('node:stream');
    const webStream = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    return this.materialChat.streamUploadVoiceReply(userId, sessionId, webStream, req.headers['content-type'] ?? null);
  }

  @Post('material-chat-sessions/:sessionId/voice-reply')
  @UseGuards(TelegramAuthGuard)
  async submitVoiceReply(
    @CurrentUser() userId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: SubmitVoiceReplyDto,
  ) {
    return this.materialChat.submitVoiceReply(userId, sessionId, dto.audioUrl, dto.sttProvider);
  }

  @Get('material-chat-sessions/:sessionId/voice-reply/:jobId')
  @UseGuards(TelegramAuthGuard)
  async getVoiceReplyStatus(
    @CurrentUser() userId: string,
    @Param('sessionId') sessionId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.materialChat.getVoiceReplyStatus(userId, sessionId, jobId);
  }

  @Post('material-chat-sessions/webhook/voice-reply')
  @UseGuards(SttWebhookGuard)
  async voiceReplyWebhook(@Body() payload: unknown) {
    return this.materialChat.handleVoiceReplyWebhook(payload);
  }
}

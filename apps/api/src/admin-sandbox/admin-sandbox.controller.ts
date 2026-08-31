// Пункт [admin-sandbox] 2026-08-31 — контроллер песочницы. Тонкий слой
// над AdminSandboxService: авторизация — AdminSessionGuard (та же
// httpOnly-cookie, что у остальной админки), проверка isOperator — в
// сервисе, как у admin-users (граница по роли живёт рядом с логикой,
// а не в декораторах, которые легко забыть на новом методе).

import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { AdminSandboxService, SandboxAnalysisKind } from './admin-sandbox.service';

class YouTubeSearchDto {
  query!: string;
}

class AnalyzeDto {
  conversationId!: string;
  kind!: SandboxAnalysisKind;
}

// Вторая итерация 2026-08-31 — загрузка реального файла из песочницы.
class CreateUploadConversationDto {
  isVideo?: boolean;
  durationSeconds?: number;
}

class UploadTokenDto {
  conversationId!: string;
  pathname!: string;
}

class ConfirmUploadDto {
  conversationId!: string;
  pathname!: string;
}

class TranscribeDto {
  conversationId!: string;
  languageCode?: string;
}

// Третья итерация 2026-08-31 — песочная очередь медиа-разбора.
class AddToQueueDto {
  youtubeVideoId!: string;
  title!: string;
  channelName!: string;
  thumbnailUrl!: string;
  durationSeconds?: number;
  publishedAt?: string;
}

class LinkQueueItemDto {
  itemId!: string;
  conversationId!: string;
}

@Controller('admin/sandbox')
@UseGuards(AdminSessionGuard)
@UseInterceptors(ApiResponseInterceptor)
export class AdminSandboxController {
  constructor(private readonly sandbox: AdminSandboxService) {}

  @Get('status')
  async status(@CurrentUser() userId: string) {
    return this.sandbox.getStatus(userId);
  }

  @Post('consents')
  async grantConsents(@CurrentUser() userId: string) {
    return this.sandbox.grantOwnConsents(userId);
  }

  @Post('youtube-search')
  async youtubeSearch(@CurrentUser() userId: string, @Body() dto: YouTubeSearchDto) {
    return this.sandbox.youtubeSearch(userId, dto.query);
  }

  @Post('transcription')
  async runTranscription(@CurrentUser() userId: string) {
    return this.sandbox.runTranscriptionSmoke(userId);
  }

  @Get('conversation/:id')
  async conversation(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.sandbox.getConversation(userId, id);
  }

  @Post('analyze')
  async analyze(@CurrentUser() userId: string, @Body() dto: AnalyzeDto) {
    return this.sandbox.analyze(userId, dto.conversationId, dto.kind);
  }

  // ── Загрузка реального аудио/видео (вторая итерация 2026-08-31) ──
  // В отличие от TMA-эндпоинта выдачи токена (audio-upload.controller.ts,
  // без интерцептора — его ответ разбирает SDK), здесь ответ в НАШЕМ
  // конверте: клиентскую половину протокола админка выполняет сама
  // (put() с готовым токеном), поэтому обычный формат уместен.

  @Post('upload-conversation')
  async createUploadConversation(@CurrentUser() userId: string, @Body() dto: CreateUploadConversationDto) {
    return this.sandbox.createUploadConversation(userId, dto.isVideo ?? false, dto.durationSeconds);
  }

  @Post('upload-token')
  async uploadToken(@CurrentUser() userId: string, @Body() dto: UploadTokenDto) {
    return this.sandbox.issueUploadClientToken(userId, dto.conversationId, dto.pathname);
  }

  @Post('confirm-upload')
  async confirmUpload(@CurrentUser() userId: string, @Body() dto: ConfirmUploadDto) {
    return this.sandbox.confirmUpload(userId, dto.conversationId, dto.pathname);
  }

  @Post('transcribe')
  async transcribe(@CurrentUser() userId: string, @Body() dto: TranscribeDto) {
    return this.sandbox.transcribeUploaded(userId, dto.conversationId, dto.languageCode);
  }

  // ── Песочная очередь медиа-разбора (третья итерация 2026-08-31) ──

  @Post('queue/items')
  async addToQueue(@CurrentUser() userId: string, @Body() dto: AddToQueueDto) {
    return this.sandbox.addToQueue(userId, dto);
  }

  @Post('queue/link')
  async linkQueueItem(@CurrentUser() userId: string, @Body() dto: LinkQueueItemDto) {
    return this.sandbox.linkQueueItem(userId, dto.itemId, dto.conversationId);
  }

  @Get('queue')
  async queue(@CurrentUser() userId: string) {
    return this.sandbox.getSandboxQueue(userId);
  }
}

import { Controller, Get, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request } from 'express';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PhotoVerificationService } from './photo-verification.service';

@Controller('facts/:personFactId/photo-verification')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class PhotoVerificationController {
  constructor(private readonly photoVerification: PhotoVerificationService) {}

  // Потоковая загрузка без буферизации на уровне HTTP-слоя — тот же
  // паттерн, что уже применяется к загрузке аудио в
  // ConversationsController (см. обоснование там же). Буферизация с
  // лимитом происходит внутри PhotoVerificationService, не здесь.
  @Post()
  async verifyPhoto(@CurrentUser() userId: string, @Param('personFactId') personFactId: string, @Req() req: Request) {
    const { Readable } = await import('node:stream');
    const webStream = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    const contentType = req.headers['content-type'] ?? 'application/octet-stream';
    return this.photoVerification.verifyPhoto(userId, personFactId, webStream, contentType);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('personFactId') personFactId: string) {
    return this.photoVerification.list(userId, personFactId);
  }
}

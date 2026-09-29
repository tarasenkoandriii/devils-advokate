import { Body, Controller, Delete, Get, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { VoiceEmbeddingService } from './voice-embedding.service';

class EnrollDto {
  embedding!: number[];
}

class VerifyDto {
  embedding!: number[];
  threshold?: number;
}

// Уровень пользователя, не проекта — голос человека не меняется от
// проекта к проекту (см. обоснование в schema.prisma над моделью).
@Controller('voice-embedding')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class VoiceEmbeddingController {
  constructor(private readonly voiceEmbedding: VoiceEmbeddingService) {}

  @Post('enroll')
  async enroll(@CurrentUser() userId: string, @Body() dto: EnrollDto) {
    return this.voiceEmbedding.enroll(userId, dto.embedding);
  }

  @Get('status')
  async status(@CurrentUser() userId: string) {
    const enrolled = await this.voiceEmbedding.hasEnrollment(userId);
    return { enrolled };
  }

  @Post('verify')
  async verify(@CurrentUser() userId: string, @Body() dto: VerifyDto) {
    // Пункт [voice-attribution] 2026-09-05: наружу уходил один вердикт
    // «это вы / это не вы». Теперь с ним едет и основание — само
    // сходство, применённый порог и прямое указание, что порог не
    // откалиброван на реальных голосах.
    return this.voiceEmbedding.verifyDetailed(userId, dto.embedding, dto?.threshold);
  }

  @Delete()
  async revoke(@CurrentUser() userId: string) {
    await this.voiceEmbedding.revoke(userId);
    return { revoked: true };
  }
}

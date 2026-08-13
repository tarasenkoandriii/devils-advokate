import { Module } from '@nestjs/common';
import { VoiceEmbeddingController } from './voice-embedding.controller';
import { VoiceEmbeddingService } from './voice-embedding.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { ConsentModule } from '../consent/consent.module';

@Module({
  imports: [TelegramAuthModule, ConsentModule],
  controllers: [VoiceEmbeddingController],
  providers: [VoiceEmbeddingService],
  exports: [VoiceEmbeddingService],
})
export class VoiceEmbeddingModule {}

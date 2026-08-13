import { Module } from '@nestjs/common';
import { EvidenceGapController } from './evidence-gap.controller';
import { EvidenceGapService } from './evidence-gap.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [EvidenceGapController],
  providers: [EvidenceGapService],
  exports: [EvidenceGapService],
})
export class EvidenceGapModule {}

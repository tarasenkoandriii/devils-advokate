import { Module } from '@nestjs/common';
import { LegalDisclaimerController } from './legal-disclaimer.controller';
import { LegalDisclaimerService } from './legal-disclaimer.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [LegalDisclaimerController],
  providers: [LegalDisclaimerService],
  exports: [LegalDisclaimerService],
})
export class LegalDisclaimerModule {}

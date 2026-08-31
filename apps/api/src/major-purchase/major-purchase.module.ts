import { Module } from '@nestjs/common';
import { MajorPurchaseController } from './major-purchase.controller';
import { MajorPurchaseService } from './major-purchase.service';
import { MajorPurchaseOnboardingService } from './major-purchase-onboarding.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { SecretsModule } from '../secrets/secrets.module';
import { ConsentModule } from '../consent/consent.module';

@Module({
  imports: [TelegramAuthModule, SecretsModule, ConsentModule],
  controllers: [MajorPurchaseController],
  providers: [MajorPurchaseService, MajorPurchaseOnboardingService],
  exports: [MajorPurchaseService, MajorPurchaseOnboardingService],
})
export class MajorPurchaseModule {}

import { Module } from '@nestjs/common';
import { DtpController } from './dtp.controller';
import { DtpOnboardingService } from './dtp-onboarding.service';
import { DtpService } from './dtp.service';
import { DtpV2Service } from './dtp-v2.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { ConsentModule } from '../consent/consent.module';
import { SecretsModule } from '../secrets/secrets.module';
import { CriteriaComparisonModule } from '../criteria-comparison/criteria-comparison.module';

@Module({
  imports: [TelegramAuthModule, ConsentModule, SecretsModule, CriteriaComparisonModule],
  controllers: [DtpController],
  providers: [DtpOnboardingService, DtpService, DtpV2Service],
  exports: [DtpOnboardingService, DtpService, DtpV2Service],
})
export class DtpModule {}

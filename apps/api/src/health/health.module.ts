import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthOnboardingService } from './health-onboarding.service';
import { HealthService } from './health.service';
import { HealthV2Service } from './health-v2.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { ConsentModule } from '../consent/consent.module';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [TelegramAuthModule, ConsentModule, SecretsModule],
  controllers: [HealthController],
  providers: [HealthOnboardingService, HealthService, HealthV2Service],
  exports: [HealthOnboardingService, HealthService, HealthV2Service],
})
export class HealthModule {}

import { Module } from '@nestjs/common';
import { FamilyLawController } from './family-law.controller';
import { FamilyLawOnboardingService } from './family-law-onboarding.service';
import { FamilyLawService } from './family-law.service';
import { FamilyLawV2Service } from './family-law-v2.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { CriteriaComparisonModule } from '../criteria-comparison/criteria-comparison.module';

@Module({
  imports: [TelegramAuthModule, CriteriaComparisonModule],
  controllers: [FamilyLawController],
  providers: [FamilyLawOnboardingService, FamilyLawService, FamilyLawV2Service],
  exports: [FamilyLawOnboardingService, FamilyLawService, FamilyLawV2Service],
})
export class FamilyLawModule {}

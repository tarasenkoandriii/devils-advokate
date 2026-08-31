import { Module } from '@nestjs/common';
import { InvestmentController } from './investment.controller';
import { InvestmentOnboardingService } from './investment-onboarding.service';
import { InvestmentService } from './investment.service';
import { InvestmentGroupService } from './investment-group.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [InvestmentController],
  providers: [InvestmentOnboardingService, InvestmentService, InvestmentGroupService],
  exports: [InvestmentOnboardingService, InvestmentService, InvestmentGroupService],
})
export class InvestmentModule {}

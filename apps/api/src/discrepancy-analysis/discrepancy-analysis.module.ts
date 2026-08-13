import { Module } from '@nestjs/common';
import { DiscrepancyAnalysisController } from './discrepancy-analysis.controller';
import { DiscrepancyAnalysisService } from './discrepancy-analysis.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [DiscrepancyAnalysisController],
  providers: [DiscrepancyAnalysisService],
  exports: [DiscrepancyAnalysisService],
})
export class DiscrepancyAnalysisModule {}

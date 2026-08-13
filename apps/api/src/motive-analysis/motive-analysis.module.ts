import { Module } from '@nestjs/common';
import { MotiveAnalysisController } from './motive-analysis.controller';
import { MotiveAnalysisService } from './motive-analysis.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [MotiveAnalysisController],
  providers: [MotiveAnalysisService],
  exports: [MotiveAnalysisService],
})
export class MotiveAnalysisModule {}

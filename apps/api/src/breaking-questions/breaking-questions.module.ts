import { Module } from '@nestjs/common';
import { BreakingQuestionsController } from './breaking-questions.controller';
import { BreakingQuestionsService } from './breaking-questions.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [BreakingQuestionsController],
  providers: [BreakingQuestionsService],
  exports: [BreakingQuestionsService],
})
export class BreakingQuestionsModule {}

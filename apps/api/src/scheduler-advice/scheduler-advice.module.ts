import { Module } from '@nestjs/common';
import { SchedulerAdviceController } from './scheduler-advice.controller';
import { SchedulerAdviceService } from './scheduler-advice.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [SchedulerAdviceController],
  providers: [SchedulerAdviceService],
  exports: [SchedulerAdviceService],
})
export class SchedulerAdviceModule {}

import { Module } from '@nestjs/common';
import { LiveArgumentTrackingController } from './live-argument-tracking.controller';
import { LiveArgumentTrackingService } from './live-argument-tracking.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [LiveArgumentTrackingController],
  providers: [LiveArgumentTrackingService],
  exports: [LiveArgumentTrackingService],
})
export class LiveArgumentTrackingModule {}

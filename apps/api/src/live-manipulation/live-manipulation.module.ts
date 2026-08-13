import { Module } from '@nestjs/common';
import { LiveManipulationController } from './live-manipulation.controller';
import { LiveManipulationService } from './live-manipulation.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [LiveManipulationController],
  providers: [LiveManipulationService],
  exports: [LiveManipulationService],
})
export class LiveManipulationModule {}

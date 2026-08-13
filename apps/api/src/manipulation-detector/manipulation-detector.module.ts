import { Module } from '@nestjs/common';
import { ManipulationDetectorController } from './manipulation-detector.controller';
import { ManipulationDetectorService } from './manipulation-detector.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [ManipulationDetectorController],
  providers: [ManipulationDetectorService],
  exports: [ManipulationDetectorService],
})
export class ManipulationDetectorModule {}

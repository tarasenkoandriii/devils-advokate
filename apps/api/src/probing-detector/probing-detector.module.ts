import { Module } from '@nestjs/common';
import { ProbingDetectorController } from './probing-detector.controller';
import { ProbingDetectorService } from './probing-detector.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [ProbingDetectorController],
  providers: [ProbingDetectorService],
  exports: [ProbingDetectorService],
})
export class ProbingDetectorModule {}

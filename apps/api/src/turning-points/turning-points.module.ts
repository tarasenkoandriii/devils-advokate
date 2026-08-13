import { Module } from '@nestjs/common';
import { TurningPointsController } from './turning-points.controller';
import { TurningPointsService } from './turning-points.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [TurningPointsController],
  providers: [TurningPointsService],
  exports: [TurningPointsService],
})
export class TurningPointsModule {}

import { Module } from '@nestjs/common';
import { BestNextMoveController } from './best-next-move.controller';
import { BestNextMoveService } from './best-next-move.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [BestNextMoveController],
  providers: [BestNextMoveService],
  exports: [BestNextMoveService],
})
export class BestNextMoveModule {}

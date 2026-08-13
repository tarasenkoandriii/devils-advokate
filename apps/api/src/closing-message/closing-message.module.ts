import { Module } from '@nestjs/common';
import { ClosingMessageController } from './closing-message.controller';
import { ClosingMessageService } from './closing-message.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [ClosingMessageController],
  providers: [ClosingMessageService],
  exports: [ClosingMessageService],
})
export class ClosingMessageModule {}

import { Module } from '@nestjs/common';
import { LiveHintsController } from './live-hints.controller';
import { LiveHintsService } from './live-hints.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [LiveHintsController],
  providers: [LiveHintsService],
  exports: [LiveHintsService],
})
export class LiveHintsModule {}

import { Module } from '@nestjs/common';
import { SituationalContentController } from './situational-content.controller';
import { SituationalContentService } from './situational-content.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [SituationalContentController],
  providers: [SituationalContentService],
  exports: [SituationalContentService],
})
export class SituationalContentModule {}

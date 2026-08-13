import { Module } from '@nestjs/common';
import { DoNotSayController } from './do-not-say.controller';
import { DoNotSayService } from './do-not-say.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [DoNotSayController],
  providers: [DoNotSayService],
  exports: [DoNotSayService],
})
export class DoNotSayModule {}

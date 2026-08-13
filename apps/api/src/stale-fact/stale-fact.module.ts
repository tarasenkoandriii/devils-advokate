import { Module } from '@nestjs/common';
import { StaleFactController } from './stale-fact.controller';
import { StaleFactService } from './stale-fact.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

// БЕЗ AIRouterModule — детекция не требует AI-вызова, см. обоснование
// в stale-fact.service.ts.
@Module({
  imports: [TelegramAuthModule],
  controllers: [StaleFactController],
  providers: [StaleFactService],
  exports: [StaleFactService],
})
export class StaleFactModule {}

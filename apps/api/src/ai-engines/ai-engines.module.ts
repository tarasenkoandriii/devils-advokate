import { Module } from '@nestjs/common';
import { AIEnginesController } from './ai-engines.controller';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [AIEnginesController],
})
export class AIEnginesModule {}

import { Module } from '@nestjs/common';
import { SourceConflictController } from './source-conflict.controller';
import { SourceConflictService } from './source-conflict.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule],
  controllers: [SourceConflictController],
  providers: [SourceConflictService],
  exports: [SourceConflictService],
})
export class SourceConflictModule {}

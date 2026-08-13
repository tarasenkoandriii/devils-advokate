import { Module } from '@nestjs/common';
import { OpenLoopsController } from './open-loops.controller';
import { OpenLoopsService } from './open-loops.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { SourceConflictModule } from '../source-conflict/source-conflict.module';

// БЕЗ AIRouterModule — чистая агрегация, см. обоснование в
// open-loops.service.ts.
@Module({
  imports: [TelegramAuthModule, SourceConflictModule],
  controllers: [OpenLoopsController],
  providers: [OpenLoopsService],
  exports: [OpenLoopsService],
})
export class OpenLoopsModule {}

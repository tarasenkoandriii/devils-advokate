import { Module } from '@nestjs/common';
import { ProtectedNoteController } from './protected-note.controller';
import { ProtectedNoteService } from './protected-note.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

// БЕЗ AIRouterModule — ручной пользовательский ввод, не AI-генерация,
// см. обоснование в protected-note.service.ts.
@Module({
  imports: [TelegramAuthModule],
  controllers: [ProtectedNoteController],
  providers: [ProtectedNoteService],
  exports: [ProtectedNoteService],
})
export class ProtectedNoteModule {}

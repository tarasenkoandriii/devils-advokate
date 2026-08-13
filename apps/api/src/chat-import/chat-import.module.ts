import { Module } from '@nestjs/common';
import { ChatImportController } from './chat-import.controller';
import { ChatImportService } from './chat-import.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { ConsentModule } from '../consent/consent.module';

@Module({
  imports: [TelegramAuthModule, ConsentModule],
  controllers: [ChatImportController],
  providers: [ChatImportService],
  exports: [ChatImportService],
})
export class ChatImportModule {}

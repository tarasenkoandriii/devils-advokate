import { Module } from '@nestjs/common';
import { CompromiseSheetController } from './compromise-sheet.controller';
import { CompromiseSheetService } from './compromise-sheet.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';
import { TextToSpeechModule } from '../text-to-speech/text-to-speech.module';

@Module({
  imports: [TelegramAuthModule, AIRouterModule, TextToSpeechModule],
  controllers: [CompromiseSheetController],
  providers: [CompromiseSheetService],
  exports: [CompromiseSheetService],
})
export class CompromiseSheetModule {}

import { Module } from '@nestjs/common';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { TermsSheetModule } from '../terms-sheet/terms-sheet.module';
import { ClientBriefController } from './client-brief.controller';
import { ClientBriefService } from './client-brief.service';

@Module({
  imports: [TelegramAuthModule, TermsSheetModule],
  controllers: [ClientBriefController],
  providers: [ClientBriefService],
  exports: [ClientBriefService],
})
export class ClientBriefModule {}

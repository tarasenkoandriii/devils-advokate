import { Module } from '@nestjs/common';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { TermsSheetModule } from '../terms-sheet/terms-sheet.module';
import { VacancyPostingController, PostingReviewPublicController } from './vacancy-posting.controller';
import { VacancyPostingService } from './vacancy-posting.service';

@Module({
  imports: [TelegramAuthModule, TermsSheetModule],
  controllers: [VacancyPostingController, PostingReviewPublicController],
  providers: [VacancyPostingService],
  exports: [VacancyPostingService],
})
export class VacancyPostingModule {}

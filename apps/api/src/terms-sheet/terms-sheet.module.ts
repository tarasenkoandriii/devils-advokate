// Пункт [job-domain-v2] — общий слой найма: лист условий, движок сверки,
// CV-вариант, диалог по пунктам. Роль-независимый; роль различается
// доступом по ProjectMode (terms-access.ts).
import { Module } from '@nestjs/common';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { TermsSheetController, CvVariantController } from './terms-sheet.controller';
import { TermsSheetService } from './terms-sheet.service';
import { TermsMatchingService } from './terms-matching.service';
import { CvVariantService } from './cv-variant.service';
import { CvDialogueService } from './cv-dialogue.service';

@Module({
  imports: [TelegramAuthModule, AuditLogModule],
  controllers: [TermsSheetController, CvVariantController],
  providers: [TermsSheetService, TermsMatchingService, CvVariantService, CvDialogueService],
  exports: [TermsSheetService, TermsMatchingService, CvVariantService, CvDialogueService],
})
export class TermsSheetModule {}

// Пункт [job-domain-v2] — остальные функции этапа 2 парами (К/А/Р), стоящие на
// ядре листа условий (TermsSheetModule).
import { Module } from '@nestjs/common';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { TermsSheetModule } from '../terms-sheet/terms-sheet.module';
import { HiringExtrasSheetController, PreQuestionnaireController, PreQuestionnairePublicController } from './hiring-extras.controller';
import { HiringExtrasService } from './hiring-extras.service';

@Module({
  imports: [TelegramAuthModule, AuditLogModule, TermsSheetModule],
  controllers: [HiringExtrasSheetController, PreQuestionnaireController, PreQuestionnairePublicController],
  providers: [HiringExtrasService],
  exports: [HiringExtrasService],
})
export class HiringExtrasModule {}

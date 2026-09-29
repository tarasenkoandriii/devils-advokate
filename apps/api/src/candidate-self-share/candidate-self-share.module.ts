import { Module } from '@nestjs/common';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { TermsSheetModule } from '../terms-sheet/terms-sheet.module';
import { CandidateSelfShareController, CandidateSelfSharePublicController } from './candidate-self-share.controller';
import { CandidateSelfShareService } from './candidate-self-share.service';

@Module({
  imports: [TelegramAuthModule, AuditLogModule, TermsSheetModule],
  controllers: [CandidateSelfShareController, CandidateSelfSharePublicController],
  providers: [CandidateSelfShareService],
  exports: [CandidateSelfShareService],
})
export class CandidateSelfShareModule {}

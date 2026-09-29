import { Module } from '@nestjs/common';
import { InterviewPoolController, InterviewPoolShareController, ClientReportController } from './interview-pool.controller';
import { InterviewPoolOnboardingService } from './interview-pool-onboarding.service';
import { InterviewPoolService } from './interview-pool.service';
import { InterviewPoolTeamService } from './interview-pool-team.service';
import { InterviewPoolCandidateService } from './interview-pool-candidate.service';
import { InterviewPoolRelevanceService } from './interview-pool-relevance.service';
import { InterviewPoolReportService } from './interview-pool-report.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { TermsSheetModule } from '../terms-sheet/terms-sheet.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
// Приёмка 38: чеклист отправки живёт в досье компании (А-27) — импорт
// односторонний, EmployerDossierModule тянет только TelegramAuth+AuditLog.
import { EmployerDossierModule } from '../employer-dossier/employer-dossier.module';

@Module({
  imports: [TelegramAuthModule, TermsSheetModule, AuditLogModule, EmployerDossierModule], // [job-domain-v2]: зеркало релевантности в INTERVIEW-лист
  controllers: [InterviewPoolController, InterviewPoolShareController, ClientReportController],
  providers: [
    InterviewPoolOnboardingService,
    InterviewPoolService,
    InterviewPoolTeamService,
    InterviewPoolCandidateService,
    InterviewPoolRelevanceService,
    InterviewPoolReportService,
  ],
  exports: [
    InterviewPoolOnboardingService,
    InterviewPoolService,
    InterviewPoolTeamService,
    InterviewPoolCandidateService,
    InterviewPoolRelevanceService,
    InterviewPoolReportService,
  ],
})
export class InterviewPoolModule {}

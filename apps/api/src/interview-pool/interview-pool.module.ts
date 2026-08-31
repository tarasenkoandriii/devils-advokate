import { Module } from '@nestjs/common';
import { InterviewPoolController, InterviewPoolShareController, ClientReportController } from './interview-pool.controller';
import { InterviewPoolOnboardingService } from './interview-pool-onboarding.service';
import { InterviewPoolService } from './interview-pool.service';
import { InterviewPoolTeamService } from './interview-pool-team.service';
import { InterviewPoolCandidateService } from './interview-pool-candidate.service';
import { InterviewPoolRelevanceService } from './interview-pool-relevance.service';
import { InterviewPoolReportService } from './interview-pool-report.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
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

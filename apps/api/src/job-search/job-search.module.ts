import { Module } from '@nestjs/common';
import { JobSearchController } from './job-search.controller';
import { JobSearchOnboardingService } from './job-search-onboarding.service';
import { JobSearchService } from './job-search.service';
import { CvImportService } from './cv-import.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { TermsSheetModule } from '../terms-sheet/terms-sheet.module';

@Module({
  imports: [TelegramAuthModule, TermsSheetModule], // [job-domain-v2]: зеркало сверки в лист VACANCY_RESPONSE
  controllers: [JobSearchController],
  providers: [JobSearchOnboardingService, JobSearchService, CvImportService],
  exports: [JobSearchOnboardingService, JobSearchService, CvImportService],
})
export class JobSearchModule {}

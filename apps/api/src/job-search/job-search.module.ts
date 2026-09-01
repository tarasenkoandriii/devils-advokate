import { Module } from '@nestjs/common';
import { JobSearchController } from './job-search.controller';
import { JobSearchOnboardingService } from './job-search-onboarding.service';
import { JobSearchService } from './job-search.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [JobSearchController],
  providers: [JobSearchOnboardingService, JobSearchService],
  exports: [JobSearchOnboardingService, JobSearchService],
})
export class JobSearchModule {}

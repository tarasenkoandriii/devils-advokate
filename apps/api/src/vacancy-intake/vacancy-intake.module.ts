import { Module } from '@nestjs/common';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { SecretsModule } from '../secrets/secrets.module';
import { TermsSheetModule } from '../terms-sheet/terms-sheet.module';
import { VacancyIntakeController, JobSearchInternalController } from './vacancy-intake.controller';
import { VacancyIntakeService } from './vacancy-intake.service';
import { JobSearchToolsService } from './job-search-tools.service';

@Module({
  imports: [TelegramAuthModule, SecretsModule, TermsSheetModule],
  controllers: [VacancyIntakeController, JobSearchInternalController],
  providers: [VacancyIntakeService, JobSearchToolsService],
  exports: [VacancyIntakeService, JobSearchToolsService],
})
export class VacancyIntakeModule {}

import { Module } from '@nestjs/common';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { SecretsModule } from '../secrets/secrets.module';
import { AIRouterModule } from '../ai-router/ai-router.module';
import { ProjectsModule } from '../projects/projects.module';
import { DtpModule } from '../dtp/dtp.module';
import { FamilyLawModule } from '../family-law/family-law.module';
import { HealthModule } from '../health/health.module';
import { InterviewPoolModule } from '../interview-pool/interview-pool.module';
import { InvestmentModule } from '../investment/investment.module';
import { MajorPurchaseModule } from '../major-purchase/major-purchase.module';
import { IntakeService } from './intake.service';
import { IntakeController } from './intake.controller';

// ТЗ domain-ui-and-voice-intake §2 — квиз зависит от ВСЕХ шести доменных
// онбордингов (replay ответов), поэтому импортирует их модули, а не
// наоборот: домены о квизе не знают.
@Module({
  imports: [TelegramAuthModule, SecretsModule, AIRouterModule, ProjectsModule, DtpModule, FamilyLawModule, HealthModule, InterviewPoolModule, InvestmentModule, MajorPurchaseModule],
  providers: [IntakeService],
  controllers: [IntakeController],
  exports: [IntakeService],
})
export class IntakeModule {}

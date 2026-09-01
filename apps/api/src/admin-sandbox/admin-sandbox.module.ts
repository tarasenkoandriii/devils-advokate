import { Module } from '@nestjs/common';
import { AdminSandboxController } from './admin-sandbox.controller';
import { AdminSandboxService } from './admin-sandbox.service';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { ConsentModule } from '../consent/consent.module';
import { SecretsModule } from '../secrets/secrets.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { MediaReviewModule } from '../media-review/media-review.module';
import { ManipulationDetectorModule } from '../manipulation-detector/manipulation-detector.module';
import { DiscrepancyAnalysisModule } from '../discrepancy-analysis/discrepancy-analysis.module';
import { TurningPointsModule } from '../turning-points/turning-points.module';
import { AIRouterModule } from '../ai-router/ai-router.module';
import { IntakeModule } from '../intake/intake.module';
import { HealthModule } from '../health/health.module';
import { LiveSessionModule } from '../live-session/live-session.module';
import { MajorPurchaseModule } from '../major-purchase/major-purchase.module';
import { InvestmentModule } from '../investment/investment.module';
import { InterviewPoolModule } from '../interview-pool/interview-pool.module';
import { FamilyLawModule } from '../family-law/family-law.module';
import { DtpModule } from '../dtp/dtp.module';
import { JobSearchModule } from '../job-search/job-search.module';

// Пункт [admin-sandbox] 2026-08-31: модуль НЕ содержит собственной
// бизнес-логики цепочки — только переиспользует сервисы, которые уже
// экспортируют свои модули. Это принципиально: песочница, у которой
// «своя копия» загрузки или анализа, проверяла бы саму себя, а не
// продовый путь.
@Module({
  imports: [
    AdminAuthModule,
    ConsentModule,
    SecretsModule,
    ConversationsModule,
    MediaReviewModule,
    ManipulationDetectorModule,
    DiscrepancyAnalysisModule,
    TurningPointsModule,
    AIRouterModule,
    IntakeModule,
    HealthModule,
    LiveSessionModule,
    MajorPurchaseModule, // Пункт [sandbox-major-purchase] 2026-09-01 — этап 1 доменного покрытия
    InvestmentModule, // Пункт [sandbox-investment] 2026-09-01 — этап 2 доменного покрытия
    InterviewPoolModule, // Пункт [sandbox-interview-pool] 2026-09-01 — этап 3 доменного покрытия
    FamilyLawModule, // Пункт [sandbox-family-law] 2026-09-01 — этап 4 доменного покрытия
    DtpModule, // Пункт [sandbox-dtp] 2026-09-01 — этап 5 доменного покрытия
    JobSearchModule, // Пункт [job-search] 2026-09-01 — седьмой домен
  ],
  controllers: [AdminSandboxController],
  providers: [AdminSandboxService],
})
export class AdminSandboxModule {}

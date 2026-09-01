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
  ],
  controllers: [AdminSandboxController],
  providers: [AdminSandboxService],
})
export class AdminSandboxModule {}

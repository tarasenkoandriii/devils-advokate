import { Module } from '@nestjs/common';
import { EvaluationController } from './evaluation.controller';
import { EvaluationService } from './evaluation.service';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [AdminAuthModule, AIRouterModule],
  controllers: [EvaluationController],
  providers: [EvaluationService],
  exports: [EvaluationService],
})
export class EvaluationModule {}

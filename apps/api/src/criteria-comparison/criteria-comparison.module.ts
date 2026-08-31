import { Module } from '@nestjs/common';
import { CriteriaComparisonService } from './criteria-comparison.service';
import { AIRouterModule } from '../ai-router/ai-router.module';

@Module({
  imports: [AIRouterModule],
  providers: [CriteriaComparisonService],
  exports: [CriteriaComparisonService],
})
export class CriteriaComparisonModule {}

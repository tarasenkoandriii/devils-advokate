import { Global, Module } from '@nestjs/common';
import { AIRouterService } from './ai-router.service';
import { ConsentModule } from '../consent/consent.module';
import { ContentScanModule } from '../content-scan/content-scan.module';

@Global()
@Module({
  imports: [ConsentModule, ContentScanModule],
  providers: [AIRouterService],
  exports: [AIRouterService],
})
export class AIRouterModule {}

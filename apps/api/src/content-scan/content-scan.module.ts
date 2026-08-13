import { Global, Module } from '@nestjs/common';
import { ContentScanService } from './content-scan.service';

@Global()
@Module({
  providers: [ContentScanService],
  exports: [ContentScanService],
})
export class ContentScanModule {}

import { Module } from '@nestjs/common';
import { SafeShareController } from './safe-share.controller';
import { SafeShareService } from './safe-share.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { ContentScanModule } from '../content-scan/content-scan.module';

@Module({
  imports: [TelegramAuthModule, ContentScanModule],
  controllers: [SafeShareController],
  providers: [SafeShareService],
})
export class SafeShareModule {}

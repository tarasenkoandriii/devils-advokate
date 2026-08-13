import { Module } from '@nestjs/common';
import { PrivacyCenterController } from './privacy-center.controller';
import { PrivacyCenterService } from './privacy-center.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [PrivacyCenterController],
  providers: [PrivacyCenterService],
})
export class PrivacyCenterModule {}

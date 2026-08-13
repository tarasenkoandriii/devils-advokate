import { Module } from '@nestjs/common';
import { LaunchDisclaimerController } from './launch-disclaimer.controller';
import { LaunchDisclaimerService } from './launch-disclaimer.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [LaunchDisclaimerController],
  providers: [LaunchDisclaimerService],
  exports: [LaunchDisclaimerService],
})
export class LaunchDisclaimerModule {}

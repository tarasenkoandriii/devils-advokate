import { Module } from '@nestjs/common';
import { ReligiousReminderController } from './religious-reminder.controller';
import { ReligiousReminderService } from './religious-reminder.service';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';

@Module({
  imports: [TelegramAuthModule],
  controllers: [ReligiousReminderController],
  providers: [ReligiousReminderService],
  exports: [ReligiousReminderService],
})
export class ReligiousReminderModule {}

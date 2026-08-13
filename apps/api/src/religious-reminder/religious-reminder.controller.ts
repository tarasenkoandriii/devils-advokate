import { Body, Controller, Get, Patch, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ReligiousReminderService } from './religious-reminder.service';
import { ReligiousReminderFrequency } from '@prisma/client';

class UpdateFrequencyDto {
  frequency!: ReligiousReminderFrequency;
}

@Controller()
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ReligiousReminderController {
  constructor(private readonly religiousReminder: ReligiousReminderService) {}

  @Get('religious-reminder')
  async getIfDue(@CurrentUser() userId: string) {
    return this.religiousReminder.getReminderIfDue(userId);
  }

  @Patch('religious-reminder/frequency')
  async updateFrequency(@CurrentUser() userId: string, @Body() dto: UpdateFrequencyDto) {
    return this.religiousReminder.updateFrequency(userId, dto.frequency);
  }
}

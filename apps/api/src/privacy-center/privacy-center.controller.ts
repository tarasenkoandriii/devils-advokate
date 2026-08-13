import { Controller, Delete, Get, Param, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PrivacyCenterService } from './privacy-center.service';

@Controller('privacy')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class PrivacyCenterController {
  constructor(private readonly privacyCenter: PrivacyCenterService) {}

  @Get('overview')
  async getOverview(@CurrentUser() userId: string) {
    return this.privacyCenter.getOverview(userId);
  }

  @Delete('person/:id')
  async deletePerson(@CurrentUser() userId: string, @Param('id') id: string) {
    await this.privacyCenter.deletePerson(userId, id);
    return { deleted: true };
  }

  @Get('export')
  async exportData(@CurrentUser() userId: string) {
    return this.privacyCenter.exportData(userId);
  }
}

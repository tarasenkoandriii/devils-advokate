import { Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { CommunicationProfileService } from './communication-profile.service';

@Controller('people/:personId/communication-profile')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class CommunicationProfileController {
  constructor(private readonly communicationProfile: CommunicationProfileService) {}

  @Post('refresh')
  async refresh(@CurrentUser() userId: string, @Param('personId') personId: string) {
    return this.communicationProfile.refresh(userId, personId);
  }

  @Get()
  async get(@CurrentUser() userId: string, @Param('personId') personId: string) {
    return this.communicationProfile.get(userId, personId);
  }
}

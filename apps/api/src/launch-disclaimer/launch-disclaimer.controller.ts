import { Controller, Get, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { LaunchDisclaimerService } from './launch-disclaimer.service';

@Controller('disclaimer')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class LaunchDisclaimerController {
  constructor(private readonly disclaimer: LaunchDisclaimerService) {}

  @Get('status')
  async getStatus(@CurrentUser() userId: string) {
    return this.disclaimer.getStatus(userId);
  }

  @Post('acknowledge')
  async acknowledge(@CurrentUser() userId: string) {
    return this.disclaimer.acknowledge(userId);
  }
}

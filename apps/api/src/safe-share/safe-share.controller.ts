import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { SafeShareService, PreflightInput } from './safe-share.service';

@Controller('safe-share')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class SafeShareController {
  constructor(private readonly safeShare: SafeShareService) {}

  @Post('preflight')
  async preflight(@CurrentUser() userId: string, @Body() dto: PreflightInput) {
    return this.safeShare.preflight(userId, dto);
  }

  @Post('confirm/:id')
  async confirm(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.safeShare.confirm(userId, id);
  }

  @Get('log')
  async log(@CurrentUser() userId: string) {
    return this.safeShare.listLog(userId);
  }
}

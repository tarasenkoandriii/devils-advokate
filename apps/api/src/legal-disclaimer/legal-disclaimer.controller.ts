import { Controller, Get, Query, UseGuards, UseInterceptors, BadRequestException } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ProjectMode } from '@prisma/client';
import { LegalDisclaimerService } from './legal-disclaimer.service';

@Controller('legal-disclaimer')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class LegalDisclaimerController {
  constructor(private readonly legalDisclaimer: LegalDisclaimerService) {}

  @Get()
  async get(@CurrentUser() userId: string, @Query('mode') mode: string) {
    if (!Object.values(ProjectMode).includes(mode as ProjectMode)) {
      throw new BadRequestException(`Unknown mode: ${mode}`);
    }
    return this.legalDisclaimer.getDisclaimer(userId, mode as ProjectMode);
  }
}

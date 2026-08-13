import { Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { MissingInformationService } from './missing-information.service';

@Controller('projects/:projectId/missing-information')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class MissingInformationController {
  constructor(private readonly missingInformation: MissingInformationService) {}

  @Post('detect')
  async detect(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.missingInformation.detect(userId, projectId);
  }

  @Get()
  async getLatest(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.missingInformation.getLatest(userId, projectId);
  }
}

import { Controller, Get, Param, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ProjectLogService } from './project-log.service';

@Controller('projects/:projectId/log')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ProjectLogController {
  constructor(private readonly projectLog: ProjectLogService) {}

  @Get()
  async get(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.projectLog.getLog(userId, projectId);
  }
}

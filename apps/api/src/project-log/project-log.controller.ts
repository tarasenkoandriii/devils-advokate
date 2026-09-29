import { Body, Controller, Get, Param, Patch, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ProjectLogService } from './project-log.service';

class SetFlagDisputedDto {
  // true — снять флаг, false — вернуть. Одно поле, не два маршрута:
  // «вернуть» так же нужно, как «снять» (человек может передумать).
  disputed!: boolean;
}

@Controller('projects/:projectId/log')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ProjectLogController {
  constructor(private readonly projectLog: ProjectLogService) {}

  @Get()
  async get(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.projectLog.getLog(userId, projectId);
  }

  // Пункт [project-log-v2] (§3.39 ТЗ, «появление/снятие флагов») —
  // отдельное ручное действие, не побочный эффект чтения лога.
  @Patch('flags/:signalId')
  async setFlagDisputed(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Param('signalId') signalId: string,
    @Body() dto: SetFlagDisputedDto,
  ) {
    return this.projectLog.setFlagDisputed(userId, projectId, signalId, dto.disputed === true);
  }
}

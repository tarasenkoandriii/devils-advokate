import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { SchedulerAdviceService } from './scheduler-advice.service';

class GenerateSchedulerAdviceDto {
  engineId?: string;
}

@Controller('projects/:projectId/scheduler-advice')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class SchedulerAdviceController {
  constructor(private readonly schedulerAdvice: SchedulerAdviceService) {}

  @Post()
  async generate(
    @CurrentUser() userId: string,
    @Param('projectId') projectId: string,
    @Body() dto: GenerateSchedulerAdviceDto,
  ) {
    return this.schedulerAdvice.generate(userId, projectId, dto?.engineId);
  }

  @Get()
  async list(@CurrentUser() userId: string, @Param('projectId') projectId: string) {
    return this.schedulerAdvice.list(userId, projectId);
  }
}

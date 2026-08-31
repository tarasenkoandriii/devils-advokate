// Пункт [telemetry]: контролер поверх TelemetryService,
// devils-advocate-telemetry-tz.md §4. Admin-facing, тот же паттерн,
// что /admin/* в devils-advocate-prompt-framework-tz.md — не для
// конечного пользователя продукта.

import { Controller, Get, Param, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { TelemetryService } from './telemetry.service';

@Controller('admin/telemetry')
@UseGuards(AdminSessionGuard)
@UseInterceptors(ApiResponseInterceptor)
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService) {}

  @Get('summary')
  async getSummary(@CurrentUser() userId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.telemetry.getSummary(userId, from, to);
  }

  @Get('by-model')
  async getByModel(@CurrentUser() userId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.telemetry.getByModel(userId, from, to);
  }

  @Get('tasks/:taskType')
  async getTaskDetail(
    @CurrentUser() userId: string,
    @Param('taskType') taskType: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    return this.telemetry.getTaskDetail(userId, taskType, parsedLimit, status);
  }
}

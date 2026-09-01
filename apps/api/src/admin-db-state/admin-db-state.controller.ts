// Пункт [db-state] 2026-09-01 — тонкий контроллер вкладки «БД».
// Авторизация — та же связка, что у остальной админки: AdminSessionGuard
// (httpOnly-cookie) + проверка isOperator в сервисе.

import { Controller, Get, UseGuards, UseInterceptors } from '@nestjs/common';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { AdminDbStateService } from './admin-db-state.service';

@Controller('admin/db-state')
@UseGuards(AdminSessionGuard)
@UseInterceptors(ApiResponseInterceptor)
export class AdminDbStateController {
  constructor(private readonly service: AdminDbStateService) {}

  @Get()
  state(@CurrentUser() userId: string) {
    return this.service.getState(userId);
  }
}

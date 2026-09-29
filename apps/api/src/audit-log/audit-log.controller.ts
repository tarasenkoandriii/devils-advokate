import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { AuditLogService } from './audit-log.service';
import { OPERATOR_TRACES, OPERATOR_TRACE_ALWAYS } from './operator-trace';

@Controller('admin/audit-log')
@UseGuards(AdminSessionGuard)
@UseInterceptors(ApiResponseInterceptor)
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  /** Пункт [operator-left-a-trace-unsaid] 2026-09-25 — что оставляет
   * после себя каждое решение оператора.
   *
   * Считается из тех же реестров, что питают экран человека, поэтому
   * разойтись с ним не может. Пять экранов админки держали бы пять
   * копий этого текста — именно так родился дефект пункта
   * [screen-said-what-server-unsaid]. */
  @Get('operator-traces')
  operatorTraces() {
    return { traces: OPERATOR_TRACES.map((t) => ({ ...t })), always: OPERATOR_TRACE_ALWAYS };
  }

  @Get()
  async list(
    @CurrentUser() userId: string,
    @Query('resource') resource?: string,
    @Query('resourceId') resourceId?: string,
    @Query('actorId') actorId?: string,
  ) {
    return this.auditLog.list(userId, { resource, resourceId, actorId });
  }
}

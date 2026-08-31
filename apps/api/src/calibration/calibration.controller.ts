// Пункт [prompt-framework]: контролер поверх CalibrationService,
// devils-advocate-prompt-framework-tz.md §5.3. Только GET — пересчёт
// не запускается по HTTP от пользователя, см. обоснование в самом
// сервисе.

import { Controller, Get, Headers, Post, Req, UnauthorizedException, UseGuards, UseInterceptors } from '@nestjs/common';
import { AdminSessionGuard, AdminAuthenticatedRequest } from '../admin-auth/admin-session.guard';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { CalibrationService } from './calibration.service';
import { SecretsService } from '../secrets/secrets.service';
import { safeSecretEqual } from '../common/timing-safe-equal';

const DISPATCH_SECRET_REF = 'SCHEDULER_DISPATCH_SECRET'; // переиспользован тот же секрет, что у SchedulerDispatchController — тот же класс server-to-server вызова, заводить отдельный секрет ради одного нового плановую задания было бы избыточно

@Controller('admin/calibration')
@UseGuards(AdminSessionGuard)
@UseInterceptors(ApiResponseInterceptor)
export class CalibrationController {
  constructor(private readonly calibration: CalibrationService) {}

  @Get('scenario-predictions')
  async getStatus(@Req() req: AdminAuthenticatedRequest) {
    // ПОВТОРНЫЙ АУДИТ 2026-08-30: единственный эндпоинт под
    // AdminSessionGuard, не проверявший роль. Вход в админку по ТЗ
    // §5.1 не требует никаких прав вообще — их проверяют сервисы,
    // — поэтому «под guard'ом» здесь означало «доступно любому
    // пользователю Telegram», а не «доступно оператору».
    return this.calibration.getStatusForOperator(req.userId);
  }
}

// Пункт [prompt-framework]: тот же паттерн, что SchedulerDispatchController
// (scheduler.controller.ts) — вызывающая сторона pg_net из Supabase,
// не пользователь Telegram, БЕЗ TelegramAuthGuard, аутентификация —
// сверка заголовка с секретом. Честная граница, та же, что у Пункта 50:
// сама настройка pg_cron-джобы в реальном Supabase — вне этой среды
// разработки (нет сети, нет доступа к живому инстансу), только
// endpoint + инструкция (см. prisma/manual-migrations/).
@Controller('internal/calibration')
export class CalibrationDispatchController {
  constructor(
    private readonly calibration: CalibrationService,
    private readonly secrets: SecretsService,
  ) {}

  @Post('recompute')
  async recompute(@Headers('x-dispatch-secret') providedSecret: string) {
    const expectedSecret = await this.secrets.resolve(DISPATCH_SECRET_REF);
    if (!safeSecretEqual(providedSecret, expectedSecret)) {
      throw new UnauthorizedException('Invalid dispatch secret');
    }
    return this.calibration.recomputeCalibration();
  }
}

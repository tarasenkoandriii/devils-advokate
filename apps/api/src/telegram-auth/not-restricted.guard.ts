// Пункт [admin-panel] (devils-advocate-admin-panel-tz.md §4.3/§6):
// закриває раніше свідомо відкладене рішення — "список конкретних
// эндпоинтов, подлежащих этой проверке, — задача следующего прохода
// реализации". Цей guard — той самий механізм, що AdminSessionGuard:
// окремий, другий шар guard'ів на конкретному методі (не на класі
// контролера цілком, бо звичайні read-ендпоінти й далі мають
// працювати для обмежених користувачів — §4.3 явно каже "НЕ блокирует
// запрос полностью").
//
// Застосовується ПІСЛЯ TelegramAuthGuard (той кладе request.userRestricted
// першим) — порядок у @UseGuards(TelegramAuthGuard, NotRestrictedGuard)
// важливий, NestJS виконує guard'и по черзі зліва направо.

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthenticatedRequest } from './telegram-auth.guard';

@Injectable()
export class NotRestrictedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.userRestricted) {
      throw new ForbiddenException(
        'Ваш акаунт тимчасово обмежений модерацією. Зверніться до підтримки, якщо вважаєте це помилкою.',
      );
    }
    return true;
  }
}

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
import { restrictedNotice } from './moderation-notice';

// Пункт [decision-basis] 2026-09-04 — две правки в одном сообщении.
//  1. Оно было НА УКРАИНСКОМ, тогда как весь остальной интерфейс —
//     русский. Человек встречал чужой язык ровно в тот момент, когда ему
//     и так непонятно, что произошло.
//  2. Оно отправляло «до підтримки» — поддержки в продукте нет вовсе, ни
//     адреса, ни обработчика в боте. Названный и несуществующий способ
//     хуже, чем неназванный: человек ищет и не находит.
// Теперь человеку сказано, ЧТО именно закрыто, что чтение и выгрузка
// работают, и НА ЧЁМ решение основано — причину оператор с этой сверки
// обязан записать.
@Injectable()
export class NotRestrictedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.userRestricted) {
      throw new ForbiddenException(restrictedNotice({ restrictedNote: request.userRestrictedNote, restrictedAt: request.userRestrictedAt }));
    }
    return true;
  }
}

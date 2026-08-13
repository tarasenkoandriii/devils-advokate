// Чекпоинт 1, пункт 11: TMA bootstrap/auth — @CurrentUser() декоратор
//
// Достаёт userId (internal User.id), положенный TelegramAuthGuard в
// request. Используется во всех защищённых контроллерах вместо
// прямого чтения request.userId — единая точка, если формат хранения
// пользователя в request когда-нибудь изменится.

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest } from './telegram-auth.guard';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.userId;
  },
);

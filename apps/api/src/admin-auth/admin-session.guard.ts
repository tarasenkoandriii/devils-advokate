// Пункт [admin-panel] (devils-advocate-admin-panel-tz.md §4.1):
// AdminSessionGuard — НОВЫЙ, параллельный TelegramAuthGuard, НЕ
// расширяет его: разный источник токена (httpOnly cookie vs заголовок
// X-Telegram-Init-Data), разная модель сессии (held session с TTL на
// сервере vs stateless-проверка подписи на каждый запрос). Кладёт
// request.userId тем же именем, что и TelegramAuthGuard — сервисы,
// принимающие userId как параметр (assertModerator/assertOperator и
// т.п.), не меняются вообще при смене guard'а (acceptance-тест §5.4).

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { parseCookieHeader, ADMIN_SESSION_COOKIE_NAME } from './cookie.util';

export interface AdminAuthenticatedRequest extends Request {
  userId: string;
}

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminAuthenticatedRequest>();

    const cookies = parseCookieHeader(request.headers.cookie);
    const token = cookies[ADMIN_SESSION_COOKIE_NAME];
    if (!token) {
      throw new UnauthorizedException('Admin session cookie is required');
    }

    // include user: ПОВТОРНЫЙ АУДИТ 2026-08-30 — guard проверял только
    // существование токена и срок. Заблокированный оператор сохранял
    // доступ к админке до истечения семидневной сессии, потому что
    // isBlocked проверялся лишь на входе. Один include вместо второго
    // запроса — цена нулевая, а проверка становится fail closed на
    // каждый запрос, а не только в момент логина.
    const session = await this.prisma.adminSession.findUnique({
      where: { token },
      include: { user: { select: { isBlocked: true } } },
    });
    if (!session) {
      throw new UnauthorizedException('Invalid admin session');
    }
    if (session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Admin session expired');
    }
    if (session.user?.isBlocked) {
      throw new UnauthorizedException('Account is blocked');
    }

    request.userId = session.userId;
    return true;
  }
}

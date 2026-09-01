// Пункт [admin-panel] (devils-advocate-admin-panel-tz.md §4.1):
// AdminSessionGuard — НОВЫЙ, параллельный TelegramAuthGuard, НЕ
// расширяет его: разный источник токена (httpOnly cookie vs заголовок
// X-Telegram-Init-Data), разная модель сессии (held session с TTL на
// сервере vs stateless-проверка подписи на каждый запрос). Кладёт
// request.userId тем же именем, что и TelegramAuthGuard — сервисы,
// принимающие userId как параметр (assertModerator/assertOperator и
// т.п.), не меняются вообще при смене guard'а (acceptance-тест §5.4).

import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { parseCookieHeader, ADMIN_SESSION_COOKIE_NAME } from './cookie.util';

// Пункт [project-audit] 2026-09-01 — CSRF-защита cookie-сессии.
// Контекст (из отчёта аудита, раздел «Требует решения владельца»):
// cookie ставится с SameSite=None (админка и API — разные домены), и
// браузер отправлял cross-site form-POST с cookie без preflight; CORS
// лишь запрещал читать ответ, а POST /admin/prompts/.../rollback
// срабатывал. Решение — проверка Origin для всех не-safe методов:
// браузер выставляет Origin на каждый cross-site (и почти каждый
// same-site) не-GET запрос, и подделать его из страницы нельзя.
// Fail-политика:
//   - Origin есть и он в allowlist (CORS_ORIGIN) → пропустить;
//   - Origin есть и его нет в allowlist → 403 (это и есть CSRF);
//   - Origin отсутствует → пропустить: это не-браузерный клиент
//     (curl/скрипт), которому cookie неоткуда взять «чужой» — CSRF
//     атакует именно браузерную автоотправку, а она Origin несёт;
//   - CORS_ORIGIN не задан → проверка выключена (dev; в проде
//     переменная и так обязательна — см. API-AND-KEYS.md).

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isOriginAllowed(method: string, originHeader: string | undefined, corsOriginEnv: string | undefined): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  if (!corsOriginEnv?.trim()) return true;
  if (!originHeader) return true;
  const allowed = corsOriginEnv.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  return allowed.includes(originHeader.replace(/\/+$/, ''));
}

export interface AdminAuthenticatedRequest extends Request {
  userId: string;
}

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminAuthenticatedRequest>();

    if (!isOriginAllowed(request.method ?? 'GET', request.headers.origin as string | undefined, process.env.CORS_ORIGIN)) {
      throw new ForbiddenException('Cross-origin request rejected (CSRF protection)');
    }

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

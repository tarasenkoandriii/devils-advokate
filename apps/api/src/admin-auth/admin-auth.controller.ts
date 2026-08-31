// Пункт [admin-panel]: контролер поверх AdminAuthService,
// devils-advocate-admin-panel-tz.md §4.1.

import { Body, Controller, Get, Post, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import { Request, Response } from 'express';
import { AdminSessionGuard, AdminAuthenticatedRequest } from './admin-session.guard';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { AdminAuthService } from './admin-auth.service';
import { TelegramLoginWidgetPayload } from '../telegram-auth/telegram-login-widget.util';
import { ADMIN_SESSION_COOKIE_NAME, parseCookieHeader } from './cookie.util';

/** Docker dev-запуск (DOCKER.md): тело POST /admin/auth/dev-login.
 * devUserId необязателен — без него берётся "123", то же значение по
 * умолчанию, что у NEXT_PUBLIC_DEV_USER_ID в apps/tma/.env.example,
 * чтобы админка и TMA из коробки открывались под одним пользователем. */
class DevLoginDto {
  devUserId?: string | number;
}

@Controller('admin/auth')
@UseInterceptors(ApiResponseInterceptor)
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Post('telegram-callback')
  async telegramCallback(
    @Body() payload: TelegramLoginWidgetPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.adminAuth.loginWithTelegram(payload);
    this.setSessionCookie(res, result);
    // ПОВТОРНЫЙ АУДИТ 2026-08-30: возвращался весь result, включая сам
    // token. Это обесценивало httpOnly, ради которого cookie и заведена:
    // токен, отданный в теле ответа, доступен JavaScript'у на домене
    // админки — то есть любой XSS в момент логина (или привычка фронта
    // «на всякий случай» положить его в localStorage) давал бы
    // семидневный доступ, от которого httpOnly и защищает. Клиенту
    // нужен только срок действия, чтобы показать «сессия истекает».
    return { expiresAt: result.expiresAt };
  }

  /**
   * Docker dev-запуск (DOCKER.md) — вход в админку без Telegram Login
   * Widget. Доступен ТОЛЬКО при ALLOW_DEV_AUTH=true и NODE_ENV!==production;
   * сама проверка живёт в AdminAuthService.devLogin(), а не здесь, чтобы
   * её нельзя было обойти, вызвав сервис мимо контроллера (тесты, будущий
   * второй контроллер). Вне dev отвечает 404 — как несуществующий маршрут.
   *
   * Cookie ставится тем же приватным методом, что и для настоящего входа:
   * dev-стенд должен проверять ровно тот механизм сессии, который поедет
   * в прод, иначе смысл локального стенда теряется.
   */
  @Post('dev-login')
  async devLogin(@Body() body: DevLoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.adminAuth.devLogin(String(body?.devUserId ?? '123'));
    this.setSessionCookie(res, result);
    return { expiresAt: result.expiresAt }; // токен — только в cookie, см. telegramCallback выше
  }

  private setSessionCookie(res: Response, result: { token: string; expiresAt: Date }): void {
    // httpOnly — недоступна из JS клиента (защита от XSS-кражи
    // токена); secure — только по HTTPS в проде, dev допускает http
    // локально; sameSite=lax — Login Widget redirect идёт с
    // telegram.org, strict сломал бы установку cookie на самом
    // редиректе.
    // Пункт [admin-panel]: найдено при реализации apps/admin — apps/admin
    // и apps/api деплоятся как ОТДЕЛЬНЫЕ Vercel-домены (тот же принцип
    // разделения, что у apps/tma/apps/landing). fetch() с credentials:
    // 'include' с admin-домена на api-домен — cross-site запрос, не
    // top-level navigation; SameSite=Lax браузер в такой ситуации НЕ
    // отправляет — сессия молча не работала бы в проде. SameSite=None
    // обязателен для реального кросс-доменного использования, что
    // требует Secure=true (спецификация не разрешает None без Secure) —
    // тот же process.env.NODE_ENV, что уже используется для secure,
    // теперь определяет оба флага согласованно, не только один из двух.
    // В dev два localhost-порта остаются "same-site" по RFC (site =
    // eTLD+1+scheme, не порт) — 'lax' там продолжает работать, значит
    // и dev, и prod поведение остаются корректными для своего контекста.
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(ADMIN_SESSION_COOKIE_NAME, result.token, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      expires: result.expiresAt,
      path: '/',
    });
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookies = parseCookieHeader(req.headers.cookie);
    const token = cookies[ADMIN_SESSION_COOKIE_NAME];
    if (token) {
      await this.adminAuth.logout(token);
    }
    const isProd = process.env.NODE_ENV === 'production';
    res.clearCookie(ADMIN_SESSION_COOKIE_NAME, { path: '/', secure: isProd, sameSite: isProd ? 'none' : 'lax' });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AdminSessionGuard)
  async me(@Req() req: AdminAuthenticatedRequest) {
    return this.adminAuth.me(req.userId);
  }
}

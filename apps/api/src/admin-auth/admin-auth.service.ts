// Пункт [admin-panel] (devils-advocate-admin-panel-tz.md §4.1):
// AdminAuthService — единственное место, создающее/удаляющее
// AdminSession. Аутентификация сама по себе НЕ требует никаких прав
// (isLibraryModerator/isVenueModerator/isOperator) — любой пользователь
// Telegram может войти в /admin/login, доступ к конкретным вкладкам
// определяется отдельно, по флагам, на уровне каждого сервиса
// (acceptance-тест §5.1: "честное «нет доступа», не ошибка входа").

import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  validateTelegramLoginWidgetPayload,
  TelegramLoginWidgetInvalidError,
  TelegramLoginWidgetPayload,
} from '../telegram-auth/telegram-login-widget.util';
import { devTelegramId, isDevAuthAllowed } from './dev-login';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней — буквально ТЗ §4.1

export interface AdminSessionResult {
  token: string;
  expiresAt: Date;
}

export interface AdminMeResult {
  userId: string;
  isLibraryModerator: boolean;
  isVenueModerator: boolean;
  isOperator: boolean;
}

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Docker dev-запуск (DOCKER.md): вход в админку БЕЗ Telegram Login
   * Widget. Зачем вообще — Login Widget физически не работает на
   * http://localhost: Telegram привязывает виджет к домену, указанному
   * боту через @BotFather /setdomain, и localhost туда не принимается.
   * То есть без этого метода админка в локальном докер-стенде остаётся
   * недоступной в принципе, сколько бы ни было настроено переменных;
   * это не «удобство», а единственный способ открыть /admin локально.
   *
   * Зеркалит dev-bypass TelegramAuthGuard (X-Dev-User-Id), но с двумя
   * отличиями, вытекающими из разной природы двух входов:
   *
   * 1. Проверка строже — isDevAuthAllowed() требует И ALLOW_DEV_AUTH=true,
   *    И NODE_ENV!==production (обоснование — в dev-login.ts).
   * 2. Пользователю ПРИНУДИТЕЛЬНО выставляются все три флага доступа
   *    (isOperator/isLibraryModerator/isVenueModerator). Не потому, что
   *    «так проще», а потому что иначе dev-вход бесполезен: админка
   *    целиком состоит из вкладок, каждая из которых требует своего
   *    флага, и вход без флагов показывал бы четыре одинаковых экрана
   *    «нет доступа». Проверку самих флагов это НЕ ослабляет — сервисы
   *    (assertOperator и т.п.) продолжают их проверять как обычно,
   *    просто у dev-пользователя они выставлены в БД по-настоящему.
   *
   * Пользователь — тот же User, что и в TMA (префикс "dev-"), поэтому
   * сквозной сценарий «создал в TMA → отмодерировал в админке» работает
   * на одном и том же аккаунте.
   */
  async devLogin(rawDevUserId: string): Promise<AdminSessionResult> {
    if (!isDevAuthAllowed()) {
      // 404, а не 403: наружу этот эндпоинт вообще не должен выглядеть
      // существующим. 403 подтвердил бы сканеру, что механизм dev-входа
      // в сборке есть и его имеет смысл атаковать (перебор переменных,
      // попытка подсунуть NODE_ENV через заголовки прокси и т.п.).
      throw new NotFoundException('Cannot POST /admin/auth/dev-login');
    }

    const telegramId = devTelegramId(rawDevUserId.trim() || '123');

    this.logger.warn(
      `ADMIN DEV LOGIN — выдана сессия админки для ${telegramId} без проверки Telegram. ` +
        'Убедиться, что ALLOW_DEV_AUTH не выставлен в проде.',
    );

    // upsert, а не create: повторный dev-вход не должен падать на
    // уникальном telegramId, а уже существующему dev-пользователю (тому
    // самому, которого мог создать TMA-bypass) нужно доставить флаги —
    // без update он вошёл бы в админку без прав и увидел пустые вкладки.
    const user = await this.prisma.user.upsert({
      where: { telegramId },
      update: { isOperator: true, isLibraryModerator: true, isVenueModerator: true },
      create: {
        telegramId,
        isOperator: true,
        isLibraryModerator: true,
        isVenueModerator: true,
      },
    });

    // isBlocked уважается даже здесь: dev-вход — обход ТЕЛЕГРАМА, не
    // обход блокировок. Иначе локальная проверка сценария «оператор
    // заблокировал аккаунт» давала бы неверный результат — заблокированный
    // пользователь продолжал бы заходить.
    if (user.isBlocked) {
      throw new UnauthorizedException('Account is blocked');
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.prisma.adminSession.create({ data: { userId: user.id, token, expiresAt } });

    return { token, expiresAt };
  }

  async loginWithTelegram(payload: TelegramLoginWidgetPayload): Promise<AdminSessionResult> {
    const botToken = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');

    let parsed;
    try {
      parsed = validateTelegramLoginWidgetPayload(payload, { botToken });
    } catch (err) {
      if (err instanceof TelegramLoginWidgetInvalidError) {
        throw new UnauthorizedException('Invalid Telegram Login Widget payload');
      }
      throw err;
    }

    // Тот же telegramId-неймспейс, что у TMA-пользователей (Login
    // Widget и Mini App отдают тот же числовой Telegram user id) —
    // намеренно не заводим параллельного "admin-пользователя", вход
    // через админку — тот же User, что и в TMA, с теми же флагами.
    const user = await this.prisma.user.upsert({
      where: { telegramId: String(parsed.id) },
      update: {},
      create: { telegramId: String(parsed.id) },
    });

    // Пункт [full-block] — isBlocked, у відмінність від відсутності
    // isOperator/isLibraryModerator/isVenueModerator (§5.1 ТЗ —
    // "честное «нет доступа», не ошибка входа"), закриває цей окремий
    // вхід ЦІЛКОМ: сенс "повного блокування" саме в тому, щоб не
    // лишати заблокованому користувачу жодного шляху, навіть без
    // реального доступу до вкладок.
    if (user.isBlocked) {
      throw new UnauthorizedException('Account is blocked');
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await this.prisma.adminSession.create({
      data: { userId: user.id, token, expiresAt },
    });

    return { token, expiresAt };
  }

  async logout(token: string): Promise<{ ok: true }> {
    await this.prisma.adminSession.deleteMany({ where: { token } });
    return { ok: true };
  }

  async me(userId: string): Promise<AdminMeResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isLibraryModerator: true, isVenueModerator: true, isOperator: true },
    });
    // Guard уже гарантирует, что userId существует (сессия создаётся
    // только для реального User) — findUniqueOrThrow был бы избыточен,
    // но честно проверяем на случай удалённого между сессией и запросом
    // пользователя, не молча падаем на undefined-деструктуризации.
    if (!user) {
      throw new UnauthorizedException('User not found for this admin session');
    }
    return {
      userId,
      isLibraryModerator: user.isLibraryModerator,
      isVenueModerator: user.isVenueModerator,
      isOperator: user.isOperator,
    };
  }
}

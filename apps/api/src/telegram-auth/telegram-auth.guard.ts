// Чекпоинт 1, пункт 11: TMA bootstrap/auth — Guard
//
// Читает заголовок X-Telegram-Init-Data, валидирует через
// validateTelegramInitData, upsert'ит User по telegramId (первый визит
// создаёт запись — см. Prisma-модель User из пункта 1), кладёт
// провалидированного пользователя в request.userId.
//
// DEV panel convention (перенесено из других проектов стека): в local
// dev окружении (ALLOW_DEV_AUTH=true) можно миновать реальную Telegram
// подпись через заголовок X-Dev-User-Id — иначе локальная разработка
// TMA-функциональности вне самого Telegram невозможна. Это ТОЛЬКО для
// dev/staging — в проде ALLOW_DEV_AUTH обязан быть unset/false, иначе
// это дыра в аутентификации, а не удобство разработки.

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import {
  validateTelegramInitData,
  TelegramInitDataInvalidError,
  ParsedTelegramInitData,
} from './telegram-init-data.util';

export interface AuthenticatedRequest extends Request {
  telegramAuth?: ParsedTelegramInitData; // отсутствует при DEV bypass
  userId: string; // internal User.id (не telegramId), уже upsert'нутый
  // Пункт [admin-panel] (devils-advocate-admin-panel-tz.md §4.3):
  // User.isRestricted = true НЕ блокирует запрос полностью — решение
  // о степени жёсткости оставлено явно открытым тем же ТЗ. Guard
  // только сигнализирует об ограничении; конкретные чувствительные
  // write-эндпоинты (создание проекта, публикация в библиотеку, заявка
  // заведения) обязаны сами проверять этот флаг и отклонять с понятным
  // сообщением — список таких эндпоинтов задача следующего прохода
  // (см. TODO.md), не фиксируется здесь окончательным списком.
  userRestricted?: boolean;
}

/** ISO-3166-1 alpha-2 из x-vercel-ip-country или null. Экспортирована ради тестов. */
export function readVercelIpCountry(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers['x-vercel-ip-country'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
  if (!value || value.length !== 2 || value === 'XX' || !/^[A-Z]{2}$/.test(value)) return null;
  return value;
}

@Injectable()
export class TelegramAuthGuard implements CanActivate {
  private readonly logger = new Logger(TelegramAuthGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const devUserId = await this.tryDevBypass(request);
    if (devUserId) {
      // Пункт [full-block] — isBlocked відхиляє запит ЦІЛКОМ, до
      // видачі userId, на відміну від isRestricted (яке тільки
      // сигналізує). Перевірка тут, а не тільки в NotRestrictedGuard,
      // бо isBlocked має блокувати й read-запити, не тільки дев'ять
      // write-точок.
      if (devUserId.isBlocked) {
        throw new UnauthorizedException('Account is blocked');
      }
      request.userId = devUserId.id;
      request.userRestricted = devUserId.isRestricted;
      return true;
    }

    const rawInitData = request.headers['x-telegram-init-data'];
    if (!rawInitData || Array.isArray(rawInitData)) {
      throw new UnauthorizedException('X-Telegram-Init-Data header is required');
    }

    const botToken = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');

    let parsed: ParsedTelegramInitData;
    try {
      parsed = validateTelegramInitData(rawInitData, { botToken });
    } catch (err) {
      if (err instanceof TelegramInitDataInvalidError) {
        this.logger.warn(`initData rejected: ${err.message}`);
        throw new UnauthorizedException('Invalid Telegram initData');
      }
      throw err;
    }

    // Полный аудит 2026-08-30 — страна по IP из заголовка Vercel: единственный
    // автоматический источник юрисдикции для legal-disclaimer (раньше бакет
    // всегда был OTHER — см. jurisdiction-bucket.ts). Обновляется каждый
    // запрос, чтобы не залипать на первом значении; 'XX'/пусто (localhost,
    // приватные сети) — не пишем.
    const ipCountryCode = readVercelIpCountry(request.headers);
    const user = await this.prisma.user.upsert({
      where: { telegramId: String(parsed.user.id) },
      update: ipCountryCode ? { ipCountryCode } : {},
      create: { telegramId: String(parsed.user.id), ipCountryCode },
    });

    // Пункт [full-block] — те саме, що в dev-bypass гілці вище:
    // isBlocked відхиляє запит ЦІЛКОМ, до request.userId. Перевірка
    // ПІСЛЯ upsert навмисно — новий користувач фізично не може бути
    // isBlocked=true (дефолт false), перевірка після upsert не змінює
    // поведінку для нових користувачів, тільки для вже існуючих.
    if (user.isBlocked) {
      throw new UnauthorizedException('Account is blocked');
    }

    request.telegramAuth = parsed;
    request.userId = user.id;
    // Пункт [admin-panel] §4.3 — сигнализируем, не блокируем.
    request.userRestricted = user.isRestricted;
    return true;
  }

  /**
   * DEV bypass — активен только при ALLOW_DEV_AUTH=true. Заголовок
   * X-Dev-User-Id трактуется как условный telegramId и проходит через
   * тот же upsert, что и реальный пользователь (telegramId получает
   * префикс "dev-", чтобы гарантированно не пересечься с настоящими
   * Telegram ID и было видно в БД, что запись тестовая).
   */
  private async tryDevBypass(request: AuthenticatedRequest): Promise<{ id: string; isRestricted: boolean; isBlocked: boolean } | null> {
    const allowDevAuth = this.config.get<string>('ALLOW_DEV_AUTH') === 'true';
    if (!allowDevAuth) return null;

    const devUserId = request.headers['x-dev-user-id'];
    if (!devUserId || Array.isArray(devUserId)) return null;

    this.logger.warn(
      `DEV AUTH BYPASS ACTIVE — X-Dev-User-Id=${devUserId}. Убедиться, что ALLOW_DEV_AUTH никогда не выставлен в проде.`,
    );

    const ipCountryCode = readVercelIpCountry(request.headers);
    const user = await this.prisma.user.upsert({
      where: { telegramId: `dev-${devUserId}` },
      update: ipCountryCode ? { ipCountryCode } : {},
      create: { telegramId: `dev-${devUserId}`, ipCountryCode },
    });

    return { id: user.id, isRestricted: user.isRestricted, isBlocked: user.isBlocked };
  }
}

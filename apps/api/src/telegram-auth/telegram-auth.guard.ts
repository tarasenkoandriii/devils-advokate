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
      request.userId = devUserId;
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

    const user = await this.prisma.user.upsert({
      where: { telegramId: String(parsed.user.id) },
      update: {},
      create: { telegramId: String(parsed.user.id) },
    });

    request.telegramAuth = parsed;
    request.userId = user.id;
    return true;
  }

  /**
   * DEV bypass — активен только при ALLOW_DEV_AUTH=true. Заголовок
   * X-Dev-User-Id трактуется как условный telegramId и проходит через
   * тот же upsert, что и реальный пользователь (telegramId получает
   * префикс "dev-", чтобы гарантированно не пересечься с настоящими
   * Telegram ID и было видно в БД, что запись тестовая).
   */
  private async tryDevBypass(request: AuthenticatedRequest): Promise<string | null> {
    const allowDevAuth = this.config.get<string>('ALLOW_DEV_AUTH') === 'true';
    if (!allowDevAuth) return null;

    const devUserId = request.headers['x-dev-user-id'];
    if (!devUserId || Array.isArray(devUserId)) return null;

    this.logger.warn(
      `DEV AUTH BYPASS ACTIVE — X-Dev-User-Id=${devUserId}. Убедиться, что ALLOW_DEV_AUTH никогда не выставлен в проде.`,
    );

    const user = await this.prisma.user.upsert({
      where: { telegramId: `dev-${devUserId}` },
      update: {},
      create: { telegramId: `dev-${devUserId}` },
    });

    return user.id;
  }
}

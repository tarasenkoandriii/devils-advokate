// Чекпоинт 1, пункт 11: /bootstrap endpoint convention
//
// Единая точка входа для TMA при запуске: фронтенд дёргает /bootstrap
// сразу после инициализации Telegram WebApp SDK, получает провалидиро-
// ванного пользователя + минимальный конфиг приложения одним запросом.
//
// MVP-фича 13: disclaimerAcknowledged встроен прямо сюда, не вынесен в
// отдельный обязательный второй запрос — блокирующий экран (§3.36 ТЗ)
// должен решаться с первого же ответа сервера, иначе TMA успевала бы
// на долю секунды отрисовать основной интерфейс до того, как второй
// запрос подтвердит, что дисклеймер ещё не принят.

import { Controller, Get, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { computeDisclaimerStatus } from '../launch-disclaimer/launch-disclaimer.service';

export interface BootstrapResponse {
  userId: string;
  privacyProcessingMode: string;
  isNewUser: boolean;
  serverTime: string;
  disclaimerAcknowledged: boolean;
}

@Controller('bootstrap')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class BootstrapController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async bootstrap(@CurrentUser() userId: string): Promise<BootstrapResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    // "Новый" — грубая эвристика по времени создания записи (только что
    // upsert'нута гардом, если это был первый визит).
    const isNewUser = Date.now() - user.createdAt.getTime() < 5000;

    // Пункт 34 (реальное исправление находки аудита, Пункт 33) — раньше
    // здесь было инлайн-дублирование ровно той же логики, что уже
    // вычисляет LaunchDisclaimerService. computeDisclaimerStatus() —
    // чистая функция, не дёргает БД сама (user уже загружен строкой
    // выше), поэтому переиспользуется без лишнего запроса и без
    // добавления LaunchDisclaimerService как новой DI-зависимости
    // этого контроллера.
    const { acknowledged: disclaimerAcknowledged } = computeDisclaimerStatus(user);

    return {
      userId: user.id,
      privacyProcessingMode: user.privacyProcessingMode,
      isNewUser,
      serverTime: new Date().toISOString(),
      disclaimerAcknowledged,
    };
  }
}


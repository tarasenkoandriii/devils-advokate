// Пункт [job-domain-v2] К-20 — точка приёма update'ов Telegram и две
// операторские команды регистрации.
//
// ПОЧЕМУ ВЕБХУК ВСЕГДА ОТВЕЧАЕТ 200. Telegram повторяет доставку на любой
// не-2xx и наращивает паузу. Один неудачный update (чужой формат, наш баг)
// превратился бы в бесконечный поток ретраев одного и того же сообщения, а
// пользователь всё это время получал бы дубликаты ответов. Ошибки обработки
// уходят в лог, наружу — «ok».
//
// АУТЕНТИФИКАЦИЯ. Telegram возвращает наш `secret_token` в заголовке
// `X-Telegram-Bot-Api-Secret-Token` — тот же приём, что у вебхуков
// распознавания речи. Fail closed: секрет не настроен → 503, а не «пропустить».
// Без этого адрес вебхука — открытая точка, куда кто угодно шлёт «сообщения
// от имени» любого telegramId.
import { Body, Controller, Get, Headers, Post, UseInterceptors } from '@nestjs/common';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { SecretsService } from '../secrets/secrets.service';
import { safeSecretEqual } from '../common/timing-safe-equal';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { TelegramBotService, TELEGRAM_WEBHOOK_HEADER, TELEGRAM_WEBHOOK_SECRET_REF } from './telegram-bot.service';
import type { TelegramUpdate } from './telegram-update';
import { assertSharedSecret } from '../common/dispatch-secret';

const DISPATCH_SECRET_REF = 'SCHEDULER_DISPATCH_SECRET';

@Controller('telegram')
@UseInterceptors(ApiResponseInterceptor)
export class TelegramBotController {
  constructor(
    private readonly bot: TelegramBotService,
    private readonly secrets: SecretsService,
  ) {}

  @Post('webhook')
  async webhook(@Headers(TELEGRAM_WEBHOOK_HEADER) provided: string, @Body() update: TelegramUpdate) {
    const expected = await this.secrets.resolve(TELEGRAM_WEBHOOK_SECRET_REF).catch(() => null);
    if (!expected) {
      throw new ServiceUnavailableException(`${TELEGRAM_WEBHOOK_SECRET_REF} не настроен — приём сообщений бота отключён (fail closed)`);
    }
    if (!safeSecretEqual(provided, expected)) throw new UnauthorizedException();
    return this.bot.handleUpdate(update);
  }

  /** Регистрация адреса вебхука у Telegram — из админки/скрипта деплоя. */
  @Post('register-webhook')
  async register(@Headers('x-dispatch-secret') secret: string) {
    await this.assertDispatchSecret(secret);
    return this.bot.registerWebhook();
  }

  /** Диагностика: что Telegram думает о нашем вебхуке (в т. ч. последняя
   * ошибка доставки — первое, что нужно оператору, когда «бот молчит»). */
  @Get('webhook-info')
  async info(@Headers('x-dispatch-secret') secret: string) {
    await this.assertDispatchSecret(secret);
    return this.bot.webhookInfo();
  }

  private async assertDispatchSecret(provided: string) {
    // Пункт [the-registry-promised-401-and-gave-500] 2026-09-30: этот
    // контроллер был ЕДИНСТВЕННЫМ, кто отказывал честно, — и потому
    // стал образцом для общего места. Своя копия больше не нужна.
    await assertSharedSecret(this.secrets, DISPATCH_SECRET_REF, provided);
  }
}

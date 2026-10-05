// Пункт [job-domain-v2] К-20 — бот-приёмник пересланных вакансий.
//
// ЧТО ЭТО ЗАКРЫВАЕТ. Серверный маршрут приёма пересланного текста существовал
// с самого выпуска связки П, но вызывать его было некому: входящего вебхука
// бота в монорепо не было вовсе (только исходящие напоминания). Функция К-20
// числилась готовой, а физически была недостижима — ровно тот разрыв, который
// проект называет «конфигурация не должна выглядеть как отказ фичи», только в
// обратную сторону.
//
// ГРАНИЦЫ, КОТОРЫЕ ДЕРЖИТ ИМЕННО ЭТОТ ФАЙЛ:
//   • бот НИЧЕГО не решает за пользователя: он сохраняет пересланный текст как
//     вакансию и отвечает, куда сохранил. Ни сверки, ни оценки, ни «эта
//     вакансия вам подходит» — это делают экраны по явному действию человека;
//   • ответ всегда называет проект: молча положить вакансию в один из
//     нескольких проектов и не сказать в какой — значит потерять её для
//     человека;
//   • у пользователя без проекта поиска работы бот не создаёт проект сам:
//     проект — это согласия, режим и онбординг, а не побочный эффект пересылки.
//     Он честно говорит, чего не хватает, и даёт ссылку;
//   • личность автора пересланного сообщения не доезжает даже сюда (см.
//     telegram-update.ts).

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ProjectMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../secrets/secrets.service';
import { VacancyIntakeService } from '../vacancy-intake/vacancy-intake.service';
import { sendTelegramMessage, TelegramSendError } from '../common/telegram-bot-client';
import { buildStartDeepLink } from '../common/telegram-deep-link';
import { publicApiBaseUrl } from '../common/public-base-url';
import { MIN_FORWARD_TEXT_CHARS, ParsedUpdate, parseUpdate, TelegramUpdate } from './telegram-update';
import { telegramRefusalHint, telegramSecretProblem } from './webhook-secret-format';

export const BOT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN';
export const TELEGRAM_WEBHOOK_SECRET_REF = 'TELEGRAM_WEBHOOK_SECRET';
export const TELEGRAM_WEBHOOK_HEADER = 'x-telegram-bot-api-secret-token';
/** Путь приёмника — один и для регистрации, и для контроллера. */
export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

const TELEGRAM_API_HOST = 'https://api.telegram.org';

@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly intake: VacancyIntakeService,
  ) {}

  /** Точка входа вебхука. НИКОГДА не бросает наружу: Telegram на ошибку
   * повторяет доставку, и падение обработчика превратилось бы в очередь
   * бесконечных ретраев одного и того же сообщения. */
  async handleUpdate(update: TelegramUpdate): Promise<{ ok: true; handled: ParsedUpdate['kind']; detail?: string }> {
    const parsed = parseUpdate(update);
    try {
      switch (parsed.kind) {
        case 'forwarded':
          return { ok: true, handled: parsed.kind, detail: await this.onForwarded(parsed) };
        case 'start':
          return { ok: true, handled: parsed.kind, detail: await this.onStart(parsed) };
        case 'plain_text':
          return { ok: true, handled: parsed.kind, detail: await this.onPlainText(parsed) };
        default:
          return { ok: true, handled: 'ignored', detail: parsed.reason };
      }
    } catch (err) {
      // Текст ошибки — в лог оператору, пользователю — человеческая строка.
      this.logger.error(`Обработка update не удалась: ${err instanceof Error ? err.message : String(err)}`);
      if (parsed.kind !== 'ignored') {
        await this.reply(parsed.chatId, 'Не удалось обработать сообщение. Попробуйте ещё раз позже — если повторится, откройте приложение и добавьте вакансию текстом.');
      }
      return { ok: true, handled: parsed.kind, detail: 'ошибка обработки' };
    }
  }

  private async onForwarded(parsed: Extract<ParsedUpdate, { kind: 'forwarded' }>): Promise<string> {
    const user = await this.prisma.user.findFirst({ where: { telegramId: parsed.telegramId }, select: { id: true } });
    if (!user) {
      await this.reply(parsed.chatId, `Похоже, вы ещё не открывали приложение. Откройте его и заведите поиск работы — тогда пересланные вакансии будут попадать в проект: ${this.appLink()}`);
      return 'пользователь не найден';
    }

    const project = await this.targetProject(user.id);
    if (!project) {
      await this.reply(parsed.chatId, `Пересылка сохраняет вакансии в проект поиска работы, а такого проекта у вас пока нет. Заведите его в приложении и перешлите сообщение снова: ${this.appLink()}`);
      return 'нет проекта поиска работы';
    }

    if (parsed.text.length < MIN_FORWARD_TEXT_CHARS) {
      await this.reply(parsed.chatId, 'В пересланном сообщении слишком мало текста для вакансии. Перешлите сообщение с описанием целиком или добавьте текст вручную в приложении.');
      return 'слишком короткий текст';
    }

    const vacancy = await this.intake.fromForwardedMessage(parsed.telegramId, project.id, parsed.text);
    const title = vacancy.title ?? vacancy.sourceUrl ?? 'без названия';
    await this.reply(
      parsed.chatId,
      `Сохранил в проект «${project.question}»: ${title}. Сверю с вашим резюме и критериями, когда вы откроете вакансию в приложении — сам за вас ничего не решаю.`,
    );
    return `вакансия ${vacancy.id}`;
  }

  private async onStart(parsed: Extract<ParsedUpdate, { kind: 'start' }>): Promise<string> {
    if (!parsed.payload) {
      await this.reply(parsed.chatId, `Это бот приложения. Открыть: ${this.appLink()}\n\nСюда можно пересылать сообщения с вакансиями — текст попадёт в ваш проект поиска работы.`);
      return 'приветствие';
    }
    // Токен приглашения/анкеты пришёл в чат, а не в Mini App (так бывает,
    // если ссылку открыли на десктопе). Возвращаем ту же ссылку, которую
    // выдаёт продукт, — вместо «нажмите кнопку», которой у нас тут нет.
    let link: string;
    try {
      link = buildStartDeepLink(parsed.payload);
    } catch {
      await this.reply(parsed.chatId, `Ссылка не распознана. Открыть приложение: ${this.appLink()}`);
      return 'нераспознанная нагрузка';
    }
    await this.reply(parsed.chatId, `Открыть по этой ссылке: ${link}`);
    return 'ссылка выдана';
  }

  private async onPlainText(parsed: Extract<ParsedUpdate, { kind: 'plain_text' }>): Promise<string> {
    // Длинный текст почти наверняка вставленная вакансия — но «почти» здесь
    // не основание что-то сохранять: подсказываем действие, а не угадываем.
    const hint =
      parsed.length >= MIN_FORWARD_TEXT_CHARS
        ? 'Если это вакансия — перешлите исходное сообщение (тогда я сохраню его в проект) или вставьте текст в приложении: «Приток» → «Вставить текст».'
        : 'Перешлите мне сообщение с вакансией — сохраню его в ваш проект поиска работы.';
    await this.reply(parsed.chatId, `${hint}\n\nПриложение: ${this.appLink()}`);
    return 'подсказка';
  }

  /** Проект, куда попадёт пересланная вакансия: последний, с которым человек
   * работал. Выбор называется в ответе — «куда-то сохранилось» хуже, чем
   * «сохранено не туда, и это видно». */
  private async targetProject(userId: string) {
    return this.prisma.project.findFirst({
      where: { ownerId: userId, mode: ProjectMode.JOB_SEARCH, frozenAt: null, jobSearchConfig: { isNot: null } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, question: true },
    });
  }

  private appLink(): string {
    const miniApp = process.env.TELEGRAM_MINI_APP_URL?.trim();
    if (miniApp) return miniApp;
    const bot = process.env.TELEGRAM_BOT_USERNAME?.trim();
    return bot ? `https://t.me/${bot}` : 'приложение в Telegram';
  }

  private async reply(chatId: string, text: string): Promise<void> {
    const token = await this.secrets.resolve(BOT_TOKEN_REF).catch(() => null);
    if (!token) {
      this.logger.warn(`${BOT_TOKEN_REF} не настроен — ответить пользователю нечем`);
      return;
    }
    try {
      await sendTelegramMessage(token, chatId, text);
    } catch (err) {
      // Ответ не доставлен — вакансия уже сохранена, и терять её из-за
      // недоступного Telegram нельзя. Пишем в лог и живём дальше.
      if (err instanceof TelegramSendError) this.logger.warn(`Ответ пользователю не доставлен: ${err.message}`);
      else throw err;
    }
  }

  /** Регистрация вебхука у Telegram — операторская команда, а не автозапуск:
   * адрес зависит от окружения, и переустанавливать его при каждом старте
   * инстанса значит менять прод из превью-деплоя. */
  async registerWebhook(): Promise<{ url: string; ok: boolean; description?: string; hint?: string }> {
    const token = await this.secrets.resolve(BOT_TOKEN_REF);
    const secret = await this.secrets.resolve(TELEGRAM_WEBHOOK_SECRET_REF);
    // Пункт [the-provider-had-rules-nobody-wrote-down] 2026-10-01:
    // формат проверяется ДО обращения к провайдеру. Иначе владелец
    // узнаёт об алфавите `secret_token` из английской строки Telegram
    // («secret token contains illegal characters») — после того, как
    // выставил переменную, сделал редеплой и выполнил команду.
    const problem = telegramSecretProblem(secret);
    if (problem) {
      throw new BadRequestException(
        `${TELEGRAM_WEBHOOK_SECRET_REF} не подходит для Telegram — ${problem.message} ` +
          'Вебхук НЕ зарегистрирован: значение у нас и у Telegram осталось прежним.',
      );
    }
    const url = `${publicApiBaseUrl()}${TELEGRAM_WEBHOOK_PATH}`;
    const response = await fetch(`${TELEGRAM_API_HOST}/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        secret_token: secret,
        // Нас интересуют только сообщения: подписка на всё остальное — лишний
        // трафик и лишние данные о пользователе, которые нам не нужны.
        allowed_updates: ['message'],
        drop_pending_updates: true,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    const ok = data.ok === true;
    // Отказ провайдера не отдаётся пересказом чужой строки: к нему
    // прикладывается приписка о том, ЧЬЁ наше значение Telegram
    // отверг. Обоснование — в шапке `webhook-secret-format.ts`,
    // вторая половина пункта.
    return ok
      ? { url, ok, description: data.description }
      : { url, ok, description: data.description, hint: telegramRefusalHint(data.description) };
  }

  async webhookInfo(): Promise<Record<string, unknown>> {
    const token = await this.secrets.resolve(BOT_TOKEN_REF);
    const response = await fetch(`${TELEGRAM_API_HOST}/bot${token}/getWebhookInfo`);
    const data = (await response.json().catch(() => ({}))) as { result?: Record<string, unknown> };
    const result = data.result ?? {};
    // url наружу отдаём как есть (публичный адрес), секрет Telegram и не
    // возвращает — но на всякий случай не пробрасываем неизвестные поля.
    return {
      url: result.url ?? null,
      has_custom_certificate: result.has_custom_certificate ?? null,
      pending_update_count: result.pending_update_count ?? null,
      last_error_date: result.last_error_date ?? null,
      last_error_message: result.last_error_message ?? null,
      allowed_updates: result.allowed_updates ?? null,
    };
  }
}

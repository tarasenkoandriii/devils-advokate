// Чекпоинт 1, пункт 11: TMA bootstrap/auth
// Перенос уже отработанного паттерна из других проектов стека
// (X-Telegram-Init-Data валидация, /bootstrap, apiReq/handle()).
//
// Алгоритм валидации initData — по официальной спецификации Telegram:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// data-check-string = все пары key=value из initData, КРОМЕ hash,
// отсортированные по ключу и склеенные через '\n'.
// secret-key = HMAC-SHA256("WebAppData", bot_token)
// ожидаемый hash = HMAC-SHA256(secret-key, data-check-string) в hex.

import { createHmac } from 'crypto';

export interface TelegramInitDataUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface ParsedTelegramInitData {
  user: TelegramInitDataUser;
  authDate: Date;
  raw: Record<string, string>;
}

export class TelegramInitDataInvalidError extends Error {
  constructor(reason: string) {
    super(`Invalid Telegram initData: ${reason}`);
    this.name = 'TelegramInitDataInvalidError';
  }
}

/**
 * ВАЖНО — известный баг из предыдущих проектов ("bad_hash"/signature
 * exclusion fix): Telegram добавил поле `signature` (Ed25519-подпись
 * для сторонней валидации) ПОМИМО исходного `hash`. Если исключать
 * из data-check-string только `hash`, но забыть исключить `signature` —
 * валидация ломается на части реальных initData (в частности когда
 * клиент передаёт оба поля), потому что `signature` тоже попадает в
 * склеенную строку и меняет итоговый HMAC. Оба поля исключаются здесь
 * явно, а не только `hash` — это тот самый фикс, который уже один раз
 * стоил времени на дебаг в другом проекте, не повторяем его тут.
 */
const FIELDS_EXCLUDED_FROM_CHECK_STRING = new Set(['hash', 'signature']);

function buildDataCheckString(params: URLSearchParams): string {
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (FIELDS_EXCLUDED_FROM_CHECK_STRING.has(key)) continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  return pairs.join('\n');
}

export interface TelegramInitDataValidationOptions {
  botToken: string;
  /** Максимальный возраст initData в секундах — защита от replay. По
   * умолчанию 24 часа, как в большинстве референсных реализаций
   * Telegram; можно ужесточить для чувствительных операций отдельным
   * вызовом с меньшим maxAgeSeconds. */
  maxAgeSeconds?: number;
}

export function validateTelegramInitData(
  rawInitData: string,
  options: TelegramInitDataValidationOptions,
): ParsedTelegramInitData {
  const { botToken, maxAgeSeconds = 86400 } = options;

  if (!rawInitData || rawInitData.trim().length === 0) {
    throw new TelegramInitDataInvalidError('empty initData');
  }

  const params = new URLSearchParams(rawInitData);
  const receivedHash = params.get('hash');
  if (!receivedHash) {
    throw new TelegramInitDataInvalidError('missing hash field');
  }

  const dataCheckString = buildDataCheckString(params);

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (expectedHash !== receivedHash) {
    throw new TelegramInitDataInvalidError('hash mismatch');
  }

  const authDateRaw = params.get('auth_date');
  if (!authDateRaw) {
    throw new TelegramInitDataInvalidError('missing auth_date field');
  }
  const authDate = new Date(Number(authDateRaw) * 1000);
  const ageSeconds = (Date.now() - authDate.getTime()) / 1000;
  if (ageSeconds > maxAgeSeconds) {
    throw new TelegramInitDataInvalidError(`initData too old (${Math.round(ageSeconds)}s)`);
  }
  if (ageSeconds < -60) {
    // Небольшой допуск на рассинхронизацию часов клиента, не строго < 0.
    throw new TelegramInitDataInvalidError('auth_date is in the future');
  }

  const userRaw = params.get('user');
  if (!userRaw) {
    throw new TelegramInitDataInvalidError('missing user field');
  }

  let user: TelegramInitDataUser;
  try {
    user = JSON.parse(userRaw);
  } catch {
    throw new TelegramInitDataInvalidError('user field is not valid JSON');
  }
  if (!user.id) {
    throw new TelegramInitDataInvalidError('user.id missing');
  }

  const raw: Record<string, string> = {};
  for (const [key, value] of params.entries()) raw[key] = value;

  return { user, authDate, raw };
}

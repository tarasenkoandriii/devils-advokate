// Пункт [admin-panel] (devils-advocate-admin-panel-tz.md, §2/§4.1) —
// валидация payload от Telegram Login Widget. СОЗНАТЕЛЬНО отдельная
// функция от validateTelegramInitData (telegram-init-data.util.ts) —
// формат подписи другой, не просто другой источник того же алгоритма:
//
// Mini App initData:      secret_key = HMAC-SHA256("WebAppData", bot_token)
// Login Widget payload:   secret_key = SHA256(bot_token)  (обычный хэш, не HMAC)
//
// Обе схемы затем считают hash = HMAC-SHA256(secret_key, data-check-string),
// но secret_key получен по-разному — перепутать один шаг достаточно,
// чтобы валидация тихо ломалась на реальных данных, поэтому это две
// раздельные, не переиспользующие друг друга реализации.
// Официальная спецификация: https://core.telegram.org/widgets/login#checking-authorization

import { createHash, createHmac, timingSafeEqual } from 'crypto';

export interface TelegramLoginWidgetPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export interface ParsedTelegramLoginWidgetPayload {
  id: number;
  firstName?: string;
  username?: string;
  photoUrl?: string;
  authDate: Date;
}

export class TelegramLoginWidgetInvalidError extends Error {
  constructor(reason: string) {
    super(`Invalid Telegram Login Widget payload: ${reason}`);
    this.name = 'TelegramLoginWidgetInvalidError';
  }
}

export interface TelegramLoginWidgetValidationOptions {
  botToken: string;
  /** Максимальный возраст payload в секундах — та же защита от replay,
   * что уже применяется к initData (telegram-init-data.util.ts),
   * тот же класс решения, независимая константа по умолчанию. */
  maxAgeSeconds?: number;
}

function buildDataCheckString(payload: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const key of Object.keys(payload).sort()) {
    if (key === 'hash') continue;
    const value = payload[key];
    if (value === undefined || value === null) continue; // отсутствующие опциональные поля не входят в строку
    pairs.push(`${key}=${value}`);
  }
  return pairs.join('\n');
}

/** Constant-time сравнение — тот же фикс, что применён сегодня к
 * Mini App initData (telegram-init-data.util.ts): plain `!==` на хешах
 * теоретически течёт тайминг-сигнал о том, на каком байте разошлось
 * сравнение. Хеши разной длины (испорченный hash) — заведомо не
 * совпадают; timingSafeEqual сам бросил бы на разной длине, поэтому
 * длина проверяется явно до вызова. */
function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && bufA.length > 0 && timingSafeEqual(bufA, bufB);
}

export function validateTelegramLoginWidgetPayload(
  payload: TelegramLoginWidgetPayload,
  options: TelegramLoginWidgetValidationOptions,
): ParsedTelegramLoginWidgetPayload {
  const { botToken, maxAgeSeconds = 86400 } = options;

  if (!payload || typeof payload !== 'object') {
    throw new TelegramLoginWidgetInvalidError('empty payload');
  }
  if (!payload.hash) {
    throw new TelegramLoginWidgetInvalidError('missing hash');
  }
  if (!payload.id || !payload.auth_date) {
    throw new TelegramLoginWidgetInvalidError('missing id/auth_date');
  }

  const dataCheckString = buildDataCheckString(payload as unknown as Record<string, unknown>);
  const secretKey = createHash('sha256').update(botToken).digest(); // SHA256, НЕ HMAC — отличие от initData
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (!hashesEqual(expectedHash, payload.hash)) {
    throw new TelegramLoginWidgetInvalidError('hash mismatch');
  }

  const authDate = new Date(payload.auth_date * 1000);
  const ageSeconds = (Date.now() - authDate.getTime()) / 1000;
  if (ageSeconds > maxAgeSeconds) {
    throw new TelegramLoginWidgetInvalidError(`payload too old (${Math.round(ageSeconds)}s > ${maxAgeSeconds}s)`);
  }
  if (ageSeconds < -60) {
    // небольшой допуск на рассинхронизацию часов клиента, тот же
    // принцип защиты от подделанной даты "из будущего", что не
    // применялся к initData (там доверенный источник — сам Telegram
    // WebView), но здесь payload проходит через обычный браузер клиента.
    throw new TelegramLoginWidgetInvalidError('auth_date is in the future');
  }

  return {
    id: payload.id,
    firstName: payload.first_name,
    username: payload.username,
    photoUrl: payload.photo_url,
    authDate,
  };
}

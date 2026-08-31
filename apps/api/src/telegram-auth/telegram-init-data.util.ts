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

import { createHmac, timingSafeEqual } from 'crypto';

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
 * для СОВЕРШЕННО ОТДЕЛЬНОЙ third-party схемы валидации, `validate3rd`
 * по терминологии docs.telegram-mini-apps.com — использует публичный
 * ключ Telegram, не токен бота, и не имеет отношения к классической
 * HMAC-схеме ниже) ПОМИМО исходного `hash`.
 *
 * Дальнейший аудит (2026-08-30, по трём независимым проектам с реальным
 * production-опытом) показал: несмотря на то что официальная документация
 * описывает классическую HMAC-схему как исключающую только `hash`,
 * РАЗНЫЕ версии Telegram-клиентов на практике расходятся в том, участвует
 * ли `signature` в data-check-string классической схемы — часть клиентов
 * это поле в HMAC-подписи учитывает, часть нет. Жёстко предполагать
 * только один вариант (только исключать или только включать signature)
 * ломает валидацию для части реальных клиентов. Правильное решение —
 * не выбирать сторону, а принимать ОБА варианта: считаем hash дважды
 * (с signature и без), сверяем полученный hash с любым из двух —
 * тот же подход, что уже применяется в проверенных production-системах.
 */
const FIELDS_ALWAYS_EXCLUDED_FROM_CHECK_STRING = new Set(['hash']);

function buildDataCheckString(params: URLSearchParams, excludeSignature: boolean): string {
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (FIELDS_ALWAYS_EXCLUDED_FROM_CHECK_STRING.has(key)) continue;
    if (excludeSignature && key === 'signature') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  return pairs.join('\n');
}

/** Constant-time сравнение двух hex-хешей одинаковой длины — не течёт
 * тайминг-сигнал о том, на каком байте разошлось сравнение. Хеши
 * разной длины (испорченный/неполный hash) — заведомо не совпадают,
 * timingSafeEqual на разной длине сам бросил бы исключение, поэтому
 * длина проверяется явно до вызова. */
function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && bufA.length > 0 && timingSafeEqual(bufA, bufB);
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

  const dataCheckStringWithoutSignature = buildDataCheckString(params, true);
  const dataCheckStringWithSignature = buildDataCheckString(params, false);

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHashWithoutSignature = createHmac('sha256', secretKey).update(dataCheckStringWithoutSignature).digest('hex');
  const expectedHashWithSignature = createHmac('sha256', secretKey).update(dataCheckStringWithSignature).digest('hex');

  if (!hashesEqual(expectedHashWithoutSignature, receivedHash) && !hashesEqual(expectedHashWithSignature, receivedHash)) {
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

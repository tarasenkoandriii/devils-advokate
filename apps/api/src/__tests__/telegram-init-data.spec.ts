// Чекпоинт 1, пункт 11 — sanity-тест для validateTelegramInitData.
// Строит валидный initData вручную (тем же алгоритмом, что и сама
// функция валидации, но независимо реализованным здесь), чтобы
// проверить, что валидация принимает корректные данные и отклоняет
// испорченные — включая специфичный кейс с полем `signature`
// (см. комментарий в telegram-init-data.util.ts).

import { createHmac } from 'crypto';
import {
  validateTelegramInitData,
  TelegramInitDataInvalidError,
} from '../telegram-auth/telegram-init-data.util';

const BOT_TOKEN = 'test-bot-token-123456';

function buildValidInitData(overrides: Record<string, string> = {}): string {
  const authDate = Math.floor(Date.now() / 1000).toString();
  const user = JSON.stringify({ id: 42, first_name: 'Test', username: 'testuser' });

  const fields: Record<string, string> = {
    auth_date: authDate,
    user,
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    ...overrides,
  };

  const dataCheckString = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

describe('validateTelegramInitData', () => {
  it('принимает корректно подписанные данные', () => {
    const initData = buildValidInitData();
    const result = validateTelegramInitData(initData, { botToken: BOT_TOKEN });
    expect(result.user.id).toBe(42);
    expect(result.user.username).toBe('testuser');
  });

  it('отклоняет данные с неверным hash', () => {
    const initData = buildValidInitData().replace(/hash=[a-f0-9]+/, 'hash=deadbeef');
    expect(() =>
      validateTelegramInitData(initData, { botToken: BOT_TOKEN }),
    ).toThrow(TelegramInitDataInvalidError);
  });

  it('отклоняет данные без hash', () => {
    const params = new URLSearchParams(buildValidInitData());
    params.delete('hash');
    expect(() =>
      validateTelegramInitData(params.toString(), { botToken: BOT_TOKEN }),
    ).toThrow(/missing hash/);
  });

  it('отклоняет устаревшие данные (auth_date старше maxAgeSeconds)', () => {
    const oldAuthDate = (Math.floor(Date.now() / 1000) - 100000).toString();
    const initData = buildValidInitData({ auth_date: oldAuthDate });
    expect(() =>
      validateTelegramInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 86400 }),
    ).toThrow(/too old/);
  });

  it('регрессия на баг с полем signature: наличие signature не должно ломать валидный hash, если signature корректно исключён из data-check-string', () => {
    // Строим initData, где hash посчитан БЕЗ учёта signature (как того
    // требует спецификация — signature не участвует в data-check-string),
    // но само поле signature присутствует в query string.
    const authDate = Math.floor(Date.now() / 1000).toString();
    const user = JSON.stringify({ id: 7, first_name: 'Sig' });
    const fields = { auth_date: authDate, user };

    const dataCheckString = Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    const params = new URLSearchParams({
      ...fields,
      signature: 'some-ed25519-signature-value',
      hash,
    });

    const result = validateTelegramInitData(params.toString(), { botToken: BOT_TOKEN });
    expect(result.user.id).toBe(7);
  });
});

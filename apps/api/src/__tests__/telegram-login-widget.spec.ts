import {
  validateTelegramLoginWidgetPayload,
  TelegramLoginWidgetInvalidError,
  TelegramLoginWidgetPayload,
} from '../telegram-auth/telegram-login-widget.util';

const BOT_TOKEN = 'test-bot-token-12345';

// Фикстуры сгенерированы отдельным скриптом по тому же алгоритму, что
// сам валидатор (SHA256(bot_token) как secret_key, НЕ HMAC-SHA256
// ("WebAppData", bot_token), как у initData) — так acceptance-проверка
// реально доказывает совместимость с официальным алгоритмом Telegram
// Login Widget, не просто "функция согласна сама с собой".
const VALID_FRESH: TelegramLoginWidgetPayload = {
  id: 987654321,
  first_name: 'Andrii',
  username: 'andrii_test',
  auth_date: 1786844585,
  hash: '13316922b9e709185e52af9402a71461a89966f119f75fb556942f674369f9ea',
};

describe('validateTelegramLoginWidgetPayload', () => {
  let nowSpy: jest.SpyInstance;

  beforeEach(() => {
    // Фиксируем "текущее время" рядом с auth_date фикстуры, чтобы
    // тест не протух через реальное время выполнения CI.
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1786844585_000 + 5000);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('принимает валидный payload с корректной подписью', () => {
    const parsed = validateTelegramLoginWidgetPayload(VALID_FRESH, { botToken: BOT_TOKEN });
    expect(parsed.id).toBe(987654321);
    expect(parsed.firstName).toBe('Andrii');
    expect(parsed.username).toBe('andrii_test');
  });

  it('отклоняет payload с испорченным hash', () => {
    const tampered = { ...VALID_FRESH, hash: 'f'.repeat(64) };
    expect(() => validateTelegramLoginWidgetPayload(tampered, { botToken: BOT_TOKEN })).toThrow(
      TelegramLoginWidgetInvalidError,
    );
  });

  it('отклоняет payload, подписанный другим bot token', () => {
    expect(() =>
      validateTelegramLoginWidgetPayload(VALID_FRESH, { botToken: 'wrong-bot-token' }),
    ).toThrow(TelegramLoginWidgetInvalidError);
  });

  it('отклоняет payload с изменённым полем после подписи (id подменён)', () => {
    const tampered = { ...VALID_FRESH, id: 111111111 };
    expect(() => validateTelegramLoginWidgetPayload(tampered, { botToken: BOT_TOKEN })).toThrow(
      TelegramLoginWidgetInvalidError,
    );
  });

  it('отклоняет payload старше maxAgeSeconds — защита от replay', () => {
    nowSpy.mockReturnValue(1786844585_000 + 90_000 * 1000);
    expect(() => validateTelegramLoginWidgetPayload(VALID_FRESH, { botToken: BOT_TOKEN })).toThrow(
      TelegramLoginWidgetInvalidError,
    );
  });

  it('отклоняет payload с auth_date из будущего (подделанная дата клиента)', () => {
    nowSpy.mockReturnValue(1786844585_000 - 120_000);
    expect(() => validateTelegramLoginWidgetPayload(VALID_FRESH, { botToken: BOT_TOKEN })).toThrow(
      TelegramLoginWidgetInvalidError,
    );
  });

  it('отклоняет payload без hash', () => {
    const { hash, ...withoutHash } = VALID_FRESH;
    expect(() =>
      validateTelegramLoginWidgetPayload(withoutHash as TelegramLoginWidgetPayload, { botToken: BOT_TOKEN }),
    ).toThrow(TelegramLoginWidgetInvalidError);
  });

  it('РЕГРЕСІЯ (аудит Telegram initData 2026-08-30, поширено на Login Widget для внутрішньої консистентності): hash іншої довжини (укорочений/пошкоджений) відхиляється, не падає з винятком timingSafeEqual', () => {
    const tampered = { ...VALID_FRESH, hash: 'deadbeef' }; // 8 символів, не 64 — коротший за справжній SHA256-hex
    expect(() => validateTelegramLoginWidgetPayload(tampered, { botToken: BOT_TOKEN })).toThrow(
      TelegramLoginWidgetInvalidError,
    );
  });
});

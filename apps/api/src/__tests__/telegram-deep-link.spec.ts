// Пункт [deep-links] 2026-09-02 — ссылки-приглашения.
//
// Найдено аудитом: четыре эндпоинта возвращали пользователю
// `t.me/<bot>?start=…` с ЛИТЕРАЛОМ `<bot>`. Токен при этом создавался и
// тикал 72 часа — рекрутер получал рабочий на вид, но мёртвый адрес.
import { ServiceUnavailableException } from '@nestjs/common';
import { buildStartDeepLink } from '../common/telegram-deep-link';

describe('buildStartDeepLink', () => {
  it('прямая ссылка на Mini App использует startapp', () => {
    const link = buildStartDeepLink('share_abc', {
      TELEGRAM_MINI_APP_URL: 'https://t.me/da_bot/app',
    } as NodeJS.ProcessEnv);
    expect(link).toBe('https://t.me/da_bot/app?startapp=share_abc');
  });

  it('ссылка на бота использует start', () => {
    const link = buildStartDeepLink('team_abc', {
      TELEGRAM_BOT_USERNAME: 'da_bot',
    } as NodeJS.ProcessEnv);
    expect(link).toBe('https://t.me/da_bot?start=team_abc');
  });

  it('Mini App имеет приоритет: открывает приложение без экрана чата', () => {
    const link = buildStartDeepLink('share_abc', {
      TELEGRAM_MINI_APP_URL: 'https://t.me/da_bot/app',
      TELEGRAM_BOT_USERNAME: 'da_bot',
    } as NodeJS.ProcessEnv);
    expect(link).toContain('startapp=');
  });

  it('@ в юзернейме и слэш на конце — обычный способ ввода, не ошибка', () => {
    expect(buildStartDeepLink('x', { TELEGRAM_BOT_USERNAME: '@da_bot' } as NodeJS.ProcessEnv)).toBe(
      'https://t.me/da_bot?start=x',
    );
    expect(
      buildStartDeepLink('x', { TELEGRAM_MINI_APP_URL: 'https://t.me/da_bot/app/' } as NodeJS.ProcessEnv),
    ).toBe('https://t.me/da_bot/app?startapp=x');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: без окружения — 503 с именем переменной, а не битая ссылка', () => {
    // Прежнее поведение — вернуть «t.me/<bot>?start=…» и промолчать —
    // выглядело как рабочая фича. Отказ фичи не должен выглядеть
    // рабочим, ровно как пробел конфигурации не должен выглядеть
    // отказом провайдера.
    try {
      buildStartDeepLink('share_abc', {} as NodeJS.ProcessEnv);
      fail('должно было бросить');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      expect((e as Error).message).toContain('TELEGRAM_BOT_USERNAME');
      expect((e as Error).message).toContain('TELEGRAM_MINI_APP_URL');
    }
  });

  it('недопустимая нагрузка — ошибка кода, а не тихая склейка', () => {
    expect(() =>
      buildStartDeepLink('share abc!', { TELEGRAM_BOT_USERNAME: 'da_bot' } as NodeJS.ProcessEnv),
    ).toThrow(/Недопустимая нагрузка/);
  });
});

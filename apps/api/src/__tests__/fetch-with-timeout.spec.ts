// Пункт [external-timeouts] 2026-09-01 — общий таймаут внешних
// вызовов (закрывает пункт отчёта аудита «ни один внешний вызов не
// имеет таймаута») + не-ретрай 4xx у AI-провайдеров.

import { fetchWithTimeout, FetchTimeoutError, DEFAULT_EXTERNAL_TIMEOUT_MS } from '../common/fetch-with-timeout';
import { ProviderHttpError } from '../ai-router/ai-provider-client';

afterEach(() => {
  (global as any).fetch = undefined;
  jest.useRealTimers();
});

describe('fetchWithTimeout', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: зависший провайдер обрывается FetchTimeoutError, в сообщении НЕТ query-строки (там живут API-ключи)', async () => {
    (global as any).fetch = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          // «Висящий» ответ: завершается только abort'ом.
          init.signal!.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        }),
    );

    const promise = fetchWithTimeout('https://factchecktools.googleapis.com/v1alpha1/claims:search?key=SECRET-KEY&query=x', {}, 50);
    await expect(promise).rejects.toBeInstanceOf(FetchTimeoutError);
    await expect(
      fetchWithTimeout('https://factchecktools.googleapis.com/v1alpha1/claims:search?key=SECRET-KEY&query=x', {}, 50),
    ).rejects.toThrow(/claims:search/);
    await expect(
      fetchWithTimeout('https://factchecktools.googleapis.com/v1alpha1/claims:search?key=SECRET-KEY&query=x', {}, 50),
    ).rejects.not.toThrow(/SECRET-KEY/);
  });

  it('успешный ответ проходит как есть; чужая сетевая ошибка НЕ переупаковывается в таймаут', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    const res = await fetchWithTimeout('https://example.com/api', {});
    expect(res.status).toBe(200);
    // signal передан внутрь настоящего fetch
    expect(((global as any).fetch as jest.Mock).mock.calls[0][1].signal).toBeDefined();

    (global as any).fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchWithTimeout('https://example.com/api', {})).rejects.toThrow('ECONNREFUSED');
    expect(DEFAULT_EXTERNAL_TIMEOUT_MS).toBe(15_000);
  });
});

describe('ProviderHttpError.isRetryable', () => {
  it('429 и 5xx — ретраебельны; 400/401/403/404 — нет (не станут успехом со второй попытки)', () => {
    expect(new ProviderHttpError('X', 429, 'm').isRetryable).toBe(true);
    expect(new ProviderHttpError('X', 500, 'm').isRetryable).toBe(true);
    expect(new ProviderHttpError('X', 503, 'm').isRetryable).toBe(true);
    expect(new ProviderHttpError('X', 400, 'm').isRetryable).toBe(false);
    expect(new ProviderHttpError('X', 401, 'm').isRetryable).toBe(false);
    expect(new ProviderHttpError('X', 403, 'm').isRetryable).toBe(false);
    expect(new ProviderHttpError('X', 404, 'm').isRetryable).toBe(false);
  });
});

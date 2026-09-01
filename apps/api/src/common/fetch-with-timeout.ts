// Пункт [external-timeouts] 2026-09-01 — закрывает пункт отчёта
// аудита «ни один внешний вызов не имеет таймаута (кроме
// safe-url-fetch)»: зависший провайдер раньше держал функцию до
// платформенного 504, оставляя AIJob в RUNNING, а разговор — в
// TRANSCRIBING. Один общий помощник вместо 27 разрозненных
// AbortController'ов; safe-url-fetch сохраняет собственный (у него
// свои SSRF-требования и свой потолок).
//
// Выбор дефолта: 15 с — заведомо больше честного p99 всех наших
// внешних API на «обычных» вызовах и заведомо меньше maxDuration 60,
// чтобы после таймаута оставалось время записать ошибку в БД и отдать
// ответ. Долгие вызовы (LLM-completion, синтез речи, OCR, загрузка в
// blob) передают свой потолок третьим аргументом явно.

export const DEFAULT_EXTERNAL_TIMEOUT_MS = 15_000;

export class FetchTimeoutError extends Error {
  constructor(
    public readonly url: string,
    public readonly timeoutMs: number,
  ) {
    // В сообщение идёт URL БЕЗ query-строки: у части наших вызовов
    // API-ключ живёт в query (Fact Check, YouTube, Vision) — сообщение
    // об ошибке попадает в логи/partialResult и не должно нести секрет.
    super(`Внешний вызов не ответил за ${timeoutMs} мс: ${url}`);
    this.name = 'FetchTimeoutError';
  }
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // Отличаем НАШ таймаут от чужого AbortError/сетевой ошибки по
    // факту сработавшего контроллера, не по тексту ошибки.
    if (controller.signal.aborted) {
      throw new FetchTimeoutError(stripQuery(url), timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

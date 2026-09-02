// Единая точка правды для ссылки на бота — используется в Hero и
// FinalCTA. Плейсхолдер по умолчанию, чтобы страница не падала при
// сборке без .env — реальный юзернейм бота подставляется через
// NEXT_PUBLIC_TELEGRAM_BOT_URL при деплое (см. .env.example).
export const TELEGRAM_URL = process.env.NEXT_PUBLIC_TELEGRAM_BOT_URL ?? 'https://t.me/';

/**
 * Пункт [job-landing-attribution] 2026-09-02 — ИСПРАВЛЕНИЕ АУДИТА.
 *
 * Было: параметр всегда клеился как `?start=`. Но `?start=` работает
 * только для ссылки НА БОТА (`t.me/<bot>`), а в .env.example проекта
 * стоит прямая ссылка на Mini App (`t.me/<bot>/<app>`) — для неё
 * Telegram передаёт параметр запуска ТОЛЬКО как `?startapp=`, а `start`
 * молча игнорирует. То есть вся атрибуция §4 ТЗ (jobs_landing /
 * recruiting_landing) до приложения не доезжала вовсе, хотя §7 п.1 уже
 * записал этот пункт исправленным.
 *
 * Теперь имя параметра выбирается по ФОРМЕ ссылки, а не по надежде.
 */
export function telegramStartParamName(url: string): 'start' | 'startapp' {
  const path = url.replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '').replace(/[?#].*$/, '');
  const segments = path.split('/').filter(Boolean);
  // t.me/<bot>/<app> — прямая ссылка на Mini App; t.me/<bot> — на бота.
  return segments.length >= 2 ? 'startapp' : 'start';
}

/**
 * Telegram принимает в параметре запуска только [A-Za-z0-9_-] и не
 * более 64 символов. Всё, что не проходит, ОТБРАСЫВАЕТСЯ целиком, а не
 * калечится: обрезанная метка хуже отсутствующей — она выглядит как
 * данные, но считает не то.
 */
export function sanitizeStartPayload(payload: string): string | null {
  // Ревью 2026-09-02: раньше здесь стояла ЗАЧИСТКА символов, и она
  // противоречила комментарию выше: «google/ads» превращалось в
  // «googleads», а «яндекс» — в пустую кампанию, которая доехала бы до
  // базы как «источник есть, но какой — неизвестно». Проверяем целиком.
  if (!payload || payload.length > 64) return null;
  return /^[A-Za-z0-9_-]+$/.test(payload) ? payload : null;
}

/**
 * Deep-link с параметром запуска (кандидат/агентство с /jobs).
 * Плейсхолдер без юзернейма бота параметр не получает —
 * «t.me/?start=…» вёл бы в никуда; честнее чистая ссылка.
 *
 * `campaign` — необязательная метка источника рекламы (utm_source),
 * приклеивается через `__`: `jobs_landing__google`. Разбирает её в TMA
 * `parseStartPayload` (apps/tma/src/lib/start-param.ts) — формат общий
 * для двух приложений, менять только парой.
 */
export function telegramStartUrl(start: string, campaign?: string | null): string {
  const base = TELEGRAM_URL.replace(/\/+$/, '');
  // NEXT_PUBLIC_TELEGRAM_BOT_URL не задан → плейсхолдер 'https://t.me/'
  // (после среза слэша — без пути): параметр добавлять некуда.
  if (!/t\.me\/.+/.test(base)) return TELEGRAM_URL;

  const payload = (campaign && sanitizeStartPayload(`${start}__${campaign}`)) || start;
  return `${base}?${telegramStartParamName(base)}=${encodeURIComponent(payload)}`;
}

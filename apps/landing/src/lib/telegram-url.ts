// Единая точка правды для ссылки на бота — используется в Hero и
// FinalCTA. Плейсхолдер по умолчанию, чтобы страница не падала при
// сборке без .env — реальный юзернейм бота подставляется через
// NEXT_PUBLIC_TELEGRAM_BOT_URL при деплое (см. .env.example).
export const TELEGRAM_URL = process.env.NEXT_PUBLIC_TELEGRAM_BOT_URL ?? 'https://t.me/';

// Пункт [job-landing] 2026-09-01 — deep-link со start-параметром
// (кандидат/агентство с /jobs). Плейсхолдер без юзернейма бота параметр
// не получает — «t.me/?start=…» вёл бы в никуда; честнее чистая ссылка.
export function telegramStartUrl(start: string): string {
  const base = TELEGRAM_URL.replace(/\/+$/, '');
  // NEXT_PUBLIC_TELEGRAM_BOT_URL не задан → плейсхолдер 'https://t.me/'
  // (после среза слэша — без пути): параметр добавлять некуда.
  if (!/t\.me\/.+/.test(base)) return TELEGRAM_URL;
  return `${base}?start=${encodeURIComponent(start)}`;
}

// Инцидент деплоя 2026-09-02: сборка лендинга на Vercel упала на ВСЕХ
// страницах — `Export encountered errors on following paths: /[lang]/…`.
// Причина: `metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL)` в
// layout, а переменная задана без протокола (`devils-advocate.example.com`).
// `new URL('host')` бросает TypeError: Invalid URL — на каждом prerender,
// и сборка падает целиком. Один неточно заданный env убивал весь сайт,
// хотя ни одна страница от него по смыслу не зависит (это база для
// абсолютных ссылок OG/sitemap).
//
// Принцип проекта: пробел конфигурации не должен выглядеть как отказ.
// Здесь: значение НОРМАЛИЗУЕТСЯ (обрезка пробелов, добавление https://,
// снятие хвостового слэша), а если и после этого невалидно — предупреждение
// в лог сборки и запасное значение, но не падение. Одна функция на четыре
// точки использования (layout, sitemap, robots, JSON-LD страницы /jobs) —
// раньше у каждой была своя копия `?? 'https://example.com'`.

export const FALLBACK_SITE_URL = 'https://example.com';

/** Нормализация значения переменной. Экспортирована ради теста. */
export function normalizeSiteUrl(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return FALLBACK_SITE_URL;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return FALLBACK_SITE_URL;
    // origin + путь без хвостового слэша: sitemap клеит `${base}/${lang}`.
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return FALLBACK_SITE_URL;
  }
}

let warned = false;

/** Публичный адрес сайта: NEXT_PUBLIC_SITE_URL, нормализованный. */
export function siteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  const normalized = normalizeSiteUrl(raw);
  if (raw && normalized === FALLBACK_SITE_URL && !warned) {
    warned = true;
    console.warn(
      `[landing] NEXT_PUBLIC_SITE_URL="${raw}" не является валидным адресом — ` +
        `для абсолютных ссылок (OG, sitemap, canonical) взято ${FALLBACK_SITE_URL}. ` +
        'Задайте полный адрес с https:// и без слэша на конце.',
    );
  }
  return normalized;
}

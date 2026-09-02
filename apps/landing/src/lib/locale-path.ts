import { locales, type Locale } from './i18n/config';

/**
 * Путь той же страницы в другой локали.
 *
 * АУДИТ 2026-09-02: переключатель уводил на КОРЕНЬ локали. С /ru/jobs
 * выбор «UK» открывал /uk — то есть на второй языковой странице
 * продукта смена языка теряла саму страницу, при том что hreflang
 * обещает краулеру /uk/jobs. Меняется только первый сегмент пути.
 *
 * Аудит 2026-09-02 (job-landing), вторая правка: query сохраняется —
 * utm_* с рекламной ссылки терялись при смене языка, и переход в
 * Telegram уходил без кампании (атрибуция IntakeSession.campaign —
 * Приложение А ТЗ).
 */
export function withLocale(pathname: string | null, locale: Locale, search = ''): string {
  const query = search ? (search.startsWith('?') ? search : `?${search}`) : '';
  if (!pathname) return `/${locale}${query}`;
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return `/${locale}${query}`;
  const rest = (locales as readonly string[]).includes(segments[0]) ? segments.slice(1) : segments;
  return `/${[locale, ...rest].join('/')}${query}`;
}

import { NextRequest, NextResponse } from 'next/server';
import { locales, defaultLocale, type Locale } from './lib/i18n/config';

// Тот же паттерн, что уже отработан в BTW/Volia: middleware геодетекции
// по заголовку Vercel (x-vercel-ip-country, доступен только на проде на
// Vercel, не в локальной разработке), с fallback на Accept-Language,
// затем на дефолтную локаль. Явный маппинг страна→язык, не пытаемся
// угадывать по континенту/языковой семье.
const COUNTRY_TO_LOCALE: Partial<Record<string, Locale>> = {
  UA: 'uk',
  RU: 'ru',
  BY: 'ru',
  KZ: 'ru',
};

function resolveLocale(request: NextRequest): Locale {
  const country = request.headers.get('x-vercel-ip-country') ?? '';
  const geoLocale = COUNTRY_TO_LOCALE[country];
  if (geoLocale) return geoLocale;

  // ПОВТОРНЫЙ АУДИТ 2026-08-30: раньше здесь было
  // `locales.find((l) => acceptLanguage.includes(l))` — поиск подстроки
  // в порядке массива locales = ['en','uk','ru']. Для украинского
  // браузера с "uk-UA,uk;q=0.9,en-US;q=0.8" первым совпадал 'en'
  // (подстрока в заголовке присутствует), и пользователь получал
  // английскую версию. Вне Vercel (или при x-vercel-ip-country=XX) это
  // единственный работающий путь определения языка, то есть ошибка
  // затрагивала всех, кто не попал в маппинг стран выше.
  //
  // Теперь заголовок разбирается по спецификации: пары "язык;q=вес",
  // сортировка по убыванию веса, сопоставление по префиксу до дефиса.
  const acceptLanguage = (request.headers.get('accept-language') ?? '').toLowerCase();
  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((entry) => entry.tag.length > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const primary = tag.split('-')[0];
    const match = locales.find((locale) => locale === primary);
    if (match) return match;
  }

  return defaultLocale;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const pathnameHasLocale = locales.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`),
  );
  if (pathnameHasLocale) return;

  const locale = resolveLocale(request);
  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next|images|favicon.ico|robots.txt|sitemap.xml).*)'],
};

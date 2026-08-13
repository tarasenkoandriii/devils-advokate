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

  const acceptLanguage = (request.headers.get('accept-language') ?? '').toLowerCase();
  const langMatch = locales.find((locale) => acceptLanguage.includes(locale));
  if (langMatch) return langMatch;

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

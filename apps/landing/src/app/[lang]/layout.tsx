import type { Metadata } from 'next';
import { ReactNode } from 'react';
import { Unbounded, Inter } from 'next/font/google';
import { locales, ogLocales, defaultLocale, type Locale } from '../../lib/i18n/config';
import { getDictionary } from '../../lib/i18n/get-dictionary';
import '../globals.css';

// Unbounded для дисплейного начертания — уже отработанный в других
// проектах стека выбор для поддержки кириллицы вместо Space Grotesk
// (который кириллицу не поддерживает вовсе).
const unbounded = Unbounded({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600'],
  variable: '--font-unbounded',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-inter',
  display: 'swap',
});

// Нет layout.tsx в app/ (корне) намеренно — [lang]/layout.tsx это
// эффективный root layout для всех совпадающих маршрутов (паттерн из
// официального Next.js i18n-примера). Каждый запрос к "/" уже
// перехватывается middleware.ts и получает /{locale}-префикс ДО того,
// как роутер вообще попытается найти страницу.
export function generateStaticParams() {
  return locales.map((lang) => ({ lang }));
}

export async function generateMetadata({
  params,
}: {
  params: { lang: Locale };
}): Promise<Metadata> {
  const dict = getDictionary(params.lang);
  return {
    // Аудит [landing-audit] 2026-09-01: без metadataBase Next не может
    // построить абсолютные URL для OG/Twitter-картинок — часть
    // краулеров относительные игнорирует. Fallback совпадает с
    // sitemap.ts.
    metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://example.com'),
    title: dict.meta.title,
    description: dict.meta.description,
    alternates: {
      // Аудит 2026-09-02 (job-landing): self-canonical и x-default — как у
      // /jobs, иначе три языковые копии главной конкурировали в индексе.
      canonical: `/${params.lang}`,
      languages: {
        ...Object.fromEntries(locales.map((l) => [l, `/${l}`])),
        'x-default': `/${defaultLocale}`,
      },
    },
    openGraph: {
      title: dict.meta.title,
      description: dict.meta.description,
      // og:locale ждёт language_TERRITORY (ru_RU), не голый код языка —
      // на /jobs это было исправлено 2026-09-02, здесь оставалось.
      locale: ogLocales[params.lang],
      type: 'website',
      // ПОВТОРНЫЙ АУДИТ 2026-08-30: здесь стоял /images/hero.png —
      // файла с таким именем в public/images нет (есть hero-courtroom,
      // hero-hell, hero-lawyer, hero-slogan). Любой репост ссылки в
      // Telegram/Twitter/LinkedIn отдавал превью без картинки — для
      // лендинга, у которого расшаривание и есть основная функция, это
      // прямая потеря конверсии.
      images: ['/images/og.jpg'],
    },
    twitter: {
      card: 'summary_large_image',
      title: dict.meta.title,
      description: dict.meta.description,
      images: ['/images/og.jpg'],
    },
  };
}

export default function LangLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: { lang: Locale };
}) {
  return (
    <html lang={params.lang} className={`${unbounded.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}

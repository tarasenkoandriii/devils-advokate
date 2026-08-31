import type { Metadata } from 'next';
import { ReactNode } from 'react';
import { Unbounded, Inter } from 'next/font/google';
import { locales, type Locale } from '../../lib/i18n/config';
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
    title: dict.meta.title,
    description: dict.meta.description,
    alternates: {
      languages: Object.fromEntries(locales.map((l) => [l, `/${l}`])),
    },
    openGraph: {
      title: dict.meta.title,
      description: dict.meta.description,
      locale: params.lang,
      type: 'website',
      // ПОВТОРНЫЙ АУДИТ 2026-08-30: здесь стоял /images/hero.png —
      // файла с таким именем в public/images нет (есть hero-courtroom,
      // hero-hell, hero-lawyer, hero-slogan). Любой репост ссылки в
      // Telegram/Twitter/LinkedIn отдавал превью без картинки — для
      // лендинга, у которого расшаривание и есть основная функция, это
      // прямая потеря конверсии.
      images: ['/images/hero-courtroom.png'],
    },
    twitter: {
      card: 'summary_large_image',
      title: dict.meta.title,
      description: dict.meta.description,
      images: ['/images/hero-courtroom.png'],
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

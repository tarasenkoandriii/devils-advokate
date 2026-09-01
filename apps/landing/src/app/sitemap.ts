import type { MetadataRoute } from 'next';
import { locales } from '../lib/i18n/config';

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://example.com';

  // Пункт [job-landing] 2026-09-01: страница /{lang}/jobs — вторая
  // индексируемая страница на каждый язык.
  const pages = ['', '/jobs'];
  return pages.flatMap((page) =>
    locales.map((locale) => ({
      url: `${baseUrl}/${locale}${page}`,
      lastModified: new Date(),
      alternates: {
        languages: Object.fromEntries(locales.map((l) => [l, `${baseUrl}/${l}${page}`])),
      },
    })),
  );
}

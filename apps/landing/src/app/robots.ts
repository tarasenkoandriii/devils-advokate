import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
    // Аудит [landing-audit] 2026-09-01: fallback единый с sitemap.ts —
    // пустая строка отдавала бесхостный '/sitemap.xml' в robots.txt.
    sitemap: `${process.env.NEXT_PUBLIC_SITE_URL ?? 'https://example.com'}/sitemap.xml`,
  };
}

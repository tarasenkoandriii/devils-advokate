import type { MetadataRoute } from 'next';
import { siteUrl } from '../lib/site-url';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
    // Аудит [landing-audit] 2026-09-01: fallback единый с sitemap.ts —
    // пустая строка отдавала бесхостный '/sitemap.xml' в robots.txt.
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}

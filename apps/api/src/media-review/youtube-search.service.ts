// Пункт [media-review] (devils-advocate-media-review-tz.md §2.1):
// YouTubeSearchService — обгортка над офіційним YouTube Data API v3
// (search.list). Легальний, документований шлях — на відміну від
// завантаження самого відео (§2.2 ТЗ, свідомо виключено), пошук
// метаданих через офіційний API жодних юридичних застережень не має.
//
// НІЧОГО, КРІМ МЕТАДАНИХ — videoId/title/channelName/thumbnailUrl/
// duration/publishedAt. Жодного відео/аудіо контенту, жодного тексту
// самого ролика (субтитри — окремий, відхилений шлях, §2.2a ТЗ).
//
// КВОТА — РЕАЛЬНЕ ОБМЕЖЕННЯ, НЕ ДРІБНИЦЯ (§2.1 ТЗ): search.list
// коштує 100 quota-одиниць з денного ліміту 10 000 на Google Cloud
// проєкт — ~100 запитів/добу МАКСИМУМ на весь проєкт, не на
// користувача. DAILY_LIMIT_PER_USER нижче — застосунковий rate-limit
// ЗВЕРХУ на це (не окремий від квоти Google, а щоб один активний
// користувач не з'їв усю квоту проєкту сам).

import { BadGatewayException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../secrets/secrets.service';

const YOUTUBE_API_KEY_REF = 'YOUTUBE_API_KEY';
const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

// Калібрується під реальну квоту Google Cloud проєкту (§5 ТЗ:
// "конкретне число — калібрується під реальну квоту, не вигадується
// наперед") — 20/добу на користувача залишає запас для кількох
// активних користувачів одночасно в межах спільної квоти 100/добу
// проєкту, не з'їдає її одним акаунтом.
const DAILY_LIMIT_PER_USER = 20;

export interface YouTubeSearchResult {
  videoId: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  durationSeconds: number | null;
  publishedAt: string | null;
}

// ISO 8601 duration (PT1H2M3S) → секунди. YouTube Data API повертає
// тривалість тільки в цьому форматі (videos.list, contentDetails.duration).
function parseIso8601Duration(iso: string): number | null {
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  const [, h, m, s] = match;
  return (Number(h ?? 0) * 3600) + (Number(m ?? 0) * 60) + Number(s ?? 0);
}

@Injectable()
export class YouTubeSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
  ) {}

  private async assertUnderRateLimit(userId: string) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.prisma.youTubeSearchLog.count({
      where: { userId, createdAt: { gte: since } },
    });
    if (count >= DAILY_LIMIT_PER_USER) {
      throw new ForbiddenException(
        `Досягнуто денний ліміт пошуку YouTube (${DAILY_LIMIT_PER_USER}/добу) — спільна квота проєкту обмежена (§2.1 ТЗ), спробуйте завтра`,
      );
    }
  }

  async search(userId: string, query: string): Promise<YouTubeSearchResult[]> {
    await this.assertUnderRateLimit(userId);

    const apiKey = await this.secrets.resolve(YOUTUBE_API_KEY_REF);

    const searchUrl = new URL(YOUTUBE_SEARCH_URL);
    searchUrl.searchParams.set('part', 'snippet');
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('maxResults', '10');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('key', apiKey);

    let searchResponse: Response;
    try {
      searchResponse = await fetch(searchUrl.toString());
    } catch {
      throw new BadGatewayException('YouTube Data API недоступний — спробуйте пізніше');
    }

    // Записуємо факт спроби пошуку ДО перевірки успішності відповіді —
    // невдалий запит все одно витрачає квоту Google (§4.1 офіційної
    // документації: "усі витрати рахуються, навіть на помилку"), тому
    // й наш rate-limit має це врахувати, не тільки успішні пошуки.
    await this.prisma.youTubeSearchLog.create({ data: { userId } });

    if (!searchResponse.ok) {
      throw new BadGatewayException(
        `YouTube Data API повернув помилку (${searchResponse.status}) — можливо вичерпано квоту проєкту`,
      );
    }

    const searchData = (await searchResponse.json()) as {
      items?: Array<{
        id: { videoId: string };
        snippet: { title: string; channelTitle: string; publishedAt: string; thumbnails: { medium?: { url: string }; default?: { url: string } } };
      }>;
    };

    const items = searchData.items ?? [];
    if (items.length === 0) return [];

    // Тривалість — окремий виклик videos.list (search.list її не
    // повертає взагалі). 1 quota-одиниця за пакетний запит на всі id
    // одразу (§2.1 ТЗ: "read окремого відео — 1 одиниця") — не по
    // одиниці на відео.
    const videoIds = items.map((i) => i.id.videoId).join(',');
    const videosUrl = new URL(YOUTUBE_VIDEOS_URL);
    videosUrl.searchParams.set('part', 'contentDetails');
    videosUrl.searchParams.set('id', videoIds);
    videosUrl.searchParams.set('key', apiKey);

    let durationByVideoId = new Map<string, number | null>();
    try {
      const videosResponse = await fetch(videosUrl.toString());
      if (videosResponse.ok) {
        const videosData = (await videosResponse.json()) as {
          items?: Array<{ id: string; contentDetails: { duration: string } }>;
        };
        durationByVideoId = new Map(
          (videosData.items ?? []).map((v) => [v.id, parseIso8601Duration(v.contentDetails.duration)]),
        );
      }
      // Помилка videos.list не фатальна для всього пошуку — метадані
      // тривалості необов'язкові для черги (§4 ТЗ: durationSeconds Int?),
      // краще віддати результати без тривалості, ніж провалити весь пошук.
    } catch {
      // те саме — м'яка деградація, не прокидаємо помилку далі
    }

    return items.map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channelName: item.snippet.channelTitle,
      thumbnailUrl: item.snippet.thumbnails.medium?.url ?? item.snippet.thumbnails.default?.url ?? '',
      durationSeconds: durationByVideoId.get(item.id.videoId) ?? null,
      publishedAt: item.snippet.publishedAt ?? null,
    }));
  }
}

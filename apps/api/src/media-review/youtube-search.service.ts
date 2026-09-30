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
import { spendLimitByKey } from '../common/spend-limits';
import { SecretsService } from '../secrets/secrets.service';
import { fetchWithTimeout } from '../common/fetch-with-timeout';

const YOUTUBE_API_KEY_REF = 'YOUTUBE_API_KEY';
const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

// Калібрується під реальну квоту Google Cloud проєкту (§5 ТЗ:
// "конкретне число — калібрується під реальну квоту, не вигадується
// наперед") — 20/добу на користувача залишає запас для кількох
// активних користувачів одночасно в межах спільної квоти 100/добу
// проєкту, не з'їдає її одним акаунтом.
/** Пункт [the-ceiling-lived-in-two-places] 2026-09-30: было зашитое
 * `20` — ВТОРАЯ КОПИЯ числа, которое реестр расходов объявляет своим.
 * Числа совпадали; правка здесь разъехалась бы с реестром и с таблицей
 * деплоя молча. Теперь значение приходит из реестра по ключу. */
const DAILY_LIMIT_PER_USER = spendLimitByKey('youtube-search');

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
export function parseIso8601Duration(iso: string): number | null {
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
        `Достигнут суточный лимит поиска YouTube (${DAILY_LIMIT_PER_USER}/сутки) — общая квота проекта ограничена (§2.1 ТЗ), попробуйте завтра`,
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
      searchResponse = await fetchWithTimeout(searchUrl.toString());
    } catch {
      throw new BadGatewayException('YouTube Data API недоступен — попробуйте позже');
    }

    // Записуємо факт спроби пошуку ДО перевірки успішності відповіді —
    // невдалий запит все одно витрачає квоту Google (§4.1 офіційної
    // документації: "усі витрати рахуються, навіть на помилку"), тому
    // й наш rate-limit має це врахувати, не тільки успішні пошуки.
    await this.prisma.youTubeSearchLog.create({ data: { userId } });

    if (!searchResponse.ok) {
      throw new BadGatewayException(
        `YouTube Data API вернул ошибку (${searchResponse.status}) — возможно, исчерпана квота проекта`,
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
    const durationByVideoId = await this.fetchDurations(
      items.map((i) => i.id.videoId),
      apiKey,
    );

    return items.map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channelName: item.snippet.channelTitle,
      thumbnailUrl: item.snippet.thumbnails.medium?.url ?? item.snippet.thumbnails.default?.url ?? '',
      durationSeconds: durationByVideoId.get(item.id.videoId) ?? null,
      publishedAt: item.snippet.publishedAt ?? null,
    }));
  }

  /** Настоящая длительность роликов — от провайдера, пакетом.
   *
   * Пункт [the-lever-took-the-clients-word] 2026-09-30. Этот вызов уже
   * существовал внутри `search()`, его результат уезжал клиенту и НА
   * СЕРВЕРЕ НЕ СОХРАНЯЛСЯ НИГДЕ: `YouTubeSearchLog` хранит только
   * `userId` и время, а `MediaReviewQueueItem.durationSeconds`
   * заполняется из тела запроса. То есть сервер получал настоящее
   * число, тут же забывал его и принимал обратно с чужих слов —
   * `@IsInt() @Min(0) @Max(43_200)` проверяет форму, а не правду.
   *
   * Вынесено в отдельный метод ради постановки задачи: `tryEnqueueAnalysis`
   * обязан спросить длительность сам. Это ОДНА единица квоты за пакетный
   * запрос против ста у `search.list`, поэтому суточный потолок поиска
   * здесь НЕ проверяется — он калиброван под цену поиска, и вешать на
   * него проверку, которая в сто раз дешевле, значило бы запретить
   * дешёвое из-за цены дорогого.
   *
   * Мягкая деградация сохранена: отказ `videos.list` даёт `null`, а не
   * исключение. Для постановки задачи `null` означает отказ («длительность
   * неизвестна — лимит стоимости проверить нечем»), и это уже было в
   * коде; для поиска — результаты без длительности. */
  async fetchDurations(videoIds: string[], apiKey?: string): Promise<Map<string, number | null>> {
    if (videoIds.length === 0) return new Map();
    const key = apiKey ?? (await this.secrets.resolve(YOUTUBE_API_KEY_REF));
    const videosUrl = new URL(YOUTUBE_VIDEOS_URL);
    videosUrl.searchParams.set('part', 'contentDetails');
    // До 50 id в одном запросе — цена всё равно одна единица.
    videosUrl.searchParams.set('id', videoIds.slice(0, 50).join(','));
    videosUrl.searchParams.set('key', key);
    try {
      const videosResponse = await fetchWithTimeout(videosUrl.toString());
      if (!videosResponse.ok) return new Map();
      const videosData = (await videosResponse.json()) as {
        items?: Array<{ id: string; contentDetails: { duration: string } }>;
      };
      return new Map((videosData.items ?? []).map((v) => [v.id, parseIso8601Duration(v.contentDetails.duration)]));
    } catch {
      // Помилка videos.list не фатальна: краще віддати результати без
      // тривалості, ніж провалити весь пошук (§4 ТЗ: durationSeconds Int?).
      return new Map();
    }
  }
}

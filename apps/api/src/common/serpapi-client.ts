// Пункт 48: serpapi-client.ts — минимальный клиент для SerpApi
// Google Reverse Image Search, сырой fetch() без SDK-пакета, тот же
// принцип, что vercel-blob.ts выше.
//
// КОНТРАКТ ПОДТВЕРЖДЁН ДОКУМЕНТАЦИЕЙ: engine=google_reverse_image,
// параметр image_url — ОБЯЗАТЕЛЬНО публично доступный URL (не
// принимает бинарную загрузку напрямую — см. обоснование этого
// архитектурного выбора над моделью PhotoVerification в schema.prisma),
// GET https://serpapi.com/search, ответ JSON с полем image_results.
// НЕ проверено вызовом против реального аккаунта SerpApi в этой
// среде — та же оговорка, что у vercel-blob.ts.

const SERPAPI_HOST = 'https://serpapi.com/search';

export interface SerpApiImageResult {
  title?: string;
  link?: string;
  source?: string;
  date?: string; // не всегда присутствует — далеко не каждый результат имеет распознаваемую дату публикации
  thumbnail?: string;
}

export class SerpApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerpApiError';
  }
}

export async function reverseImageSearch(apiKey: string, publicImageUrl: string): Promise<SerpApiImageResult[]> {
  const url = `${SERPAPI_HOST}?engine=google_reverse_image&image_url=${encodeURIComponent(publicImageUrl)}&api_key=${encodeURIComponent(apiKey)}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new SerpApiError(`Не удалось связаться с SerpApi: ${err instanceof Error ? err.message : 'неизвестная ошибка сети'}`);
  }

  if (!response.ok) {
    throw new SerpApiError(`SerpApi вернул ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (data.search_metadata?.status === 'Error') {
    throw new SerpApiError(`SerpApi: ${data.error ?? 'неизвестная ошибка поиска'}`);
  }

  const results = data.image_results;
  if (!Array.isArray(results)) return [];
  return results.map((r: any) => ({
    title: typeof r.title === 'string' ? r.title : undefined,
    link: typeof r.link === 'string' ? r.link : undefined,
    source: typeof r.source === 'string' ? r.source : undefined,
    date: typeof r.date === 'string' ? r.date : undefined,
    thumbnail: typeof r.thumbnail === 'string' ? r.thumbnail : undefined,
  }));
}

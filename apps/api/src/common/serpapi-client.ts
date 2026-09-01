// Пункт 48: serpapi-client.ts — минимальный клиент для реверс-поиска
// изображения через SerpApi, сырой fetch() без SDK-пакета, тот же
// принцип, что vercel-blob.ts выше.
//
// ФИКС (полный аудит периметров 2026-08-30, по прямому запросу — сверка
// с рабочей реализацией в silverfinance): движок engine=google_reverse_image,
// которым пользовался этот файл, БОЛЬШЕ НЕ РАБОТАЕТ. Не «устарел» —
// физически не может вернуть данные: Google с февраля 2025 всегда
// редиректит classic "search by image" на Google Lens, а собственный
// GitHub-issue SerpApi (serpapi/public-roadmap#4076, июль 2026) прямым
// текстом: "the Google Reverse Image API is no longer working". Прежний
// комментарий этого файла утверждал «контракт подтверждён документацией» —
// это было верно на момент написания, но документация SerpApi некоторое
// время продолжала описывать движок уже после того, как он перестал
// функционировать на стороне Google. Урок: «подтверждено документацией»
// не то же самое, что «подтверждено вызовом против живого API» — тесты
// этого файла мокали fetch() под старую форму ответа и не могли поймать
// разрыв. Для PhotoVerificationService (§4.4 ТЗ, проверка фото человека
// на совпадения в сети) это означало: реверс-поиск молча возвращал 0
// результатов ВСЕГДА, каждый вызов заканчивался NO_SIMILAR_IMAGES_FOUND
// — ложное чувство «не нашли повторов», а не честное «поиск не сработал».
//
// Заменено на engine=google_lens&type=visual_matches (текущий, рабочий
// путь SerpApi для реверс-поиска по изображению) — тот же движок,
// который использует silverfinance в production. Параметр URL картинки —
// `url`, не `image_url` (другое имя параметра у нового движка). Ответ —
// поле `visual_matches`, не `image_results`; поля `date` в ответе Lens
// нет вообще (Reverse Image её тоже отдавал не всегда) — оставлено в
// типе как честно всегда-`undefined`, а не выдумывается.

import { fetchWithTimeout } from '../common/fetch-with-timeout';

const SERPAPI_HOST = 'https://serpapi.com/search';

export interface SerpApiImageResult {
  title?: string;
  link?: string;
  source?: string;
  /** Google Lens не отдаёт дату публикации совпадения — поле всегда
   * undefined в реальных ответах, оставлено в типе только чтобы не
   * ломать вызывающий код (photo-verification.service.ts), который
   * честно обрабатывает отсутствие даты как null, не выдумывает. */
  date?: string;
  thumbnail?: string;
}

export class SerpApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerpApiError';
  }
}

export async function reverseImageSearch(apiKey: string, publicImageUrl: string): Promise<SerpApiImageResult[]> {
  const url = `${SERPAPI_HOST}?engine=google_lens&type=visual_matches&url=${encodeURIComponent(publicImageUrl)}&api_key=${encodeURIComponent(apiKey)}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(url);
  } catch (err) {
    throw new SerpApiError(`Не удалось связаться с SerpApi: ${err instanceof Error ? err.message : 'неизвестная ошибка сети'}`);
  }

  if (!response.ok) {
    throw new SerpApiError(`SerpApi вернул ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json(); // runtime-shape проверяется ниже; @types/node >=20.19 типизирует json() как unknown
  if (data.error) {
    throw new SerpApiError(`SerpApi: ${data.error}`);
  }
  if (data.search_metadata?.status === 'Error') {
    throw new SerpApiError(`SerpApi: ${data.search_metadata?.status ?? 'неизвестная ошибка поиска'}`);
  }

  const results = data.visual_matches;
  if (!Array.isArray(results)) return [];
  return results.map((r: any) => ({
    title: typeof r.title === 'string' ? r.title : undefined,
    link: typeof r.link === 'string' ? r.link : undefined,
    source: typeof r.source === 'string' ? r.source : undefined,
    date: undefined,
    thumbnail: typeof r.thumbnail === 'string' ? r.thumbnail : undefined,
  }));
}

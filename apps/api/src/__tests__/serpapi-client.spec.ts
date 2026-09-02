import { reverseImageSearch, SerpApiError } from '../common/serpapi-client';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

async function assertThrowsAsync(fn: () => Promise<unknown>, expectedType: any, message: string) {
  try {
    await fn();
    throw new Error(`FAIL: ${message} — expected to throw ${expectedType.name}, did not throw`);
  } catch (err: any) {
    if (!(err instanceof expectedType)) {
      throw new Error(`FAIL: ${message} — expected ${expectedType.name}, got ${err?.constructor?.name}: ${err?.message}`);
    }
  }
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void> | void][] = [];
  const test = (name: string, fn: () => Promise<void> | void) => scenarios.push([name, fn]);

  // Полный аудит периметров 2026-08-30 (по прямому запросу — сверка с
  // silverfinance) — engine=google_reverse_image перестал работать на
  // стороне Google (февраль 2025) и на стороне SerpApi (issue #4076,
  // июль 2026: "the Google Reverse Image API is no longer working").
  // Тесты ниже проверяют РЕАЛЬНО рабочий движок (google_lens), не старый.

  test('reverseImageSearch() формирует правильный URL с engine=google_lens/type=visual_matches/url/api_key', async () => {
    let capturedUrl = '';
    (global as any).fetch = async (url: string) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ search_metadata: { status: 'Success' }, visual_matches: [] }) };
    };

    await reverseImageSearch('my-key', 'https://store.public.blob.vercel-storage.com/photo.jpg');
    assertEqual(capturedUrl.includes('engine=google_lens'), true, 'РЕГРЕСІЯ: engine=google_lens — google_reverse_image більше не працює на стороні Google/SerpApi');
    assertEqual(capturedUrl.includes('type=visual_matches'), true, 'type=visual_matches указан');
    assertEqual(capturedUrl.includes('api_key=my-key'), true, 'api_key передан');
    assertEqual(capturedUrl.includes('url='), true, 'параметр называется url, не image_url — другое имя у нового движка');
    assertEqual(capturedUrl.includes(encodeURIComponent('https://store.public.blob.vercel-storage.com/photo.jpg')), true, 'url картинки корректно закодирован');
  });

  test('reverseImageSearch() возвращает пустой массив, если совпадений нет', async () => {
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ search_metadata: { status: 'Success' }, visual_matches: [] }) });
    const results2 = await reverseImageSearch('key', 'https://example.com/photo.jpg');
    assertEqual(results2, [], 'пустой массив, не падение');
  });

  test('reverseImageSearch() парсит найденные совпадения из visual_matches', async () => {
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({
        search_metadata: { status: 'Success' },
        visual_matches: [{ title: 'Похожая страница', link: 'https://example.com/article', source: 'example.com', thumbnail: 'https://example.com/t.jpg' }],
      }),
    });
    const found = await reverseImageSearch('key', 'https://example.com/photo.jpg');
    assertEqual(found.length, 1, 'один результат распознан');
    assertEqual(found[0].link, 'https://example.com/article', 'link сохранён');
    assertEqual(found[0].title, 'Похожая страница', 'title сохранён');
    assertEqual(found[0].thumbnail, 'https://example.com/t.jpg', 'thumbnail сохранён');
    assertEqual(found[0].date, undefined, 'date всегда undefined — Google Lens не отдаёт дату публикации, не выдумывается');
  });

  test('reverseImageSearch() бросает SerpApiError при верхнеуровневом data.error', async () => {
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ error: 'Invalid API key' }) });
    await assertThrowsAsync(() => reverseImageSearch('bad-key', 'https://example.com/photo.jpg'), SerpApiError, 'reverseImageSearch() при ошибке API (data.error)');
  });

  test('reverseImageSearch() бросает SerpApiError при search_metadata.status=Error (defense in depth)', async () => {
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ search_metadata: { status: 'Error' } }) });
    await assertThrowsAsync(() => reverseImageSearch('bad-key', 'https://example.com/photo.jpg'), SerpApiError, 'reverseImageSearch() при search_metadata.status=Error');
  });

  test('reverseImageSearch() бросает SerpApiError при не-ok HTTP-ответе', async () => {
    (global as any).fetch = async () => ({ ok: false, status: 429, statusText: 'Too Many Requests' });
    await assertThrowsAsync(() => reverseImageSearch('key', 'https://example.com/photo.jpg'), SerpApiError, 'reverseImageSearch() при 429');
  });

  test('reverseImageSearch() бросает SerpApiError при сетевой ошибке', async () => {
    (global as any).fetch = async () => { throw new Error('network down'); };
    await assertThrowsAsync(() => reverseImageSearch('key', 'https://example.com/photo.jpg'), SerpApiError, 'reverseImageSearch() при сетевой ошибке');
  });

  test('reverseImageSearch() не падает на некорректных полях внутри результата (защита от неожиданной формы ответа)', async () => {
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({ search_metadata: { status: 'Success' }, visual_matches: [{ title: 123, link: null }] }),
    });
    const found = await reverseImageSearch('key', 'https://example.com/photo.jpg');
    assertEqual(found[0].title, undefined, 'нестроковое поле игнорируется, не падает');
    assertEqual(found[0].link, undefined, 'null-поле игнорируется, не падает');
  });

  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  const failed = results.filter((r) => r.error);
  console.log(`\nserpapi-client: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  // Падение вне тела теста (в фейке, в модульном коде) — это
  // провал файла, а не тихий unhandled rejection.
  console.error(err);
  process.exit(1);
});

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

  test('reverseImageSearch() формирует правильный URL с engine/image_url/api_key', async () => {
    let capturedUrl = '';
    (global as any).fetch = async (url: string) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ search_metadata: { status: 'Success' }, image_results: [] }) };
    };

    await reverseImageSearch('my-key', 'https://store.public.blob.vercel-storage.com/photo.jpg');
    assertEqual(capturedUrl.includes('engine=google_reverse_image'), true, 'engine указан');
    assertEqual(capturedUrl.includes('api_key=my-key'), true, 'api_key передан');
    assertEqual(capturedUrl.includes(encodeURIComponent('https://store.public.blob.vercel-storage.com/photo.jpg')), true, 'image_url корректно закодирован');
  });

  test('reverseImageSearch() возвращает пустой массив, если совпадений нет', async () => {
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ search_metadata: { status: 'Success' }, image_results: [] }) });
    const results2 = await reverseImageSearch('key', 'https://example.com/photo.jpg');
    assertEqual(results2, [], 'пустой массив, не падение');
  });

  test('reverseImageSearch() парсит найденные совпадения', async () => {
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({
        search_metadata: { status: 'Success' },
        image_results: [{ title: 'Похожая страница', link: 'https://example.com/article', source: 'example.com', date: '2024-03-01' }],
      }),
    });
    const found = await reverseImageSearch('key', 'https://example.com/photo.jpg');
    assertEqual(found.length, 1, 'один результат распознан');
    assertEqual(found[0].link, 'https://example.com/article', 'link сохранён');
    assertEqual(found[0].date, '2024-03-01', 'date сохранена');
  });

  test('reverseImageSearch() бросает SerpApiError при search_metadata.status=Error', async () => {
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ search_metadata: { status: 'Error' }, error: 'Invalid API key' }) });
    await assertThrowsAsync(() => reverseImageSearch('bad-key', 'https://example.com/photo.jpg'), SerpApiError, 'reverseImageSearch() при ошибке API');
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
      json: async () => ({ search_metadata: { status: 'Success' }, image_results: [{ title: 123, link: null }] }),
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

run();

import { isUrlSafeToFetch, fetchUrlText, UnsafeUrlError, UrlFetchError } from '../common/safe-url-fetch';

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

  // ── isUrlSafeToFetch() — SSRF-защита ──

  test('isUrlSafeToFetch() разрешает обычный публичный https URL', () => {
    assertEqual(isUrlSafeToFetch('https://example.com/article'), true, 'обычный публичный URL разрешён');
  });

  test('isUrlSafeToFetch() отклоняет некорректный URL', () => {
    assertEqual(isUrlSafeToFetch('не url вообще'), false, 'некорректная строка отклонена');
  });

  test('isUrlSafeToFetch() отклоняет не-http(s) протоколы (file://, ftp://)', () => {
    assertEqual(isUrlSafeToFetch('file:///etc/passwd'), false, 'file:// отклонён');
    assertEqual(isUrlSafeToFetch('ftp://example.com/x'), false, 'ftp:// отклонён');
  });

  test('isUrlSafeToFetch() отклоняет localhost', () => {
    assertEqual(isUrlSafeToFetch('http://localhost:3000/admin'), false, 'localhost отклонён');
    assertEqual(isUrlSafeToFetch('http://127.0.0.1/'), false, '127.0.0.1 отклонён');
  });

  test('isUrlSafeToFetch() отклоняет облачные метаданные (169.254.169.254)', () => {
    assertEqual(
      isUrlSafeToFetch('http://169.254.169.254/latest/meta-data/'),
      false,
      'самая частая реальная цель SSRF на облачных бэкендах отклонена',
    );
  });

  test('isUrlSafeToFetch() отклоняет приватные RFC 1918 диапазоны', () => {
    assertEqual(isUrlSafeToFetch('http://10.0.0.5/'), false, '10.0.0.0/8 отклонён');
    assertEqual(isUrlSafeToFetch('http://172.20.0.1/'), false, '172.16.0.0/12 отклонён');
    assertEqual(isUrlSafeToFetch('http://192.168.1.1/'), false, '192.168.0.0/16 отклонён');
  });

  test('isUrlSafeToFetch() НЕ путает публичные IP, похожие на приватные по первому октету', () => {
    assertEqual(isUrlSafeToFetch('http://172.15.0.1/'), true, '172.15.x — вне диапазона 172.16-31, публичный, разрешён');
    assertEqual(isUrlSafeToFetch('http://172.32.0.1/'), true, '172.32.x — вне диапазона 172.16-31, публичный, разрешён');
  });

  // ── fetchUrlText() — реальный fetch, мокаем global.fetch ──

  test('fetchUrlText() бросает UnsafeUrlError для небезопасного URL, не делает сетевой запрос вообще', async () => {
    let fetchCalled = false;
    (global as any).fetch = async () => { fetchCalled = true; return { ok: true, text: async () => '' }; };
    await assertThrowsAsync(() => fetchUrlText('http://localhost/'), UnsafeUrlError, 'fetchUrlText() на localhost');
    assertEqual(fetchCalled, false, 'проверка безопасности идёт ДО сетевого запроса, не после');
  });

  test('fetchUrlText() извлекает читаемый текст из HTML, отбрасывая теги/скрипты/стили', async () => {
    (global as any).fetch = async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () =>
        '<html><head><style>.a{color:red}</style><script>alert(1)</script></head><body><h1>Заголовок</h1><p>Текст статьи про бюджет.</p></body></html>',
    });
    const text = await fetchUrlText('https://example.com/article');
    assertEqual(text.includes('Заголовок'), true, 'видимый текст извлечён');
    assertEqual(text.includes('Текст статьи про бюджет'), true, 'текст параграфа извлечён');
    assertEqual(text.includes('alert(1)'), false, 'содержимое <script> отброшено');
    assertEqual(text.includes('color:red'), false, 'содержимое <style> отброшено');
  });

  test('fetchUrlText() бросает UrlFetchError при не-ok HTTP-ответе', async () => {
    (global as any).fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
    await assertThrowsAsync(() => fetchUrlText('https://example.com/missing'), UrlFetchError, 'fetchUrlText() при 404');
  });

  test('fetchUrlText() бросает UrlFetchError при сетевой ошибке (таймаут/DNS/обрыв)', async () => {
    (global as any).fetch = async () => { throw new Error('network error'); };
    await assertThrowsAsync(() => fetchUrlText('https://example.com/'), UrlFetchError, 'fetchUrlText() при сетевой ошибке');
  });

  test('fetchUrlText() бросает UrlFetchError, если Content-Length заявлен слишком большим', async () => {
    (global as any).fetch = async () => ({
      ok: true,
      headers: { get: (name: string) => (name === 'content-length' ? '5000000' : null) },
      text: async () => 'x',
    });
    await assertThrowsAsync(() => fetchUrlText('https://example.com/huge'), UrlFetchError, 'fetchUrlText() при заявленном большом размере');
  });

  test('fetchUrlText() бросает UrlFetchError, если после извлечения текста ничего не осталось', async () => {
    (global as any).fetch = async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => '<html><body><img src="x.jpg"></body></html>', // нет читаемого текста, только тег без содержимого
    });
    await assertThrowsAsync(() => fetchUrlText('https://example.com/image-only'), UrlFetchError, 'fetchUrlText() без извлекаемого текста');
  });

  test('fetchUrlText() обрезает очень длинный текст до разумного предела', async () => {
    const longText = 'слово '.repeat(5000); // сильно больше 8000 символов лимита
    (global as any).fetch = async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => `<p>${longText}</p>`,
    });
    const text = await fetchUrlText('https://example.com/long');
    assertEqual(text.length <= 8000, true, 'текст обрезан до предела, не отправляется в AI-промпт целиком');
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
  console.log(`\nsafe-url-fetch: ${results.length - failed.length}/${results.length} passed\n`);
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

import { putPublicBlob, deleteBlob, VercelBlobError } from '../common/vercel-blob';

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

  test('putPublicBlob() отправляет правильные заголовки (Authorization, x-content-type, x-access)', async () => {
    let capturedRequest: any = null;
    (global as any).fetch = async (url: string, init: any) => {
      capturedRequest = { url, init };
      return { ok: true, json: async () => ({ url: 'https://store.public.blob.vercel-storage.com/photo-abc.jpg', pathname: 'photo-abc.jpg', contentType: 'image/jpeg' }) };
    };

    await putPublicBlob('test-token', 'photo.jpg', Buffer.from('fake-image-bytes'), 'image/jpeg');
    assertEqual(capturedRequest.init.headers.Authorization, 'Bearer test-token', 'токен передан как Bearer');
    assertEqual(capturedRequest.init.headers['x-content-type'], 'image/jpeg', 'content-type передан');
    assertEqual(capturedRequest.init.headers['x-access'], 'public', 'явно указан публичный доступ');
    assertEqual(capturedRequest.init.method, 'PUT', 'метод PUT');
  });

  test('putPublicBlob() возвращает url/pathname/contentType из ответа', async () => {
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({ url: 'https://store.public.blob.vercel-storage.com/photo-xyz.jpg', pathname: 'photo-xyz.jpg', contentType: 'image/jpeg' }),
    });

    const result = await putPublicBlob('token', 'photo.jpg', Buffer.from('x'), 'image/jpeg');
    assertEqual(result.url, 'https://store.public.blob.vercel-storage.com/photo-xyz.jpg', 'url корректный');
  });

  test('putPublicBlob() бросает VercelBlobError при не-ok ответе', async () => {
    (global as any).fetch = async () => ({ ok: false, status: 403, statusText: 'Forbidden' });
    await assertThrowsAsync(() => putPublicBlob('bad-token', 'photo.jpg', Buffer.from('x'), 'image/jpeg'), VercelBlobError, 'putPublicBlob() при 403');
  });

  test('putPublicBlob() бросает VercelBlobError при сетевой ошибке', async () => {
    (global as any).fetch = async () => { throw new Error('network down'); };
    await assertThrowsAsync(() => putPublicBlob('token', 'photo.jpg', Buffer.from('x'), 'image/jpeg'), VercelBlobError, 'putPublicBlob() при сетевой ошибке');
  });

  test('deleteBlob() НЕ бросает исключение при сбое (best-effort, не должна ронять уже полученный результат)', async () => {
    (global as any).fetch = async () => { throw new Error('delete failed'); };
    let threw = false;
    try {
      await deleteBlob('token', 'https://store.public.blob.vercel-storage.com/photo.jpg');
    } catch {
      threw = true;
    }
    assertEqual(threw, false, 'deleteBlob() поглощает ошибку, не пробрасывает');
  });

  test('deleteBlob() отправляет POST на /delete с телом {urls: [...]}', async () => {
    let capturedRequest: any = null;
    (global as any).fetch = async (url: string, init: any) => {
      capturedRequest = { url, init };
      return { ok: true };
    };

    await deleteBlob('token', 'https://store.public.blob.vercel-storage.com/photo.jpg');
    assertEqual(capturedRequest.url.endsWith('/delete'), true, 'запрос на /delete');
    assertEqual(JSON.parse(capturedRequest.init.body).urls, ['https://store.public.blob.vercel-storage.com/photo.jpg'], 'тело содержит urls массивом');
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
  console.log(`\nvercel-blob: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

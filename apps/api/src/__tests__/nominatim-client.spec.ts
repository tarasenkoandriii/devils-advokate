import { reverseGeocode, NominatimError } from '../common/nominatim-client';

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

  test('reverseGeocode() отправляет обязательный User-Agent (требование usage policy Nominatim)', async () => {
    let capturedHeaders: any = null;
    (global as any).fetch = async (url: string, init: any) => {
      capturedHeaders = init.headers;
      return { ok: true, json: async () => ({ address: { country: 'Ukraine', city: 'Kyiv' } }) };
    };
    await reverseGeocode(50.45, 30.52);
    assertEqual(typeof capturedHeaders['User-Agent'], 'string', 'User-Agent передан');
    assertEqual(capturedHeaders['User-Agent'].length > 10, true, 'User-Agent не пустой/дефолтный');
  });

  test('reverseGeocode() парсит country/city из ответа', async () => {
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ address: { country: 'Ukraine', city: 'Kyiv' } }) });
    const result = await reverseGeocode(50.45, 30.52);
    assertEqual(result, { country: 'Ukraine', city: 'Kyiv' }, 'country/city распознаны');
  });

  test('reverseGeocode() падает обратно на town/village/municipality, если city нет', async () => {
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ address: { country: 'Ukraine', town: 'Boryspil' } }) });
    const result = await reverseGeocode(50.35, 30.95);
    assertEqual(result.city, 'Boryspil', 'town использован как fallback для city');
  });

  test('reverseGeocode() возвращает {null, null} для координат вне покрытия (не бросает исключение)', async () => {
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ error: 'Unable to geocode' }) });
    const result = await reverseGeocode(0, 0);
    assertEqual(result, { country: null, city: null }, 'честный пустой результат, не падение');
  });

  test('reverseGeocode() бросает NominatimError при не-ok HTTP-ответе', async () => {
    (global as any).fetch = async () => ({ ok: false, status: 429, statusText: 'Too Many Requests' });
    await assertThrowsAsync(() => reverseGeocode(50.45, 30.52), NominatimError, 'reverseGeocode() при 429');
  });

  test('reverseGeocode() бросает NominatimError при сетевой ошибке', async () => {
    (global as any).fetch = async () => { throw new Error('network down'); };
    await assertThrowsAsync(() => reverseGeocode(50.45, 30.52), NominatimError, 'reverseGeocode() при сетевой ошибке');
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
  console.log(`\nnominatim-client: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

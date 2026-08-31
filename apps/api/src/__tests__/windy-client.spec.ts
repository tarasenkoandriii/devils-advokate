import { getWindyForecast, WindyError } from '../weather-forecast/windy-client';

const COORDS = { latitude: 50.45, longitude: 30.52 };
const TARGET_DATE = new Date('2026-09-10T12:00:00Z');
const TS_MS = TARGET_DATE.getTime();

function windyResponse(overrides: Record<string, unknown> = {}) {
  return {
    ts: [TS_MS - 3600_000, TS_MS, TS_MS + 3600_000],
    units: { 'temp-surface': 'K' },
    'temp-surface': [283.15, 293.15, 298.15], // 10°C, 20°C, 25°C
    ...overrides,
  };
}

describe('windy-client (аудит/расширение периметра погоды 2026-08-30)', () => {
  afterEach(() => {
    (global as any).fetch = undefined;
  });

  it('формирует правильный POST-запрос: model=icon, ключ и координаты в теле, не в заголовке', async () => {
    let capturedUrl = '';
    let capturedBody: any;
    let capturedHeaders: any;
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      capturedHeaders = init.headers;
      return { ok: true, json: async () => windyResponse() };
    });

    await getWindyForecast('my-windy-key', COORDS, TARGET_DATE);

    expect(capturedUrl).toBe('https://api.windy.com/api/point-forecast/v2');
    expect(capturedBody.model).toBe('icon'); // не gfs — только icon/iconD2/iconEu отдают weatherWarnings, icon единственная глобальная
    expect(capturedBody.lat).toBe(COORDS.latitude);
    expect(capturedBody.lon).toBe(COORDS.longitude);
    expect(capturedBody.key).toBe('my-windy-key'); // ключ в теле, НЕ в заголовке — легко перепутать с Webcams/Map Forecast API того же провайдера
    expect(capturedHeaders.Authorization).toBeUndefined();
    expect(capturedBody.parameters).toEqual(expect.arrayContaining(['temp', 'weatherWarnings']));
  });

  it('конвертирует температуру из Кельвинов в Цельсии по units, не предполагает единицу заранее', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => windyResponse() }));
    const result = await getWindyForecast('key', COORDS, TARGET_DATE);
    expect(result.temperatureCelsius).toBe(20); // 293.15K, ближайший к TARGET_DATE
  });

  it('если units не указывает Кельвины — температура НЕ конвертируется (защита от ложной конвертации)', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => windyResponse({ units: { 'temp-surface': 'C' }, 'temp-surface': [10, 20, 25] }),
    }));
    const result = await getWindyForecast('key', COORDS, TARGET_DATE);
    expect(result.temperatureCelsius).toBe(20);
  });

  it('выбирает ближайший к targetDate индекс временного ряда', async () => {
    const closeDate = new Date(TS_MS + 1000); // на 1 секунду позже среднего элемента
    (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => windyResponse() }));
    const result = await getWindyForecast('key', COORDS, closeDate);
    expect(result.temperatureCelsius).toBe(20); // средний элемент (293.15K), не первый/последний
  });

  it('переиспользует WMO-коды WEATHER_CODE_LABELS для weatherWarnings (пересечение с Open-Meteo)', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => windyResponse({ 'weatherwarnings-surface': [0, 95, 0] }), // код 95 = "гроза" на среднем элементе
    }));
    const result = await getWindyForecast('key', COORDS, TARGET_DATE);
    expect(result.condition).toBe('гроза');
  });

  it('weatherWarnings=0 (нет значимых явлений) — определяет условие по облачности, не "нет данных"', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => windyResponse({
        'weatherwarnings-surface': [0, 0, 0],
        'lclouds-surface': [10, 5, 10],
        'mclouds-surface': [10, 5, 10],
        'hclouds-surface': [10, 5, 10],
      }),
    }));
    const result = await getWindyForecast('key', COORDS, TARGET_DATE);
    expect(result.condition).toBe('ясно'); // 5% облачности на среднем элементе
  });

  it('весь ряд облачности отсутствует и weatherWarnings=0 — честное "нет данных", не выдумывает "ясно"', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => windyResponse({ 'weatherwarnings-surface': [0, 0, 0] }), // облачность вообще не запрошена/не пришла
    }));
    const result = await getWindyForecast('key', COORDS, TARGET_DATE);
    expect(result.condition).toBe('нет данных');
  });

  it('бросает WindyError при не-ok HTTP ответе, тело ответа попадает в сообщение', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 400, text: async () => '{"error":"invalid model"}' }));
    await expect(getWindyForecast('bad-key', COORDS, TARGET_DATE)).rejects.toThrow(WindyError);
    await expect(getWindyForecast('bad-key', COORDS, TARGET_DATE)).rejects.toThrow(/invalid model/);
  });

  it('бросает WindyError при сетевой ошибке', async () => {
    (global as any).fetch = jest.fn(async () => { throw new Error('network down'); });
    await expect(getWindyForecast('key', COORDS, TARGET_DATE)).rejects.toThrow(WindyError);
  });

  it('пустой ts[] — честный "нет данных", не падает', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ts: [], units: {} }) }));
    const result = await getWindyForecast('key', COORDS, TARGET_DATE);
    expect(result).toEqual({ temperatureCelsius: null, condition: 'нет данных' });
  });
});

// Пункт 76 (§3.21 ТЗ) — клиент Open-Meteo, raw fetch, без SDK (тот же
// принцип минимальных зависимостей, что SerpApi/Nominatim/Google
// Places клиенты). Открытый, бесплатный провайдер без API-ключа — не
// заводит новый секрет ради вспомогательной "nice-to-have" фичи,
// buкально названной так в самой ТЗ.

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface ForecastResult {
  temperatureCelsius: number | null;
  condition: string;
}

// WMO Weather interpretation codes — официальная таблица Open-Meteo,
// не выдуманное сопоставление.
// Экспортирован (2026-08-30) — переиспользуется windy-client.ts: коды
// weatherWarnings-surface у Windy построены на той же WMO-таблице.
export const WEATHER_CODE_LABELS: Record<number, string> = {
  0: 'ясно',
  1: 'преимущественно ясно',
  2: 'переменная облачность',
  3: 'пасмурно',
  45: 'туман',
  48: 'изморозь',
  51: 'слабая морось',
  53: 'умеренная морось',
  55: 'сильная морось',
  61: 'слабый дождь',
  63: 'умеренный дождь',
  65: 'сильный дождь',
  71: 'слабый снег',
  73: 'умеренный снег',
  75: 'сильный снег',
  80: 'ливень',
  81: 'умеренный ливень',
  82: 'сильный ливень',
  95: 'гроза',
  96: 'гроза с градом',
  99: 'сильная гроза с градом',
};

/** "По городу, который пользователь указывает вручную" (buкально ТЗ)
 * — геокодирование ТОЛЬКО для получения координат для следующего
 * запроса, координаты используются транзитно, не персистятся вызывающим кодом. */
export async function geocodeCity(cityName: string): Promise<Coordinates | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error('Open-Meteo (геокодирование) недоступен — сетевая ошибка');
  }
  if (!response.ok) {
    throw new Error(`Open-Meteo (геокодирование) вернул ошибку: ${response.status}`);
  }
  const data: any = await response.json(); // runtime-shape проверяется ниже; @types/node >=20.19 типизирует json() как unknown
  const result = data.results?.[0];
  if (!result) return null;
  return { latitude: result.latitude, longitude: result.longitude };
}

/** Прогноз на конкретную дату/время — "с привязкой к конкретному
 * проекту в календаре" (buкально ТЗ). Open-Meteo отдаёт почасовой
 * прогноз, выбираем ближайший час к запрошенному времени. */
export async function getForecast(coords: Coordinates, targetDate: Date): Promise<ForecastResult> {
  const dateStr = targetDate.toISOString().slice(0, 10);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}&hourly=temperature_2m,weathercode&start_date=${dateStr}&end_date=${dateStr}&timezone=auto`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error('Open-Meteo (прогноз) недоступен — сетевая ошибка');
  }
  if (!response.ok) {
    throw new Error(`Open-Meteo (прогноз) вернул ошибку: ${response.status}`);
  }
  const data: any = await response.json(); // runtime-shape проверяется ниже; @types/node >=20.19 типизирует json() как unknown
  const times: string[] = data.hourly?.time ?? [];
  const temps: number[] = data.hourly?.temperature_2m ?? [];
  const codes: number[] = data.hourly?.weathercode ?? [];

  if (times.length === 0) {
    return { temperatureCelsius: null, condition: 'нет данных' };
  }

  // Ближайший час к запрошенному времени.
  let closestIdx = 0;
  let closestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(new Date(times[i]).getTime() - targetDate.getTime());
    if (diff < closestDiff) {
      closestDiff = diff;
      closestIdx = i;
    }
  }

  const code = codes[closestIdx];
  return {
    temperatureCelsius: typeof temps[closestIdx] === 'number' ? temps[closestIdx] : null,
    condition: WEATHER_CODE_LABELS[code] ?? `код ${code}`,
  };
}

// Пункт 76 (§3.21 ТЗ) — клиент Open-Meteo, raw fetch, без SDK (тот же
// принцип минимальных зависимостей, что SerpApi/Nominatim/Google
// Places клиенты). Открытый, бесплатный провайдер без API-ключа — не
// заводит новый секрет ради вспомогательной "nice-to-have" фичи,
// buкально названной так в самой ТЗ.

import { fetchWithTimeout } from '../common/fetch-with-timeout';

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** Пункт [forecast-without-source] 2026-09-06 — у прогноза есть автор.
 *
 * Прогноз приходит от ОДНОГО ИЗ ДВУХ сервисов: Windy (платный, с
 * ключом) и Open-Meteo (бесплатный, без ключа). Переключение между
 * ними было молчаливым: тип результата автора не нёс, колонки под него
 * не существовало, экран его не показывал. Человек читал «ясно,
 * 18 °C», не зная, чей это прогноз, — при том что весь остальной
 * продукт называет опору у каждого вывода ([partial-basis],
 * [source-collapse]). И если ключ Windy просрочен, продукт переходит
 * на второй сервис НАВСЕГДА и никому об этом не сообщает — та же
 * форма, что у незапущенного планового задания. */
export type ForecastSource = 'windy' | 'open-meteo';

export interface ForecastResult {
  temperatureCelsius: number | null;
  /** null — данных на эту дату нет. Пункт [forecast-without-source]
   * 2026-09-06: раньше здесь стояла строка «нет данных», которая
   * дальше уходила в промпт как ОПИСАНИЕ ПОГОДЫ, и модель выдавала по
   * ней рекомендацию «проводить / перенести». */
  condition: string | null;
  source: ForecastSource;
}

/** Есть ли в ответе сервиса хоть что-то о погоде. Отдельная функция, а
 * не проверка на месте: правило «пусто — значит не о чём советовать»
 * проверяется на своих данных. */
export function forecastHasData(f: { temperatureCelsius: number | null; condition: string | null }): boolean {
  return f.condition !== null || f.temperatureCelsius !== null;
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
    response = await fetchWithTimeout(url);
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

/** Час из ответа Open-Meteo — всегда UTC (мы просим timezone=UTC), но
 * строка приходит без суффикса «Z», а такую строку JS разбирает в
 * ЧАСОВОМ ПОЯСЕ СРЕДЫ. Поэтому пояс проставляется явно: иначе результат
 * зависел бы от того, где запущен сервер, — на Vercel UTC, на машине
 * разработчика какой угодно. */
export function parseApiHourUtc(time: string): number {
  return Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(time) ? time : `${time}Z`);
}

/** Прогноз на конкретную дату/время — "с привязкой к конкретному
 * проекту в календаре" (buкально ТЗ). Open-Meteo отдаёт почасовой
 * прогноз, выбираем ближайший час к запрошенному времени. */
export async function getForecast(coords: Coordinates, targetDate: Date): Promise<ForecastResult> {
  // Аудит времени 2026-09-03. Здесь было две ошибки, и обе тихие —
  // прогноз показывался, просто не тот.
  //
  // 1. `timezone=auto` возвращает часы в МЕСТНОМ времени точки и БЕЗ
  //    смещения («2026-06-15T14:00»). `new Date()` от такой строки берёт
  //    часовой пояс СЕРВЕРА (на Vercel — UTC), то есть 14:00 в Киеве
  //    сравнивалось со временем встречи как 14:00 UTC: «ближайший час»
  //    промахивался ровно на смещение точки. Пользователю показывалась
  //    гроза, которой в час встречи не было — или наоборот.
  // 2. Дата диапазона бралась в UTC (`toISOString`), а интерпретировалась
  //    API в местном поясе точки: встреча в 00:30 по местному времени
  //    попадала на предыдущие сутки по UTC, и нужного часа в ответе не
  //    было вовсе.
  //
  // Лечится не «учётом часовых поясов» (их в продукте нет и заводить их
  // ради виджета погоды незачем), а отказом от местного времени вообще:
  // просим UTC и берём сутки с запасом в обе стороны. Сравнение моментов
  // становится независимым и от пояса точки, и от пояса сервера.
  const dayMs = 24 * 60 * 60 * 1000;
  const startDate = new Date(targetDate.getTime() - dayMs).toISOString().slice(0, 10);
  const endDate = new Date(targetDate.getTime() + dayMs).toISOString().slice(0, 10);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}&hourly=temperature_2m,weathercode&start_date=${startDate}&end_date=${endDate}&timezone=UTC`;
  let response: Response;
  try {
    response = await fetchWithTimeout(url);
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
    // Пункт [forecast-without-source] 2026-09-06: null, а не строка
    // «нет данных» — она уходила в промпт как описание погоды.
    return { temperatureCelsius: null, condition: null, source: 'open-meteo' };
  }

  // Ближайший час к запрошенному времени.
  let closestIdx = 0;
  let closestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(parseApiHourUtc(times[i]) - targetDate.getTime());
    if (diff < closestDiff) {
      closestDiff = diff;
      closestIdx = i;
    }
  }

  const code = codes[closestIdx];
  // Пункт [forecast-without-source] 2026-09-06: кода в ответе может не
  // быть вовсе. Прежняя строка давала `код undefined` — и это
  // сохранялось как ОПИСАНИЕ ПОГОДЫ и показывалось человеку. Неизвестный
  // код (число без подписи в таблице WMO) — другое дело: его так и
  // называем, это честная передача того, что сервис сказал.
  const condition = typeof code === 'number' ? WEATHER_CODE_LABELS[code] ?? `код ${code}` : null;
  return {
    temperatureCelsius: typeof temps[closestIdx] === 'number' ? temps[closestIdx] : null,
    condition,
    source: 'open-meteo',
  };
}

/** Что человек читает вместо совета, когда сервис ответил, но данных не
 * дал. Пункт [forecast-without-source] 2026-09-06: текст называет и
 * автора ответа, и границу — «мы не знаем», а не «погода никакая».
 * Формулировка живёт рядом с типом, а не на экране: экран не должен
 * додумывать смысл пустоты. */
export function noForecastDataReason(source: ForecastSource): string {
  const name = source === 'windy' ? 'Windy' : 'Open-Meteo';
  return `Сервис прогнозов (${name}) ответил, но данных на это время не дал. Совета здесь нет намеренно: он был бы выводом из пустоты, а не из погоды. Попробуйте ближе к дате — почасовые прогнозы появляются не сразу.`;
}

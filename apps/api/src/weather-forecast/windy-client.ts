// Расширение периметра погоды на будущее (2026-08-30, по прямому запросу
// — «может вместо Open-Meteo использовать Windy (fallback onto Open-Meteo)»).
//
// КОНТРАКТ ПОДТВЕРЖДЁН ДОКУМЕНТАЦИЕЙ (api.windy.com/point-forecast/docs,
// прочитана целиком): POST https://api.windy.com/api/point-forecast/v2,
// ключ — в теле запроса (поле `key`), НЕ в заголовке (в отличие от
// Webcams/Map Forecast API у того же провайдера — легко перепутать).
// Требует платной/freemium регистрации на api.windy.com — в отличие от
// Open-Meteo, который остаётся бесплатным и без ключа; поэтому здесь
// Windy — опциональный ПЕРВИЧНЫЙ источник (при отсутствии WINDY_API_KEY
// код тихо не пытается его использовать вообще, см. weather-forecast.service.ts),
// Open-Meteo — обязательный fallback.
//
// МОДЕЛЬ: `icon` (ICON-Global, DWD), не `gfs`. Осознанный выбор: параметр
// weatherWarnings (нужен для условия в человекочитаемом виде) по таблице
// совместимости документации поддерживают ТОЛЬКО icon/iconD2/iconEu —
// gfs его не отдаёт вообще (только «сырые» физические величины: облачность
// по ярусам, осадки, cape — без единого кода состояния погоды). iconD2/iconEu
// точнее, но покрывают только Европу — не подходит для продукта с
// пользователями за пределами Европы. icon — единственная из трёх,
// поддерживающих weatherWarnings, с ГЛОБАЛЬНЫМ покрытием.
//
// КОДЫ: weatherWarnings-surface — по документации использует те же
// числовые коды, что и WMO-таблица, на которой уже построен
// WEATHER_CODE_LABELS в open-meteo-client.ts (45/48/51/53/55/61/63/65/
// 71/73/75/80/81/82/95/96 — пересечение почти полное). Переиспользуем
// ту же таблицу меток, не дублируем — но у Windy НЕТ отдельных кодов
// для «ясно»/«переменная облачность»/«пасмурно» (0/1/2/3 у Open-Meteo) —
// weatherWarnings в принципе не покрывает случай «ничего значимого не
// происходит», это отдельная семантика («code 0» здесь означает «нет
// данных о значимых явлениях», не «ясно»). При отсутствии значения
// weatherWarnings синтезируем условие из облачности по трём ярусам
// (lclouds/mclouds/hclouds, % покрытия) — честная деградация до
// «ясно/переменная облачность/пасмурно», не «нет данных», раз сами
// данные по факту есть, просто в другой форме, чем у Open-Meteo.

import { WEATHER_CODE_LABELS, type Coordinates, type ForecastResult } from './open-meteo-client';
import { fetchWithTimeout } from '../common/fetch-with-timeout';

const WINDY_API_URL = 'https://api.windy.com/api/point-forecast/v2';
const WINDY_MODEL = 'icon';

export class WindyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindyError';
  }
}

interface WindyResponse {
  ts: number[];
  units: Record<string, string>;
  [parameterLevel: string]: unknown;
}

function closestIndex(timestampsMs: number[], targetMs: number): number {
  let idx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < timestampsMs.length; i++) {
    const diff = Math.abs(timestampsMs[i] - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      idx = i;
    }
  }
  return idx;
}

/** Облачность по ярусам (0-100%, обычно доли — units уточняет) в
 * условие, когда weatherWarnings ничего не сообщил (нет значимых
 * явлений — не значит "нет данных", значит "нет ГРОЗЫ/ДОЖДЯ/ТУМАНА",
 * ясность/облачность отдельно считываем из cloud-параметров). */
function conditionFromClouds(totalCloudFraction: number | null): string {
  if (totalCloudFraction === null) return 'нет данных';
  if (totalCloudFraction < 0.15) return 'ясно';
  if (totalCloudFraction < 0.5) return 'преимущественно ясно';
  if (totalCloudFraction < 0.85) return 'переменная облачность';
  return 'пасмурно';
}

export async function getWindyForecast(
  apiKey: string,
  coords: Coordinates,
  targetDate: Date,
): Promise<ForecastResult> {
  let response: Response;
  try {
    response = await fetchWithTimeout(WINDY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: coords.latitude,
        lon: coords.longitude,
        model: WINDY_MODEL,
        parameters: ['temp', 'weatherWarnings', 'lclouds', 'mclouds', 'hclouds'],
        key: apiKey,
      }),
    });
  } catch (err) {
    throw new WindyError(`Windy Point Forecast API недоступен — сетевая ошибка: ${err instanceof Error ? err.message : 'неизвестная'}`);
  }

  if (!response.ok) {
    // 204 — "the selected model does not feature any of the requested
    // parameters" (документация) — с моделью icon для набора выше не
    // должно происходить, но не молчим, если xAI/Windy это когда-нибудь
    // изменит: явная ошибка, не тихий пустой результат.
    const body = await response.text().catch(() => '<unreadable>');
    throw new WindyError(`Windy Point Forecast API вернул ошибку (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as WindyResponse;
  const timestamps = Array.isArray(data.ts) ? data.ts : [];
  if (timestamps.length === 0) {
    return { temperatureCelsius: null, condition: 'нет данных' };
  }

  const idx = closestIndex(timestamps, targetDate.getTime());

  const tempSeries = data['temp-surface'];
  const tempRaw = Array.isArray(tempSeries) ? (tempSeries[idx] as number | null) : null;
  // units["temp-surface"] подтверждает единицу измерения в рантайме,
  // не предполагается заранее — Windy отдаёт температуру в Кельвинах.
  const tempUnit = data.units?.['temp-surface'] ?? '';
  const temperatureCelsius =
    typeof tempRaw === 'number' ? Math.round((tempUnit.toUpperCase().startsWith('K') ? tempRaw - 273.15 : tempRaw) * 10) / 10 : null;

  const warningsSeries = data['weatherwarnings-surface'];
  const warningCode = Array.isArray(warningsSeries) ? (warningsSeries[idx] as number | null) : null;

  let condition: string;
  if (typeof warningCode === 'number' && warningCode > 0 && WEATHER_CODE_LABELS[warningCode]) {
    condition = WEATHER_CODE_LABELS[warningCode];
  } else {
    const lc = readCloudFraction(data, 'lclouds-surface', idx);
    const mc = readCloudFraction(data, 'mclouds-surface', idx);
    const hc = readCloudFraction(data, 'hclouds-surface', idx);
    const values = [lc, mc, hc].filter((v): v is number => v !== null);
    const totalCloud = values.length ? Math.max(...values) : null;
    condition = conditionFromClouds(totalCloud);
  }

  return { temperatureCelsius, condition };
}

function readCloudFraction(data: WindyResponse, key: string, idx: number): number | null {
  const series = data[key];
  const raw = Array.isArray(series) ? (series[idx] as number | null) : null;
  if (typeof raw !== 'number') return null;
  // Windy отдаёт облачность в % (0-100) для lclouds/mclouds/hclouds —
  // нормализуем к доле (0-1), как ожидает conditionFromClouds().
  return raw > 1 ? raw / 100 : raw;
}

// Пункт 49: nominatim-client.ts — минимальный клиент для Nominatim
// (OpenStreetMap reverse geocoding), сырой fetch() без SDK-пакета, тот
// же принцип, что vercel-blob.ts/serpapi-client.ts. НЕ требует
// API-ключа/секрета — единственная внешняя интеграция проекта без
// собственного credentialRef в SecretsService.
//
// USAGE POLICY nominatim.openstreetmap.org (подтверждено официальной
// документацией OSM Foundation): максимум 1 запрос/сек, ОБЯЗАТЕЛЕН
// валидный User-Agent, идентифицирующий приложение (дефолтный
// User-Agent HTTP-библиотек не подходит) — единственное реальное
// ограничение, соблюдено явно ниже. Разовый запрос при онбординге
// (не постоянный поток запросов) укладывается в лимит с большим
// запасом.
//
// ЧЕСТНО: контракт восстановлен по официальной документации Nominatim,
// не проверен вызовом против реального сервиса в этой среде — та же
// оговорка, что у остальных внешних интеграций проекта.

const NOMINATIM_HOST = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = "Devil's Advocate onboarding geo-suggestion (single request per user, see docs/devils-advocate-tz.md §3.24)";

export interface ReverseGeocodeResult {
  country: string | null;
  city: string | null;
}

export class NominatimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NominatimError';
  }
}

export async function reverseGeocode(lat: number, lon: number): Promise<ReverseGeocodeResult> {
  const url = `${NOMINATIM_HOST}?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&addressdetails=1&zoom=10`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  } catch (err) {
    throw new NominatimError(`Не удалось связаться с Nominatim: ${err instanceof Error ? err.message : 'неизвестная ошибка сети'}`);
  }

  if (!response.ok) {
    throw new NominatimError(`Nominatim вернул ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (data.error) {
    // Координаты вне покрытия OSM (открытый океан и т.п.) — не ошибка
    // сервиса, честный "ничего не найдено", не исключение.
    return { country: null, city: null };
  }

  const address = data.address ?? {};
  const city = address.city ?? address.town ?? address.village ?? address.municipality ?? null;
  return {
    country: typeof address.country === 'string' ? address.country : null,
    city: typeof city === 'string' ? city : null,
  };
}

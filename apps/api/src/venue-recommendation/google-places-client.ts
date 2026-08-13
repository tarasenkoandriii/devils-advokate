// Пункт 65 (§3.22 ТЗ) — клиент Google Places API, raw fetch, без SDK
// (тот же принцип минимальных зависимостей, что SerpApi-клиент,
// Пункт 48, и Nominatim-клиент, Пункт 49).
//
// КЛАССИЧЕСКИЙ Places API (не новый Places API v1) — проще для этой
// задачи (nearby search + details одним понятным GET-запросом с
// query-параметрами, не POST с телом и field mask).
//
// Пункт 66 (§3.23 ТЗ) добавил searchByText() (поиск по названию, не
// по координатам — "гео И автоопределение заведения... по
// геолокации/названию", буквально ТЗ) и расширил PlaceDetails полями
// openingHours/photoReferences для карточки заведения-партнёра.

export interface PlaceCandidate {
  placeId: string;
  name: string;
  rating: number | null;
}

export interface PlaceDetails {
  name: string;
  address: string;
  phone: string | null;
  rating: number | null;
  reviewTexts: string[]; // ВРЕМЕННО, для передачи в AI на парафраз — вызывающий код НИКОГДА не персистит это поле
  openingHours: string[]; // "часы работы" (§3.23 ТЗ) — human-readable строки от Google, не структурированное расписание
  // Ссылки на Google Places Photo API (photo_reference), НЕ сами байты
  // изображения — тот же принцип, что fileRef у FactSource (раздел 2
  // ТЗ): сервер хранит ссылку, не скачивает и не персистит бинарник.
  photoReferences: string[];
}

export async function searchNearbyVenues(
  latitude: number,
  longitude: number,
  apiKey: string,
): Promise<PlaceCandidate[]> {
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${latitude},${longitude}&radius=1500&type=cafe&key=${apiKey}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error('Google Places недоступен — сетевая ошибка');
  }
  if (!response.ok) {
    throw new Error(`Google Places вернул ошибку: ${response.status}`);
  }
  const data = await response.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Google Places: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
  }
  return (data.results ?? []).map((r: any) => ({
    placeId: r.place_id,
    name: r.name,
    rating: typeof r.rating === 'number' ? r.rating : null,
  }));
}

/** "По геолокации/названию" (§3.23 ТЗ) — поиск по текстовому запросу
 * (название заведения), не по координатам. lat/lon опциональны — не
 * все владельцы могут/хотят делиться геолокацией при заполнении формы. */
export async function searchByText(query: string, apiKey: string, latitude?: number, longitude?: number): Promise<PlaceCandidate[]> {
  const locationParam = latitude !== undefined && longitude !== undefined ? `&location=${latitude},${longitude}&radius=5000` : '';
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}${locationParam}&key=${apiKey}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error('Google Places недоступен — сетевая ошибка');
  }
  if (!response.ok) {
    throw new Error(`Google Places вернул ошибку: ${response.status}`);
  }
  const data = await response.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Google Places: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
  }
  return (data.results ?? []).map((r: any) => ({
    placeId: r.place_id,
    name: r.name,
    rating: typeof r.rating === 'number' ? r.rating : null,
  }));
}

export async function getPlaceDetails(placeId: string, apiKey: string): Promise<PlaceDetails> {
  const fields = 'name,formatted_address,formatted_phone_number,rating,reviews,opening_hours,photos';
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${apiKey}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error('Google Places недоступен — сетевая ошибка');
  }
  if (!response.ok) {
    throw new Error(`Google Places вернул ошибку: ${response.status}`);
  }
  const data = await response.json();
  if (data.status !== 'OK') {
    throw new Error(`Google Places: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
  }
  const result = data.result ?? {};
  return {
    name: result.name ?? '',
    address: result.formatted_address ?? '',
    phone: result.formatted_phone_number ?? null,
    rating: typeof result.rating === 'number' ? result.rating : null,
    reviewTexts: (result.reviews ?? []).map((r: any) => r.text).filter((t: unknown) => typeof t === 'string'),
    openingHours: (result.opening_hours?.weekday_text ?? []).filter((t: unknown) => typeof t === 'string'),
    photoReferences: (result.photos ?? []).map((p: any) => p.photo_reference).filter((r: unknown) => typeof r === 'string'),
  };
}

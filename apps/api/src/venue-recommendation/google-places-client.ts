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
  // Пункт [major-purchase] (§2.2/§4 ТЗ) — координаты нужны, чтобы
  // заполнить PurchaseVariant.latitude/longitude при указании локации
  // через placeId, не только при "сыром" device-геолокации. null для
  // существующих вызывающих модулей (venue-recommendation/
  // venue-application), которым это поле не нужно — не ломает их.
  location: { latitude: number; longitude: number } | null;
}

// Пункт [major-purchase] (devils-advocate-major-purchase-tz.md §2.2)
// добавил параметр placeType — 'real_estate_agency'/'car_dealer',
// оба официальные значения Google Places API. Дефолт 'cafe' сохраняет
// поведение всех существующих вызовов без изменений (venue-recommendation).
// Пункт [major-purchase]: АУДИТ ЗНАЙШОВ РЕАЛЬНИЙ БАГ, підтверджений
// офіційною документацією Google Places API — searchNearbyVenues()
// вище з параметром `radius` сортує результати за PROMINENCE
// (популярність/рейтинг), НЕ за відстанню (https://developers.google.com/
// maps/documentation/places/web-service/legacy/search-nearby: "radius
// parameter... results ordered by prominence"). Для venue-recommendation
// (Пункт 65, "найкраще кафе поруч") це правильна поведінка. Для
// major-purchase (§2.2 ТЗ: користувач стоїть біля КОНКРЕТНОГО салону/
// агентства прямо зараз) це неправильно — код брав candidates[0] як
// "найближче місце", хоча насправді це "найпопулярніше місце в радіусі
// 1.5км", яке могло бути помітно далі, ніж менш популярне місце, де
// користувач фізично знаходиться.
//
// ФІКС — окрема функція з rankby=distance (не можна комбінувати з
// radius — Google API поверне INVALID_REQUEST, тому це саме окрема
// функція, не параметр до існуючої). НЕ чіпає searchNearbyVenues() —
// venue-recommendation і далі коректно отримує prominence-ранжування,
// яке для "найкраще кафе" є правильним вибором, не помилкою.
export async function searchNearestByDistance(
  latitude: number,
  longitude: number,
  apiKey: string,
  placeType: string,
): Promise<PlaceCandidate[]> {
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${latitude},${longitude}&rankby=distance&type=${encodeURIComponent(placeType)}&key=${apiKey}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error('Google Places недоступен — сетевая ошибка');
  }
  if (!response.ok) {
    throw new Error(`Google Places вернул ошибку: ${response.status}`);
  }
  const data: any = await response.json(); // runtime-shape проверяется ниже; @types/node >=20.19 типизирует json() как unknown
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Google Places: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
  }
  // Результати вже впорядковані Google за зростанням відстані —
  // results[0] дійсно найближче місце, не найпопулярніше.
  return (data.results ?? []).map((r: any) => ({
    placeId: r.place_id,
    name: r.name,
    rating: typeof r.rating === 'number' ? r.rating : null,
  }));
}

export async function searchNearbyVenues(
  latitude: number,
  longitude: number,
  apiKey: string,
  placeType: string = 'cafe',
): Promise<PlaceCandidate[]> {
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${latitude},${longitude}&radius=1500&type=${encodeURIComponent(placeType)}&key=${apiKey}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error('Google Places недоступен — сетевая ошибка');
  }
  if (!response.ok) {
    throw new Error(`Google Places вернул ошибку: ${response.status}`);
  }
  const data: any = await response.json(); // runtime-shape проверяется ниже; @types/node >=20.19 типизирует json() как unknown
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
  const data: any = await response.json(); // runtime-shape проверяется ниже; @types/node >=20.19 типизирует json() как unknown
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
  const fields = 'name,formatted_address,formatted_phone_number,rating,reviews,opening_hours,photos,geometry';
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
  const data: any = await response.json(); // runtime-shape проверяется ниже; @types/node >=20.19 типизирует json() как unknown
  if (data.status !== 'OK') {
    throw new Error(`Google Places: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
  }
  const result = data.result ?? {};
  const lat = result.geometry?.location?.lat;
  const lng = result.geometry?.location?.lng;
  return {
    name: result.name ?? '',
    address: result.formatted_address ?? '',
    phone: result.formatted_phone_number ?? null,
    rating: typeof result.rating === 'number' ? result.rating : null,
    reviewTexts: (result.reviews ?? []).map((r: any) => r.text).filter((t: unknown) => typeof t === 'string'),
    openingHours: (result.opening_hours?.weekday_text ?? []).filter((t: unknown) => typeof t === 'string'),
    photoReferences: (result.photos ?? []).map((p: any) => p.photo_reference).filter((r: unknown) => typeof r === 'string'),
    location: typeof lat === 'number' && typeof lng === 'number' ? { latitude: lat, longitude: lng } : null,
  };
}

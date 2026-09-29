// Пункт [consent-purpose] 2026-09-05 — зеркало словаря применений
// геолокации (`apps/api/src/consent/location-purposes.ts`).
//
// ПОЧЕМУ КОПИЯ, А НЕ ИМПОРТ. Приложения собираются раздельно, общего
// пакета в монорепозитории нет, и заводить его ради пяти строк — не та
// цена. Зато цена расхождения известна заранее: экран покажет одни
// слова, сервер проверит другое применение — то самое, что этот пункт и
// закрывает. Поэтому копия ПРОВЕРЯЕТСЯ тестом
// (`consent-purpose.spec.ts`): списки должны совпадать строка в строку,
// включая пометку «координаты сохраняются».
//
// Текст здесь — не украшение. Именно эти слова человек читает перед
// тем, как нажать «Разрешить», и именно они должны совпадать с тем,
// что делает код.

export const LOCATION_PURPOSES = {
  ONBOARDING_CITY: 'onboarding-city-hint',
  WEATHER: 'weather-forecast',
  VENUE_SEARCH: 'venue-search',
  MAJOR_PURCHASE: 'major_purchase_viewings',
  DTP_EVIDENCE: 'dtp-evidence-geotag',
} as const;

export type LocationPurpose = (typeof LOCATION_PURPOSES)[keyof typeof LOCATION_PURPOSES];

export interface LocationPurposeSpec {
  purpose: LocationPurpose;
  label: string;
  storesCoordinates: boolean;
}

export const LOCATION_PURPOSE_SPECS: readonly LocationPurposeSpec[] = [
  { purpose: LOCATION_PURPOSES.ONBOARDING_CITY, label: 'подсказать страну и город при первом входе', storesCoordinates: false },
  { purpose: LOCATION_PURPOSES.WEATHER, label: 'прогноз погоды для запланированной встречи', storesCoordinates: false },
  { purpose: LOCATION_PURPOSES.VENUE_SEARCH, label: 'поиск заведений рядом', storesCoordinates: false },
  { purpose: LOCATION_PURPOSES.MAJOR_PURCHASE, label: 'привязать вариант покупки к месту осмотра', storesCoordinates: true },
  { purpose: LOCATION_PURPOSES.DTP_EVIDENCE, label: 'геометка на фото или видео с места ДТП', storesCoordinates: true },
];

export function locationPurposeSpec(purpose: string): LocationPurposeSpec | null {
  return LOCATION_PURPOSE_SPECS.find((s) => s.purpose === purpose) ?? null;
}

/** Текст согласия под конкретный набор применений.
 *
 * Раньше на экране стояла одна фраза на все случаи: «Координаты никогда
 * не сохраняются — только разовое использование для каждого запроса».
 * Для трёх применений, ради которых она написана, это правда. Той же
 * записью согласия открывались ещё два, где координаты сохраняются
 * навсегда, — и фраза становилась ложью, не изменившись ни на букву.
 * Поэтому текст теперь СЧИТАЕТСЯ из применений, а не хранится строкой. */
export function locationConsentText(purposes: readonly string[]): string {
  const specs = purposes.map(locationPurposeSpec).filter((s): s is LocationPurposeSpec => s !== null);
  if (specs.length === 0) return 'Разрешить использование геолокации.';
  const list = specs.map((s) => s.label).join('; ');
  const stored = specs.filter((s) => s.storesCoordinates);
  const tail = stored.length === 0
    ? 'Координаты не сохраняются: они используются один раз для этого запроса и в базе не остаются.'
    : `Координаты СОХРАНЯЮТСЯ и останутся в проекте — ${stored.map((s) => s.label).join('; ')}. Удалить их можно вместе с записью, к которой они привязаны.`;
  return `Разрешить использование геолокации для: ${list}. ${tail} Разрешение можно отозвать в любой момент в настройках приватности.`;
}

// Пункт [consent-purpose] 2026-09-05 — согласие спросили одними
// словами, а проверяют другими.
//
// НАЙДЕНО. У `ConsentRecord` есть поле `purposes[]` — ровно для
// геолокации, ровно для того, чтобы «разрешил на погоду» не значило
// «разрешил на всё». Оно аккуратно ЗАПОЛНЯЕТСЯ обеими дверями:
// экранный `LocationConsentPrompt` пишет три применения,
// `major-purchase` пишет своё. И не читается НИГДЕ:
// `hasActiveConsent()` ищет запись по типу согласия и не смотрит в
// `purposes` вовсе.
//
// Цена этого — не в аккуратности учёта. Экран согласия говорит
// человеку буквально:
//
//     «Координаты никогда не сохраняются — только разовое
//      использование для каждого запроса»
//
// и это правда для тех трёх применений, ради которых он написан. Но
// та же запись согласия открывает ещё два места, где координаты
// сохраняются НАВСЕГДА: гео-привязка варианта покупки
// (`PurchaseVariant.latitude/longitude`) и геометка доказательства ДТП
// (`DtpEvidenceItem.latitude/longitude`, к тому же в материале, который
// человек собирается кому-то предъявлять). Человек разрешил погоду —
// продукт получил право записать, где он был.
//
// ЧТО ИМЕННО ИСПРАВЛЯЕТСЯ. Не «добавить проверку» — сделать так, чтобы
// слова, под которыми человек подписался, и были тем, что проверяется.
// Поэтому применение и его текст лежат в ОДНОМ месте: развести их —
// значит завести второй экземпляр правды, который однажды разойдётся с
// первым (ровно это и произошло с `purposes`).

/** Применения геолокации. Строки уходят в базу — менять их нельзя без
 * миграции уже выданных согласий. */
export const LOCATION_PURPOSES = {
  ONBOARDING_CITY: 'onboarding-city-hint',
  WEATHER: 'weather-forecast',
  VENUE_SEARCH: 'venue-search',
  /** Уже существовал в major-purchase до этой сверки — значение сохранено. */
  MAJOR_PURCHASE: 'major_purchase_viewings',
  DTP_EVIDENCE: 'dtp-evidence-geotag',
} as const;

export type LocationPurpose = (typeof LOCATION_PURPOSES)[keyof typeof LOCATION_PURPOSES];

export interface LocationPurposeSpec {
  purpose: LocationPurpose;
  /** Что человек увидит на экране согласия — его словами, не полем базы. */
  label: string;
  /** Сохраняются ли координаты после этого запроса. ЭТО и есть та
   * разница, о которой экран молчал. */
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

/** Применения, после которых координаты остаются в базе. Отдельная
 * функция, а не проверка флага на месте вызова: список должен
 * пополняться в одном месте, иначе шестое применение забудут внести. */
export function storesCoordinates(purpose: string): boolean {
  return locationPurposeSpec(purpose)?.storesCoordinates === true;
}

/** Покрывает ли выданное согласие конкретное применение.
 *
 * ПУСТОЙ СПИСОК НЕ ПОКРЫВАЕТ НИЧЕГО — и это осознанный выбор, а не
 * оплошность. Толковать пустоту как «разрешено всё» значило бы вернуть
 * ровно ту дыру, которую пункт закрывает, только тихо и через дверь
 * «старая запись». Обе двери в продукте пишут `purposes` с самого
 * начала, так что пустой список означает согласие, выданное мимо них —
 * то есть согласие, слов которого никто не знает. */
export function coversPurpose(purposes: readonly string[] | null | undefined, purpose: string): boolean {
  return Array.isArray(purposes) && purposes.includes(purpose);
}

// Пункт [investment] §10.1 ТЗ — гео→юрисдикція, переюз уже наявного
// User.country (Пункт 49), НЕ новий механізм згоди. Країна мапиться на
// ЮРИСДИКЦІЙНИЙ БАКЕТ, не кожна країна має власний запис (нереалістичний
// обсяг) — групується за тим, яке законодавство реально застосовне.

export type JurisdictionBucket = 'US' | 'EU' | 'UA' | 'OTHER';

// EU-27, ISO 3166-1 alpha-2.
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

/** Чесна межа бакетів, не прихована спрощеність (§10.1 ТЗ): 'US' —
 * тільки федеральне законодавство, окремі штати/міста (NYC, Illinois,
 * Colorado) мають ДОДАТКОВІ закони понад федеральні, не включені в
 * бакет-рівень деталізації. 'EU' — законодавство ЄС, окремі
 * країни-члени можуть мати суворіші національні норми поверх
 * директив, так само не деталізовано на рівні країни. */
/** Полный аудит 2026-08-30 — до этого функция получала User.country
 * (название, «Україна»), а не код, и всегда возвращала OTHER. Теперь
 * первичный вход — User.countryCode; название — fallback для тех, кто
 * ввёл страну руками до появления кода. Таблица намеренно короткая:
 * только страны, у которых есть свой бакет (US/UA/EU), остальное — OTHER
 * по определению. */
const NAME_TO_CODE: Record<string, string> = {
  'україна': 'UA', 'украина': 'UA', 'ukraine': 'UA',
  'сша': 'US', 'united states': 'US', 'united states of america': 'US', 'usa': 'US', 'соединённые штаты': 'US', 'соединенные штаты': 'US',
  'deutschland': 'DE', 'germany': 'DE', 'германия': 'DE', 'німеччина': 'DE',
  'france': 'FR', 'франция': 'FR', 'франція': 'FR',
  'polska': 'PL', 'poland': 'PL', 'польша': 'PL', 'польща': 'PL',
  'italia': 'IT', 'italy': 'IT', 'италия': 'IT', 'італія': 'IT',
  'españa': 'ES', 'spain': 'ES', 'испания': 'ES', 'іспанія': 'ES',
  'nederland': 'NL', 'netherlands': 'NL', 'нидерланды': 'NL', 'нідерланди': 'NL',
  'česko': 'CZ', 'czechia': 'CZ', 'czech republic': 'CZ', 'чехия': 'CZ', 'чехія': 'CZ',
  'österreich': 'AT', 'austria': 'AT', 'австрия': 'AT', 'австрія': 'AT',
  'portugal': 'PT', 'португалия': 'PT', 'португалія': 'PT',
  'ireland': 'IE', 'éire': 'IE', 'ирландия': 'IE', 'ірландія': 'IE',
  'lietuva': 'LT', 'lithuania': 'LT', 'литва': 'LT',
  'latvija': 'LV', 'latvia': 'LV', 'латвия': 'LV', 'латвія': 'LV',
  'eesti': 'EE', 'estonia': 'EE', 'эстония': 'EE', 'естонія': 'EE',
  'românia': 'RO', 'romania': 'RO', 'румыния': 'RO', 'румунія': 'RO',
  'slovensko': 'SK', 'slovakia': 'SK', 'словакия': 'SK', 'словаччина': 'SK',
  'magyarország': 'HU', 'hungary': 'HU', 'венгрия': 'HU', 'угорщина': 'HU',
  'българия': 'BG', 'bulgaria': 'BG', 'болгария': 'BG', 'болгарія': 'BG',
  'sverige': 'SE', 'sweden': 'SE', 'швеция': 'SE', 'швеція': 'SE',
  'danmark': 'DK', 'denmark': 'DK', 'дания': 'DK', 'данія': 'DK',
  'suomi': 'FI', 'finland': 'FI', 'финляндия': 'FI', 'фінляндія': 'FI',
  'belgië': 'BE', 'belgique': 'BE', 'belgium': 'BE', 'бельгия': 'BE', 'бельгія': 'BE',
  'ελλάδα': 'GR', 'greece': 'GR', 'греция': 'GR', 'греція': 'GR',
  'hrvatska': 'HR', 'croatia': 'HR', 'хорватия': 'HR', 'хорватія': 'HR',
  'slovenija': 'SI', 'slovenia': 'SI', 'словения': 'SI', 'словенія': 'SI',
  'luxembourg': 'LU', 'люксембург': 'LU',
  'malta': 'MT', 'мальта': 'MT',
  'κύπρος': 'CY', 'cyprus': 'CY', 'кипр': 'CY', 'кіпр': 'CY',
};

export function countryNameToCode(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  if (/^[a-z]{2}$/i.test(key)) return key.toUpperCase();
  return NAME_TO_CODE[key] ?? null;
}

export function resolveJurisdictionBucket(countryCode: string | null | undefined, countryName?: string | null): JurisdictionBucket {
  const resolved = countryCode && /^[A-Za-z]{2}$/.test(countryCode) ? countryCode : countryNameToCode(countryCode) ?? countryNameToCode(countryName);
  if (!resolved) return 'OTHER';
  const code = resolved.toUpperCase();
  if (code === 'US') return 'US';
  if (code === 'UA') return 'UA';
  if (EU_COUNTRIES.has(code)) return 'EU';
  return 'OTHER';
}

// Пункт [job-domain-v2] §3.7 / §13.4 — открытые реестры по юрисдикции.
//
// Конфигурация EMPLOYER_REGISTRY_HOSTS — JSON вида
//   { "UA": [{ "host": "usr.minjust.gov.ua", "category": "REGISTRY", "urlTemplate"?: "https://…/{registryCode}" }, …] }
// Хост без urlTemplate — только РАЗРЕШЁН как источник для ссылок пользователя
// (реестр, у которого нет прямого URL по коду); хост с шаблоном — продукт
// подставляет код компании и загружает сам (fetchUrlText, те же потолки).
//
// Юрисдикции вне списка честно пусты: досье с ней принимает только ссылки
// пользователя и говорит об этом («реестры этой юрисдикции не подключены»).
// Списки ЕС/США добавляет владелец конфигурацией; код не меняется.
//
// По умолчанию — Украина. Официальные реестры перечислены как разрешённые
// хосты; шаблоны даны для агрегаторов открытых данных ЄДР — это осознанный
// компромисс, названный здесь, а не спрятанный: у официального ЄДР нет
// стабильного URL «по коду», у агрегаторов есть. Владелец может убрать их
// одной строкой конфигурации.

import { EmployerFactCategory } from '@prisma/client';

export interface RegistryHost {
  host: string;
  category: EmployerFactCategory;
  urlTemplate?: string;
  label?: string;
}

export const DEFAULT_REGISTRY_HOSTS: Record<string, RegistryHost[]> = {
  UA: [
    { host: 'usr.minjust.gov.ua', category: EmployerFactCategory.REGISTRY, label: 'Єдиний державний реєстр (Мін’юст)' },
    { host: 'opendatabot.ua', category: EmployerFactCategory.REGISTRY, urlTemplate: 'https://opendatabot.ua/c/{registryCode}', label: 'Opendatabot — агрегатор открытых данных ЄДР' },
    { host: 'youcontrol.com.ua', category: EmployerFactCategory.REGISTRY, urlTemplate: 'https://youcontrol.com.ua/catalog/company_details/{registryCode}/', label: 'YouControl — агрегатор открытых данных ЄДР' },
    { host: 'reyestr.court.gov.ua', category: EmployerFactCategory.COURT, label: 'Єдиний державний реєстр судових рішень' },
    { host: 'cabinet.tax.gov.ua', category: EmployerFactCategory.TAX, label: 'ДПС — реестр налогового долга' },
    { host: 'tax.gov.ua', category: EmployerFactCategory.TAX, label: 'ДПС' },
    { host: 'sanctions.nazk.gov.ua', category: EmployerFactCategory.SANCTIONS, label: 'НАЗК — санкционные списки' },
    { host: 'drs.nsdc.gov.ua', category: EmployerFactCategory.SANCTIONS, label: 'РНБО — Державний реєстр санкцій' },
  ],
};

// Пункт [typo-looked-like-a-decision] 2026-09-30. Битый JSON в
// переменной молча заменялся полным списком по умолчанию — без строки в
// логе. Владелец, СУЗИВШИЙ список реестров (например убравший
// агрегаторы `opendatabot.ua` и `youcontrol.com.ua`) и поставивший
// лишнюю запятую, получал ровно то, что убирал, и ни одного признака
// того, что его настройку не прочитали. «Опечатался» и «решил так»
// выглядели одинаково — та же порода, что «пробел выглядит как
// полнота», только на стороне оператора. Дефолт остаётся дефолтом
// (падать на старте из-за переменной, у которой есть осмысленное
// умолчание, хуже), но теперь он назван вслух.
function registryHostsFallbackReason(reason: string): Record<string, RegistryHost[]> {
  console.error(
    `EMPLOYER_REGISTRY_HOSTS не прочитана (${reason}) — взят список реестров по умолчанию. ` +
      'Если список задавался намеренно, он СЕЙЧАС НЕ ДЕЙСТВУЕТ.',
  );
  return DEFAULT_REGISTRY_HOSTS;
}

export function loadRegistryHosts(env: NodeJS.ProcessEnv = process.env): Record<string, RegistryHost[]> {
  const raw = env.EMPLOYER_REGISTRY_HOSTS;
  // Не выставлена — это не ошибка, а обычный случай: молчим.
  if (!raw) return DEFAULT_REGISTRY_HOSTS;
  try {
    const parsed = JSON.parse(raw) as Record<string, RegistryHost[]>;
    if (typeof parsed !== 'object' || parsed === null) {
      return registryHostsFallbackReason('разобранное значение не объект');
    }
    return parsed;
  } catch (err) {
    return registryHostsFallbackReason(
      `JSON не разобран: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function normalizeHost(hostOrUrl: string): string | null {
  try {
    const h = hostOrUrl.includes('://') ? new URL(hostOrUrl).hostname : hostOrUrl.split('/')[0];
    return h.toLowerCase().replace(/^www\./, '').trim() || null;
  } catch {
    return null;
  }
}

/** Хост URL принадлежит реестру юрисдикции (точно или поддомен). */
export function isRegistryUrl(url: string, jurisdiction: string, hosts = loadRegistryHosts()): RegistryHost | null {
  const host = normalizeHost(url);
  if (!host) return null;
  for (const r of hosts[jurisdiction] ?? []) {
    const rh = normalizeHost(r.host);
    if (rh && (host === rh || host.endsWith(`.${rh}`))) return r;
  }
  return null;
}

/** Домен почты вида "hr@company.com" или "company.com" → "company.com". */
export function extractDomain(contact: string | null | undefined): string | null {
  if (!contact) return null;
  const at = contact.lastIndexOf('@');
  const raw = at >= 0 ? contact.slice(at + 1) : contact;
  return normalizeHost(raw);
}

/** Признаки, что строка — название компании, а не имя человека (§3.9 /
 * приёмка 37). Эвристика, названная честно: ловит очевидное («Іван Петренко»),
 * не претендует на большее. */
const LEGAL_FORM_MARKERS = /\b(тов|тзов|пп|ат|прат|пат|фоп|фо-п|кп|дп|ооо|оао|зао|ип|llc|ltd|inc|gmbh|s\.?a\.?|oü|sp\.? z o\.?o|corp|company|group|studio|agency|bank|holding|лтд|компанія|компания|агентство|студія|студия|банк)\b/i;

export function looksLikePersonName(legalName: string): boolean {
  const s = legalName.trim();
  if (LEGAL_FORM_MARKERS.test(s)) return false;
  if (/[«"„0-9&.,/-]/.test(s)) return false;
  const words = s.split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;
  return words.every((w) => /^[А-ЯЁІЇЄҐA-Z][а-яёіїєґa-z'’-]+$/.test(w));
}

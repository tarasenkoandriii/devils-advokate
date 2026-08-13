// Детекторы для ContentScanService (§8 ТЗ, пп. 18-19).
//
// ЧЕСТНО О ГРАНИЦАХ ЭТОЙ РЕАЛИЗАЦИИ (не приукрашено):
// - PHONE/EMAIL/BANKING — regex-based, разумное покрытие для MVP,
//   но не production-grade DLP (будут ложные срабатывания и пропуски
//   на нестандартных форматах).
// - ADDRESS/PASSPORT — НЕТ надёжного способа детектировать это regex'ом
//   без ложных срабатываний в разных странах/форматах. Реализованы как
//   низко-уверенные эвристики, специально помечены confidence < 0.5 и
//   НЕ редактируются автоматически (см. content-scan.service.ts) — только
//   флагуются для внимания пользователя, чтобы не портить легитимный
//   текст агрессивной автозаменой на основе ненадёжного паттерна.
// - PII_FACE/PII_LICENSE_PLATE — не реализованы вообще. Это распознавание
//   изображений (компьютерное зрение), а не текста; вне рамок текстового
//   regex-пайплайна. Соответствует переоценке фичи 12 (Safe Share) —
//   там прямо зафиксировано "распознавание лиц/номеров на фото —
//   нереалистично для MVP, откладывается".
// - PROMPT_INJECTION — список сигнатур, не ML-классификатор. Ловит
//   типовые/известные паттерны, не гарантирует защиту от изощрённых
//   обходов. Это первый рубеж защиты, не единственный — при реальной
//   угрозе нужен отдельный классификатор, не входит в объём MVP.

export type DetectionType =
  | 'PII_PHONE'
  | 'PII_EMAIL'
  | 'PII_ADDRESS'
  | 'PII_PASSPORT'
  | 'PII_BANKING'
  | 'PROMPT_INJECTION';

export interface RawMatch {
  type: DetectionType;
  index: number;
  raw: string; // только для построения maskedPreview внутри процесса — persistence-слой обязан никогда не сохранять это поле как есть
  confidence: number;
}

const PHONE_REGEX = /(\+?\d[\d\-\s()]{7,}\d)/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Последовательности цифр длиной 13-19 (типичная длина карточных номеров),
// допускаются разделители пробелом/дефисом.
const CARD_CANDIDATE_REGEX = /\b(?:\d[ -]?){13,19}\b/g;
// Низкоуверенная эвристика паспорта: 1-2 буквы + 6-8 цифр — покрывает
// часть форматов (например СН######), но далеко не все страны.
const PASSPORT_HEURISTIC_REGEX = /\b[A-ZА-Я]{1,2}\d{6,8}\b/g;
// Низкоуверенная эвристика адреса: слово "ул."/"вул."/"просп." + число рядом.
const ADDRESS_HEURISTIC_REGEX = /\b(ул\.?|вул\.?|просп\.?|пер\.?)\s+[А-Яа-яA-Za-z\s]{2,30}\d{1,4}/giu;

const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|above|prior)/i,
  /you\s+are\s+now\s+/i,
  /new\s+system\s+prompt/i,
  /reveal\s+(your|the)\s+(system\s+)?prompt/i,
  /act\s+as\s+(an?\s+)?unrestricted/i,
  /pretend\s+(you\s+have\s+no|to\s+have\s+no)\s+(restrictions|rules|filters)/i,
  /-{3,}\s*BEGIN\s+SYSTEM/i,
  /\[\s*system\s*\]/i,
  /забудь\s+(все\s+)?(предыдущие\s+)?инструкции/iu,
  /игнорируй\s+(все\s+)?(предыдущие\s+)?инструкции/iu,
];

function luhnCheck(digitsOnly: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let n = parseInt(digitsOnly[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function findAll(regex: RegExp, text: string, type: DetectionType, confidence: number): RawMatch[] {
  const matches: RawMatch[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  while ((m = re.exec(text)) !== null) {
    matches.push({ type, index: m.index, raw: m[0], confidence });
    if (m[0].length === 0) re.lastIndex++; // защита от бесконечного цикла на пустых совпадениях
  }
  return matches;
}

export function detectPromptInjection(text: string): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      matches.push({ type: 'PROMPT_INJECTION', index: m.index, raw: m[0], confidence: 0.85 });
    }
  }
  return matches;
}

export function detectPII(text: string): RawMatch[] {
  const results: RawMatch[] = [];

  results.push(...findAll(EMAIL_REGEX, text, 'PII_EMAIL', 0.9));
  results.push(...findAll(PHONE_REGEX, text, 'PII_PHONE', 0.6)); // умеренная уверенность — короткие числовые последовательности дают ложные срабатывания

  const cardCandidates = findAll(CARD_CANDIDATE_REGEX, text, 'PII_BANKING', 0.5);
  for (const candidate of cardCandidates) {
    const digitsOnly = candidate.raw.replace(/[^\d]/g, '');
    if (digitsOnly.length >= 13 && luhnCheck(digitsOnly)) {
      results.push({ ...candidate, confidence: 0.85 }); // Luhn-валидный номер — повышаем уверенность
    }
    // Luhn-невалидные кандидаты отбрасываются целиком — иначе слишком
    // много ложных срабатываний на обычных числовых последовательностях
  }

  results.push(...findAll(PASSPORT_HEURISTIC_REGEX, text, 'PII_PASSPORT', 0.3));
  results.push(...findAll(ADDRESS_HEURISTIC_REGEX, text, 'PII_ADDRESS', 0.3));

  return results;
}

export function maskPreview(raw: string): string {
  if (raw.length <= 4) return '*'.repeat(raw.length);
  return `${raw.slice(0, 2)}${'*'.repeat(Math.max(raw.length - 4, 1))}${raw.slice(-2)}`;
}

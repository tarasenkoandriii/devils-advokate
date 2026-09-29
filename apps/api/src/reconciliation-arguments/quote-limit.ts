// Аудит 2026-09-03 («правило, которое держится только промптом»).
//
// Промпт аргументов примирения содержит прямое требование по АВТОРСКОМУ
// ПРАВУ: цитата из первоисточника — короче 15 слов, не больше одной на
// аргумент, остальное — пересказ своими словами. Проверялось при этом
// только то, что поля непустые: длинную дословную цитату модель могла
// вернуть, и она уходила в базу и в интерфейс.
//
// Это ровно тот случай, где промпт барьером быть не может: нарушение
// стоит не «качества ответа», а воспроизведения защищённого текста в
// продукте. Барьер тут детерминированный и грубый — считает слова внутри
// кавычек. Он не отличает цитату от пересказа в кавычках и не должен:
// длинный закавыченный фрагмент первоисточника — ровно то, чего быть не
// должно, независимо от намерения модели.

export const MAX_QUOTE_WORDS = 15;

const QUOTE_PATTERNS = [
  /«([^»]+)»/g,
  /"([^"]+)"/g,
  /“([^”]+)”/g,
];

/** Все закавыченные фрагменты текста. */
export function quotedSpans(text: string): string[] {
  const out: string[] = [];
  for (const re of QUOTE_PATTERNS) {
    for (const m of text.matchAll(re)) out.push(m[1]);
  }
  return out;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export interface QuoteLimitCheck {
  ok: boolean;
  /** Длиннее допустимого — что именно нашли (для честного объяснения). */
  tooLong: string[];
  quoteCount: number;
}

export function checkQuoteLimits(text: string, maxWords = MAX_QUOTE_WORDS): QuoteLimitCheck {
  const spans = quotedSpans(text);
  const tooLong = spans.filter((s) => wordCount(s) > maxWords);
  // Больше одной цитаты на аргумент — тоже нарушение правила промпта, но
  // менее опасное: две короткие цитаты не воспроизводят фрагмент целиком.
  // Поэтому оно НЕ роняет аргумент, а только считается — иначе продукт
  // молча терял бы полезные ответы из-за оформления.
  return { ok: tooLong.length === 0, tooLong, quoteCount: spans.length };
}

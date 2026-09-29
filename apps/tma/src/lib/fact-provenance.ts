// Пункт [source-collapse] 2026-09-05 — происхождение факта на экране.
//
// НАЙДЕНО: продукт заставляет человека выбрать происхождение каждого
// факта о другом человеке — 🟢 личная запись, 🔵 публичный факт, ⚪ моё
// предположение, — и больше НИКОГДА ему этого выбора не показывает.
// В сохранённом списке стоял голый текст факта. Через неделю собственная
// догадка читается как установленное, потому что отличить её не по чему;
// а состояние факта (оспорен, истёк) не показывалось вовсе.
//
// Метки те же, что в форме ввода: человек выбирал их этими словами,
// значит и видеть должен эти же. Другой набор слов для того же выбора —
// способ незаметно его переписать.

import type { FactSourceType } from './types';

export const FACT_SOURCE_LABEL: Record<string, string> = {
  PERSONAL_RECORD: '🟢 личная запись',
  PUBLIC_FACT: '🔵 публичный факт',
  USER_GUESS: '⚪ ваше предположение',
};

/** Состояние факта: показывается, только когда оно НЕ обычное. «ACTIVE»
 * рядом с каждой строкой — шум, который перестают читать; «оспорен» —
 * то, что человеку нужно видеть. */
export const FACT_STATUS_LABEL: Record<string, string> = {
  DISPUTED: 'оспорен',
  EXPIRED: 'истёк срок',
};

export function factSourceLabel(sourceType: FactSourceType | string): string {
  return FACT_SOURCE_LABEL[sourceType] ?? String(sourceType);
}

export function factStatusLabel(status: string | null | undefined): string | null {
  return status ? (FACT_STATUS_LABEL[status] ?? null) : null;
}

/** Догадка — единственная метка, к которой нужна не подпись, а
 * напоминание: остальные говорят, откуда факт, а эта — что факта, может
 * быть, и нет. */
export function isGuess(sourceType: FactSourceType | string): boolean {
  return sourceType === 'USER_GUESS';
}

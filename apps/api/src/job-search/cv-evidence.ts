// Пункт [job-domain-v2] К-22 / приёмка 40 — опора элементов CV на документ.
//
// Чистый модуль без зависимостей от сервисов: им пользуются и импорт
// (cv-import.service.ts), и барьер утверждения в JobSearchService. Разнесены
// они именно поэтому — сервис, который импортирует другой сервис, ради одной
// функции даёт цикл, а цикл в NestJS чинится костылём forwardRef.

import { quoteIsFromSource } from '../common/quote-match';
import { BadRequestException } from '@nestjs/common';
import type { CvDraft } from './job-search.service';

export interface CvEvidenceItem {
  path: string;
  quote: string;
}

export interface CvDraftEvidence {
  /** Откуда импортировано — свободная пометка пользователя (файл, письмо). */
  sourceRef: string | null;
  importedAt: string;
  /** Текст документа: нужен, чтобы перепроверять опору после правок руками. */
  sourceText: string;
  items: CvEvidenceItem[];
}

/** Все адресуемые элементы черновика — то, что обязано иметь опору. */
export function cvDraftElementPaths(draft: CvDraft): string[] {
  const paths: string[] = [];
  if (draft.headline?.trim()) paths.push('headline');
  if (draft.summary?.trim()) paths.push('summary');
  draft.skills.forEach((s, i) => {
    if (s.trim()) paths.push(`skills[${i}]`);
  });
  draft.education.forEach((e, i) => {
    if (e.trim()) paths.push(`education[${i}]`);
  });
  draft.experience.forEach((e, i) => {
    paths.push(`experience[${i}]`);
    e.highlights.forEach((h, j) => {
      if (h.trim()) paths.push(`experience[${i}].highlights[${j}]`);
    });
  });
  return paths;
}

/** Пункт [one-quote-rule] 2026-09-06: здесь была вторая копия барьера —
 * регистр и пробелы, но без типографики и без минимальной длины (цитата
 * в один символ проходила). Реализация одна, в
 * `common/quote-match.ts`; имя сохранено, потому что в домене поиска
 * работы источник называется документом, а не «источником». */
export function quoteIsFromDocument(quote: string, document: string): boolean {
  return quoteIsFromSource(quote, document);
}

/** Оставляет только опоры с существующим путём и цитатой ИЗ документа. */
export function sanitizeCvEvidence(raw: unknown, draft: CvDraft, document: string): CvEvidenceItem[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(cvDraftElementPaths(draft));
  const seen = new Set<string>();
  const out: CvEvidenceItem[] = [];
  for (const item of raw) {
    const path = typeof (item as CvEvidenceItem)?.path === 'string' ? (item as CvEvidenceItem).path : null;
    const quote = typeof (item as CvEvidenceItem)?.quote === 'string' ? (item as CvEvidenceItem).quote : null;
    if (!path || !quote || !known.has(path) || seen.has(path)) continue;
    if (!quoteIsFromDocument(quote, document)) continue; // «улучшенная» формулировка опорой не считается
    seen.add(path);
    out.push({ path, quote: quote.slice(0, 500) });
  }
  return out;
}

/** Элементы черновика без опоры — то, что не даст утвердить CV (приёмка 40). */
export function missingEvidencePaths(draft: CvDraft, evidence: CvEvidenceItem[]): string[] {
  const covered = new Set(evidence.map((e) => e.path));
  return cvDraftElementPaths(draft).filter((p) => !covered.has(p));
}

/** Человеческое имя пути — в сообщении об ошибке «experience[1].highlights[0]»
 * никому не помогает. */
export function describePath(path: string, draft: CvDraft): string {
  if (path === 'headline') return 'заголовок';
  if (path === 'summary') return 'краткое описание';
  const skill = /^skills\[(\d+)\]$/.exec(path);
  if (skill) return `навык «${draft.skills[Number(skill[1])] ?? ''}»`;
  const edu = /^education\[(\d+)\]$/.exec(path);
  if (edu) return `образование «${draft.education[Number(edu[1])] ?? ''}»`;
  const expH = /^experience\[(\d+)\]\.highlights\[(\d+)\]$/.exec(path);
  if (expH) {
    const e = draft.experience[Number(expH[1])];
    return `достижение «${e?.highlights[Number(expH[2])] ?? ''}» в «${e?.place ?? ''}»`;
  }
  const exp = /^experience\[(\d+)\]$/.exec(path);
  if (exp) {
    const e = draft.experience[Number(exp[1])];
    return `место работы «${e?.place ?? ''}» (${e?.period ?? 'период не указан'})`;
  }
  return path;
}


/** Приёмка 40: барьер утверждения. У черновика из онбординга опор нет по
 * построению (источник — сам разговор пользователя), и барьер к нему не
 * применяется; у импортированного — применяется всегда. */
export function assertEveryElementHasEvidence(cvDraft: unknown, cvDraftEvidence: unknown): void {
  const evidence = cvDraftEvidence as CvDraftEvidence | null;
  if (!evidence?.items) return;
  const draft = cvDraft as CvDraft;
  const missing = missingEvidencePaths(draft, evidence.items);
  if (missing.length === 0) return;
  throw new BadRequestException(
    `CV импортирован из документа, но эти элементы в нём дословно не найдены: ${missing.map((p) => describePath(p, draft)).join('; ')}. ` +
      'Утвердить можно только то, что стоит в вашем документе — поправьте черновик или импортируйте заново.',
  );
}

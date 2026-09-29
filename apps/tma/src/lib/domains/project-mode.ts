// Пункт [domain-not-mapped] 2026-09-06 — закон не показывался там, где
// его собрали.
//
// НАЙДЕНО. Блок «Что говорит закон» брал режим проекта из рукописной
// таблицы внутри самого компонента:
//
//   const MODE_BY_DOMAIN: Record<string, string> = {
//     dtp: 'DTP', 'family-law': 'FAMILY_LAW', health: 'HEALTH',
//     'interview-pool': 'INTERVIEW_POOL', investment: 'INVESTMENT',
//     'major-purchase': 'MAJOR_PURCHASE',
//   };
//   const mode = MODE_BY_DOMAIN[domainId];
//   if (!mode) { setData(null); return; }
//
// Доменов ВОСЕМЬ. В таблице ШЕСТЬ: «поиск работы» и «найм в компанию» в
// неё не попали — и для них блок не появлялся вовсе, молча. Ровно
// накануне для этих двух режимов были собраны нормы (украинская статья
// 11 о требованиях в вакансии, европейская директива о прозрачности
// оплаты, американская ADEA о формулировках объявления) — и увидеть их
// было нельзя ни при каких условиях.
//
// ПОЧЕМУ ЭТО СЛУЧИЛОСЬ. `Record<string, ...>` принимает любой ключ и
// молчит о пропущенном. Таблица была ВТОРЫМ экземпляром соответствия,
// которое уже существует: у домена есть id, у проекта — режим, и связь
// между ними однозначна. Второй экземпляр правды однажды расходится с
// первым — это ровно то, о чём пункт [consent-purpose] писал про
// `purposes`.
//
// ЧТО СДЕЛАНО ВМЕСТО ПРОВЕРКИ. Тип `Record<DomainId, ProjectModeName>`
// требует ВСЕ восемь ключей: новый домен без режима не соберётся
// компилятором. Это сильнее теста — забыть нельзя.

import type { DomainId } from './types';

/** Имена ProjectMode на стороне API. Строкой, а не импортом из
 * @prisma/client: TMA собирается отдельно и в prisma не ходит. */
export type ProjectModeName =
  | 'STANDARD' | 'MAJOR_PURCHASE' | 'INTERVIEW_POOL' | 'INVESTMENT'
  | 'HEALTH' | 'FAMILY_LAW' | 'DTP' | 'JOB_SEARCH' | 'EMPLOYER_HIRING';

/** Домен → режим проекта. Exhaustive по построению: пропуск ключа —
 * ошибка компиляции, а не тихо отсутствующий блок на экране. */
export const PROJECT_MODE_BY_DOMAIN: Record<DomainId, ProjectModeName> = {
  dtp: 'DTP',
  'family-law': 'FAMILY_LAW',
  health: 'HEALTH',
  'interview-pool': 'INTERVIEW_POOL',
  investment: 'INVESTMENT',
  'major-purchase': 'MAJOR_PURCHASE',
  // Эти два и потерялись в рукописной таблице.
  'job-search': 'JOB_SEARCH',
  'employer-hiring': 'EMPLOYER_HIRING',
};

export function projectModeForDomain(domainId: string): ProjectModeName | null {
  return (PROJECT_MODE_BY_DOMAIN as Record<string, ProjectModeName | undefined>)[domainId] ?? null;
}

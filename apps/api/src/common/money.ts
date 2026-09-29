// Аудит моделей БД 2026-08-30, §2.1 — деньги хранятся как Decimal(14,2).
// Prisma отдаёт их объектом Decimal (decimal.js); суммирование — только
// через Decimal, а не через `+` на double. На границе API Decimal
// превращается в number (см. ApiResponseInterceptor → decimalsToNumbers),
// чтобы контракт с TMA/admin не менялся: 2 знака после запятой double
// представляет точно для любых реальных сумм.
import { Prisma } from '@prisma/client';

export type MoneyLike = Prisma.Decimal | number | string | null | undefined;

export function toMoney(value: MoneyLike): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  return new Prisma.Decimal(value).toNumber();
}

/** Точная сумма через Decimal; результат — number с 2 знаками. */
export function sumMoney(values: MoneyLike[]): number {
  let acc = new Prisma.Decimal(0);
  for (const v of values) {
    if (v === null || v === undefined) continue;
    acc = acc.plus(v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v));
  }
  return acc.toDecimalPlaces(2).toNumber();
}

/** Рекурсивно заменяет Decimal → number в ответе (объекты, массивы). Даты
 * и прочие не-plain объекты не трогает. */
export function decimalsToNumbers<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (input instanceof Prisma.Decimal) return input.toNumber() as unknown as T;
  if (Array.isArray(input)) return input.map(decimalsToNumbers) as unknown as T;
  if (typeof input === 'object') {
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return input; // Date, Buffer, class instances
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = decimalsToNumbers(v);
    return out as T;
  }
  return input;
}

/** Аудит денег 2026-09-03. Валюта строки расхода — трёхбуквенный код или
 * null. null означает «валюта проекта», а не «валюты нет»: именно так это
 * поле задумано в трёх ТЗ (DtpConsultation.currency и его близнецы), где
 * оно появилось, чтобы прекратить молчаливое допущение «всё в валюте
 * конфига». Нормализация здесь одна на все домены — иначе «usd», «USD» и
 * «Usd» станут тремя разными валютами в группировке. */
export function normalizeCurrency(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  return code;
}

/** Суммы по валютам. Смешивать валюты в одном числе нельзя: «итого 15 000»
 * из гривен и долларов — уверенно показанная неправда, ровно то, чего этот
 * продукт не делает. fallback — валюта проекта для строк без своей. */
export function sumByCurrency(
  rows: Array<{ amount: MoneyLike; currency?: string | null }>,
  fallbackCurrency: string | null,
): Array<{ currency: string | null; total: number }> {
  const buckets = new Map<string, MoneyLike[]>();
  for (const row of rows) {
    if (row.amount === null || row.amount === undefined) continue;
    const code = normalizeCurrency(row.currency) ?? normalizeCurrency(fallbackCurrency);
    const key = code ?? '';
    buckets.set(key, [...(buckets.get(key) ?? []), row.amount]);
  }
  return [...buckets.entries()].map(([code, values]) => ({ currency: code === '' ? null : code, total: sumMoney(values) }));
}

// ─────────────────────────────────────────────────────────────────────
// Пункт [budget-invented-a-currency] 2026-09-24.
//
// Правило «смешивать валюты в одном числе нельзя» было записано выше
// ещё в аудите денег 2026-09-03 — и применялось ровно в ОДНОМ месте.
// Три домена (ДТП, семейное право, здоровье) считали бюджет каждый
// сам, одинаково и одинаково неверно:
//
//     const key = item.currency ?? 'UNSPECIFIED';
//
// Три следствия, и все три доходят до человека.
//
// 1. `null` здесь значит НЕ «валюты нет», а «валюта проекта» — так это
//    поле и задумано (см. `normalizeCurrency` выше). Отправляя такие
//    строки в отдельную корзину, расчёт ЗАНИЖАЛ итог в валюте проекта:
//    экран показывал, что человек в рамках целевого бюджета, когда он
//    уже за ним.
// 2. Регистр не приводился, и «usd», «USD», «Usd» становились тремя
//    валютами — ровно то, против чего `normalizeCurrency` и заведена.
// 3. Слово `UNSPECIFIED` уходило наружу как код валюты: на экран
//    жирной строкой и в черновик документа для юриста — «1200
//    UNSPECIFIED».
//
// Сравнение с целевым бюджетом тоже считалось не здесь, а на экране, и
// при незаданной валюте проекта сравнивало с целью корзину ЛЮБОЙ
// валюты. Теперь решение принимается там же, где лежит правило, и
// «не с чем сравнивать» — это отдельный ответ, а не молчание: молчание
// на экране читается как «в пределах бюджета».
// ─────────────────────────────────────────────────────────────────────

export type BudgetDirectionLike = 'EXPENSE' | 'COVERAGE' | string;

export interface BudgetRow {
  amount: MoneyLike;
  currency?: string | null;
  direction: BudgetDirectionLike;
}

/** Итог по целевому бюджету для одной валютной корзины.
 * `not-comparable` — не «уложились», а «сравнивать не с чем»: цель
 * задана в другой валюте либо не задана вовсе. Продукт не переводит
 * валюты и не притворяется, что умеет. */
export type TargetComparison = 'over' | 'within' | 'not-comparable';

export interface BudgetBucket {
  /** Трёхбуквенный код либо `null` — «валюта не указана ни у строки,
   * ни у проекта». Именно `null`, а не слово-заглушка: заглушка
   * неотличима от настоящего кода там, где её показывают человеку. */
  currency: string | null;
  totalExpense: number;
  totalCoverage: number;
  netBudget: number;
  targetComparison: TargetComparison;
}

export function compareToTarget(
  netBudget: number,
  targetBudget: MoneyLike,
  bucketCurrency: string | null,
  projectCurrency: string | null,
): TargetComparison {
  if (targetBudget === null || targetBudget === undefined) return 'not-comparable';
  if (bucketCurrency !== normalizeCurrency(projectCurrency)) return 'not-comparable';
  return netBudget > toMoney(targetBudget) ? 'over' : 'within';
}

/** Бюджет по валютам: расход, покрытие и разница — по каждой валюте
 * отдельно, со сравнением с целью там и только там, где оно осмысленно.
 * Строка без своей валюты относится к валюте проекта. */
export function budgetByCurrency(
  rows: BudgetRow[],
  projectCurrency: string | null,
  targetBudget: MoneyLike = null,
): BudgetBucket[] {
  const fallback = normalizeCurrency(projectCurrency);
  const buckets = new Map<string, { expense: MoneyLike[]; coverage: MoneyLike[] }>();
  for (const row of rows) {
    const code = normalizeCurrency(row.currency) ?? fallback;
    const key = code ?? '';
    const bucket = buckets.get(key) ?? { expense: [], coverage: [] };
    if (row.direction === 'EXPENSE') bucket.expense.push(row.amount);
    else bucket.coverage.push(row.amount);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()].map(([key, v]) => {
    const currency = key === '' ? null : key;
    const totalExpense = sumMoney(v.expense);
    const totalCoverage = sumMoney(v.coverage);
    const netBudget = sumMoney([totalExpense, -totalCoverage]);
    return {
      currency,
      totalExpense,
      totalCoverage,
      netBudget,
      targetComparison: compareToTarget(netBudget, targetBudget, currency, projectCurrency),
    };
  });
}

/** Сумма словами для человека: код валюты либо честная пометка о том,
 * что валюта не указана. Никогда — слово-заглушка, похожее на код. */
export const CURRENCY_UNSET_LABEL = 'валюта не указана';

export function moneyWithCurrency(amount: number, currency: string | null): string {
  return currency ? `${amount} ${currency}` : `${amount} (${CURRENCY_UNSET_LABEL})`;
}

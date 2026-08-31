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

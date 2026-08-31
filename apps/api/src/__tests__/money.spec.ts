// Аудит моделей БД 2026-08-30 §2.1 — Decimal вместо Float для денег.
import { Prisma } from '@prisma/client';
import { decimalsToNumbers, sumMoney, toMoney } from '../common/money';

describe('common/money', () => {
  it('sumMoney точен там, где double плывёт (0.1 + 0.2)', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumMoney([new Prisma.Decimal('0.1'), new Prisma.Decimal('0.2')])).toBe(0.3);
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
  });

  it('sumMoney принимает Decimal, number, string, null и отрицательные значения', () => {
    expect(sumMoney([new Prisma.Decimal('1500.50'), 249.5, '250', null, undefined, -1000])).toBe(1000);
  });

  it('sumMoney копейки: 100 × 0.01 = 1.00 ровно', () => {
    expect(sumMoney(Array.from({ length: 100 }, () => new Prisma.Decimal('0.01')))).toBe(1);
  });

  it('toMoney: null → 0, Decimal → number, number как есть', () => {
    expect(toMoney(null)).toBe(0);
    expect(toMoney(new Prisma.Decimal('12.34'))).toBe(12.34);
    expect(toMoney(7)).toBe(7);
  });

  it('decimalsToNumbers обходит вложенные объекты/массивы, не трогает Date и не мутирует вход', () => {
    const when = new Date('2026-01-01T00:00:00Z');
    const input = { amount: new Prisma.Decimal('10.5'), nested: { items: [{ price: new Prisma.Decimal('1.25') }, { price: null }], when }, plain: 'x' };
    const out = decimalsToNumbers(input) as any;
    expect(out.amount).toBe(10.5);
    expect(out.nested.items[0].price).toBe(1.25);
    expect(out.nested.items[1].price).toBeNull();
    expect(out.nested.when).toBe(when);
    expect(out.plain).toBe('x');
    expect(input.amount).toBeInstanceOf(Prisma.Decimal);
  });
});

// Пункт [ceilings-nobody-was-told-about] 2026-09-24 — утверждения о самом
// реестре потолков. Файлов эта спека не читает: соседняя,
// `…-ceilings-nobody-was-told-about.spec.ts`, сверяет реестр с
// документацией и кодом, а здесь — только то, что реестр говорит о себе.

import { SPEND_LIMITS } from '../common/spend-limits';

describe('[ceilings-nobody-was-told-about] реестр потолков расходов', () => {
  it('зашитые в код потолки названы зашитыми, а не выданы за настраиваемые', () => {
    const hardcoded = SPEND_LIMITS.filter((l) => l.env === null);
    expect(hardcoded.length).toBeGreaterThan(0);
    for (const l of hardcoded) expect(l.costs).toMatch(/зашит в коде/);
  });
});

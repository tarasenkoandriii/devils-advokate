// Пункт [one-of-several-spoke-for-all] 2026-09-25 — что именно читает
// человек, столкнувшись с неоднозначностью. Файлов эта спека не читает.

import { manyCompaniesMessage } from '../employer-dossier/single-dossier';

describe('[one-of-several-spoke-for-all] формулировка про несколько компаний', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: человеку говорят, ИЗ ЧЕГО выбирать, а не просто «неоднозначно»', () => {
    const msg = manyCompaniesMessage(['ТОВ Ромашка', 'ТОВ Василёк']);
    expect(msg).toContain('ТОВ Ромашка');
    expect(msg).toContain('ТОВ Василёк');
    // И что делать дальше — тоже сказано: сообщение без выхода это
    // тупик, а не честность.
    expect(msg).toMatch(/оставьте|объедините/i);
  });
});

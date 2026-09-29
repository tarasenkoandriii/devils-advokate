// Аудит денег 2026-09-03 — сумма, у которой нет одной валюты.
//
// У консультации есть СВОЯ валюта: поле добавляли три ТЗ подряд (dtp-v2,
// family-law-v2, полный аудит для health) ровно затем, чтобы прекратить
// молчаливое допущение «всё в валюте проекта». Сверка показала, что поле
// никто не писал и никто не читал: маршрут создания его не принимал, а
// сводка складывала все оценки в одно число и показывала его с валютой
// проекта. Оценка юриста в долларах и эксперта в гривнах превращались в
// «итого ₴15 000» — это не округление, это уверенно показанная неправда.
import { normalizeCurrency, sumByCurrency, sumMoney } from '../common/money';

describe('Валюта строки расхода', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: разные валюты не складываются в одно число', () => {
    const rows = [
      { amount: 5000, currency: 'UAH' },
      { amount: 300, currency: 'USD' },
      { amount: 2000, currency: 'UAH' },
    ];
    const byCurrency = sumByCurrency(rows, 'UAH');
    expect(byCurrency).toHaveLength(2);
    expect(byCurrency.find((b) => b.currency === 'UAH')!.total).toBe(7000);
    expect(byCurrency.find((b) => b.currency === 'USD')!.total).toBe(300);
  });

  it('строка без своей валюты считается в валюте проекта — это документированный смысл null, а не «валюты нет»', () => {
    const byCurrency = sumByCurrency([{ amount: 100, currency: null }, { amount: 50, currency: 'UAH' }], 'UAH');
    expect(byCurrency).toEqual([{ currency: 'UAH', total: 150 }]);
  });

  it('регистр и пробелы не создают третью валюту', () => {
    const byCurrency = sumByCurrency([{ amount: 1, currency: 'usd' }, { amount: 2, currency: ' USD ' }], null);
    expect(byCurrency).toEqual([{ currency: 'USD', total: 3 }]);
  });

  it('мусор вместо кода валюты не сохраняется как валюта', () => {
    expect(normalizeCurrency('гривны')).toBeNull();
    expect(normalizeCurrency('$')).toBeNull();
    expect(normalizeCurrency('')).toBeNull();
    expect(normalizeCurrency('eur')).toBe('EUR');
  });

  it('когда валюта неизвестна нигде — сумма считается, но без подписи, а не под валютой проекта', () => {
    expect(sumByCurrency([{ amount: 10, currency: null }], null)).toEqual([{ currency: null, total: 10 }]);
  });

  it('точность сохраняется: копейки не уплывают через double', () => {
    expect(sumMoney(['0.10', '0.20'])).toBe(0.3);
    expect(sumByCurrency([{ amount: '0.10', currency: 'USD' }, { amount: '0.20', currency: 'USD' }], null)[0].total).toBe(0.3);
  });
});

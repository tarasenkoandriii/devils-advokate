// Сверка [operator-money-untraced] 2026-09-24 — утверждения о РЕЕСТРЕ,
// отдельным файлом.
//
// Отдельно по той же причине, что и в прошлой сверке: сторож проверок
// считает `toContain`/`toMatch` в каждом файле, который читает
// исходники, и сам называет эту погрешность — утверждения на массивах,
// лежащие рядом с таким чтением, завышают счёт, не опираясь ни на какой
// текст. Здесь никакого чтения нет.

import { AUDITED_OPERATOR_ACTIONS, UNAUDITED_OPERATOR_ACTIONS } from '../audit-log/operator-actions';

describe('[operator-money-untraced]: реестр операторских действий', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: деньги и место в выдаче — среди тех, что обязаны оставлять след', () => {
    // Именно эти два и были найдены молчащими. Имена живут в одном
    // месте, чтобы читатель журнала и писатель не разъехались.
    expect(AUDITED_OPERATOR_ACTIONS).toContain('approved_venue.referral_fee_set');
    expect(AUDITED_OPERATOR_ACTIONS).toContain('approved_venue.priority_partner_set');
    // И соседи по тому же объекту, аудировавшиеся с самого начала, —
    // чтобы правка не забрала лишнего.
    expect(AUDITED_OPERATOR_ACTIONS).toContain('venue_application.approved');
    expect(AUDITED_OPERATOR_ACTIONS).toContain('venue_application.rejected');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни одно действие не числится одновременно пишущим и освобождённым', () => {
    // Иначе реестр говорил бы обе вещи сразу, и любая из них была бы
    // «правдой» на выбор читающего.
    const excused = new Set(UNAUDITED_OPERATOR_ACTIONS.map((a) => `${a.service}.${a.method}`));
    for (const action of AUDITED_OPERATOR_ACTIONS) {
      expect([action, excused.has(action)]).toEqual([action, false]);
    }
    // У каждой записи реестра есть причина — пустых освобождений нет.
    for (const a of UNAUDITED_OPERATOR_ACTIONS) {
      expect([a.method, typeof a.reason === 'string' && a.reason.length > 0]).toEqual([a.method, true]);
    }
  });
});

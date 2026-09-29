// Пункт [the-sentence-did-not-look-at-the-fact] 2026-09-25 — фраза о
// последствиях не смотрела на то, что произошло.
//
// Обход цепочки копий ограничен глубиной и честно возвращает
// `depthExhausted`. А человеку отдавалась ФИКСИРОВАННАЯ пара фраз, одна
// и та же в обоих случаях: «копии, которые уже успели принять по этим
// ссылкам, помечены отозванными тоже». При исчерпанной глубине это
// неправда — и неправда самая дорогая: человек отозвал согласие, и ему
// сказали, что копии закрыты.

import { revocationAlsoDone, revocationDoesNotUndo } from '../interview-pool/revocation-report';
import { MAX_COPY_CHAIN_DEPTH } from '../interview-pool/consent-revocation';

const BASE = 'Ответы, которые вы уже отправили, у получателя останутся.';

describe('[the-sentence-did-not-look-at-the-fact] текст последствий строится из исхода', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: недойденная цепочка названа, и сказано, что делать', () => {
    const text = revocationDoesNotUndo({ sharesRevoked: 2, copiesRevoked: 1, depthExhausted: true }, BASE);
    expect(text).toContain(BASE); // постоянная часть не потерялась
    expect(text).toContain(String(MAX_COPY_CHAIN_DEPTH));
    expect(text).toContain('не «всё закрыто»');
    expect(text).toContain('поддержку');
  });

  it('ОБРАТНАЯ ПРОБА: цепочка пройдена целиком — ни слова лишнего', () => {
    // Предупреждение, стоящее всегда, перестаёт что-либо значить.
    const text = revocationDoesNotUndo({ sharesRevoked: 2, copiesRevoked: 1, depthExhausted: false }, BASE);
    expect(text).toBe(BASE);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: «что сделано» меняется вместе с числами, а не стоит константой', () => {
    const many = revocationAlsoDone({ sharesRevoked: 3, copiesRevoked: 2, depthExhausted: false });
    const none = revocationAlsoDone({ sharesRevoked: 0, copiesRevoked: 0, depthExhausted: false });
    expect(many).not.toBe(none);
    expect(many).toContain('3 ссылки');
    expect(many).toContain('2 копии');
    // Ноль — это не «закрыто», а «нечего было закрывать»: иначе человек
    // решит, что работа проделана, когда её не было.
    expect(none).toContain('не было');
    expect(none).toContain('не нашлось');
    expect(none).not.toMatch(/закрыто \d/);
  });

  it('русские формы числа не разъезжаются', () => {
    expect(revocationAlsoDone({ sharesRevoked: 1, copiesRevoked: 1, depthExhausted: false })).toContain('1 ссылка');
    expect(revocationAlsoDone({ sharesRevoked: 5, copiesRevoked: 5, depthExhausted: false })).toContain('5 ссылок');
    // Весь второй десяток, а не только его начало: мутация «до 14»
    // проходила, потому что проверены были 11 и 21, а между ними никто
    // не смотрел.
    for (const n of [11, 12, 13, 14, 15, 19, 111]) {
      expect(revocationAlsoDone({ sharesRevoked: n, copiesRevoked: n, depthExhausted: false })).toContain(`${n} ссылок`);
    }
    expect(revocationAlsoDone({ sharesRevoked: 21, copiesRevoked: 21, depthExhausted: false })).toContain('21 ссылка');
    expect(revocationAlsoDone({ sharesRevoked: 4, copiesRevoked: 4, depthExhausted: false })).toContain('4 ссылки');
  });
});

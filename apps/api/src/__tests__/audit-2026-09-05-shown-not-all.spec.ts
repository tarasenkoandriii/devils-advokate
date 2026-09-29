// Сверка 2026-09-05 — усечение в том, что человек читает как полное.
//
// Пункт [partial-basis] закрыл срез в разборах О ЧЕЛОВЕКЕ и честно
// оставил три места «на отдельный заход», потому что там вывод не о
// человеке. Это тот заход. Оказалось, что цена разная, и в двух местах
// выше, чем казалось.
//
//  1. КАРТОЧКА РАЗГОВОРА — «Ключевые аргументы» — пять самых весомых из
//     всех, без единого слова об этом. Это не промпт: карточку человек
//     ОТКРЫВАЕТ ПЕРЕД РАЗГОВОРОМ и уносит с собой. Он уносил пятёрку,
//     считая её своим набором целиком. То же слово «ключевые», что
//     ловилось в промптах, только читает его не модель, а человек, и
//     сразу идёт говорить.
//  2. РАЗБОР РАСХОЖДЕНИЙ — сверка со «своими же прошлыми словами» шла по
//     ПОСЛЕДНИМ пяти разговорам, а модели подавалась как история
//     говорящего. Вывод «противоречит сказанному ранее» на неполной
//     истории — обвинение на неполных данных, а продукт прямо запрещает
//     себе называть человека солгавшим.
//  3. ПОВЕСТКА СЛЕДУЮЩЕГО РАЗГОВОРА — последние пять разговоров как
//     весь архив. На давнем проекте это ровно те пять, где нужного может
//     не быть.
//
// Сами лимиты остаются: промпт не резиновый, карточка перед разговором
// не должна быть простынёй. Меняется одно — усечение названо.

import { readFileSync } from 'fs';
import { join } from 'path';
import { partialBasis, shownBasisNote } from '../common/partial-basis';

const API_SRC = join(__dirname, '..');

function code(rel: string): string {
  return readFileSync(join(API_SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Усечение в сводках: показано не всё — и сказано, что не всё', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: приписка для экрана говорит, где остальное', () => {
    // Отличие от приписки к разбору не в вежливости: человек, читающий
    // карточку, должен знать не только что показано не всё, но и что
    // остальное никуда не делось.
    const note = shownBasisNote([partialBasis('аргументы', 5, 12, 'weight')]);
    expect(note).toMatch(/Показано не всё/);
    expect(note).toMatch(/5 самых весомых из 12/);
    expect(note).toMatch(/оно в проекте целиком/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: усечения не было — приписки нет', () => {
    // У большинства проектов аргументов меньше пяти. Приписка там, где
    // показано всё, — обман в другую сторону.
    expect(shownBasisNote([partialBasis('аргументы', 3, 3, 'weight')])).toBeNull();
    expect(shownBasisNote([])).toBeNull();
  });

  it('КЛЮЧЕВОЙ ТЕСТ: карточка считает целое и отдаёт приписку', () => {
    const src = code('conversation-card/conversation-card.service.ts');
    expect(src).toMatch(/argument\.count\(\{ where: \{ projectId \} \}\)/);
    expect(src).toMatch(/topArgumentsNote: shownBasisNote\(/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: разбор расхождений называет модели неполноту истории', () => {
    // Здесь цена ошибки выше всего: вывод «противоречит сказанному
    // ранее» на пяти последних разговорах — обвинение на неполных
    // данных.
    const src = code('discrepancy-analysis/discrepancy-analysis.service.ts');
    expect(src).toMatch(/conversation\.count\(/);
    expect(src).toMatch(/promptBasisNote\(basis\)/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: повестка следующего разговора — тоже', () => {
    const src = code('conversation-agenda/conversation-agenda.service.ts');
    expect(src).toMatch(/conversation\.count\(/);
    expect(src).toMatch(/Прошлые разговоры\$\{promptBasisNote\(pastBasis\)\}/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: долг пункта [partial-basis] закрыт полностью', () => {
    // Тот пункт назвал три места и оставил их на отдельный заход. Список
    // проверяется целиком: забыть одно из трёх — ровно тот способ, каким
    // «отложено» превращается в «потеряно».
    const owed = [
      'conversation-card/conversation-card.service.ts',
      'discrepancy-analysis/discrepancy-analysis.service.ts',
      'conversation-agenda/conversation-agenda.service.ts',
    ];
    for (const rel of owed) {
      const src = code(rel);
      expect({ rel, discloses: /BasisNote\(/.test(src) }).toEqual({ rel, discloses: true });
      expect({ rel, counts: /\.count\(/.test(src) }).toEqual({ rel, counts: true });
    }
  });
});

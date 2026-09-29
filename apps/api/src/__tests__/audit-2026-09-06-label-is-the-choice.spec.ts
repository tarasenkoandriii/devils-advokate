// Сверка 2026-09-06 — карта подписей оказалась списком действий.
//
// НАЙДЕННОЕ. Экран листа условий строил выпадающий список статусов из
// КАРТЫ ПОДПИСЕЙ: `Object.entries(STATUS_LABEL).map(...)`. Карта
// типизирована `Record<string, string>`, поэтому её не держало ни
// перечисление сервера, ни правила переходов — и она разошлась с
// обоими сразу:
//
//   • `WITHDRAWN` в ней НЕ БЫЛО — отозвать лист условий было нельзя
//     ниоткуда, хотя статус существует и сервис считает его
//     терминальным;
//   • `CLOSED` в ней БЫЛ, а в перечислении его нет вовсе — человек
//     выбирал «закрыт» из меню самого продукта и получал ошибку
//     валидации;
//   • `DRAFT` в ней был, а `setStatus()` отвергает его прямым текстом
//     («Вернуть лист в DRAFT нельзя») — вторая заведомо неработающая
//     строка меню.
//
// Две строки из пяти не могли сработать никогда, а одно настоящее
// действие было недоступно.
//
// ПОЧЕМУ НИКТО НЕ ЗАМЕТИЛ. Ключей в карте было пять и значений в
// перечислении пять — счёт сходился. Совпадение числа при несовпадении
// состава: карта ВЫГЛЯДЕЛА полной. Тот же изъян, что и везде в этой
// сессии, только в самом дешёвом месте.
//
// КОРЕНЬ ГЛУБЖЕ КАРТЫ. Тип клиента тоже был неверен:
// `SheetStatus = … | 'DECLINED' | 'CLOSED'`. То есть `Record<SheetStatus,
// string>` не помог бы — расхождение начиналось с самого типа, и
// сравнивать его с перечислением сервера было нечем. Отсюда правило
// ниже: оно сравнивает.
//
// ОТКУДА ПРИЗРАК. `CLOSED` — настоящее значение ДРУГОГО перечисления,
// `EngagementStatus` (передача агентству). Одно слово на два разных
// перечисления, и оно перебралось туда, где его нет.

import { readFileSync } from 'fs';
import { join } from 'path';
import { TermsSheetStatus } from '@prisma/client';
import { allowedStatusTransitions } from '../terms-sheet/terms-sheet.service';

const TMA_SRC = join(__dirname, '../../../tma/src');

function tsUnion(file: string, name: string): string[] {
  const src = readFileSync(join(TMA_SRC, file), 'utf8');
  const m = new RegExp(`export type ${name}\\s*=\\s*((?:\\s*\\|?\\s*'[A-Za-z0-9_]+')+)`).exec(src);
  if (!m) throw new Error(`тип ${name} не найден`);
  return [...m[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1]);
}

function mapKeys(file: string, name: string): string[] {
  const src = readFileSync(join(TMA_SRC, file), 'utf8');
  const i = src.indexOf(`const ${name}`);
  if (i < 0) throw new Error(`карта ${name} не найдена`);
  const open = src.indexOf('{', i);
  let depth = 1;
  let j = open + 1;
  while (j < src.length && depth > 0) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') depth--;
    j++;
  }
  return [...src.slice(open + 1, j - 1).matchAll(/(?:^|,|\{)\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*:/g)].map((x) => x[1]);
}

describe('[label-is-the-choice] меню статусов — не карта подписей', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: тип клиента совпадает с перечислением сервера', () => {
    // Это и есть корень: сравнивать их было нечем, и они разошлись.
    const server = Object.values(TermsSheetStatus).sort();
    const client = tsUnion('lib/hiring/api.ts', 'SheetStatus').sort();
    expect(client).toEqual(server);
    // Точечно про находку: призрак ушёл, настоящий статус пришёл.
    expect(client).toContain('WITHDRAWN');
    expect(client).not.toContain('CLOSED');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у каждого статуса есть подпись, и лишних подписей нет', () => {
    const server = Object.values(TermsSheetStatus).sort();
    expect(mapKeys('lib/hiring/api.ts', 'STATUS_LABEL').sort()).toEqual(server);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: меню больше не строится из карты подписей', () => {
    // Мутация «вернуть Object.entries(STATUS_LABEL)» обязана падать:
    // карта отвечает за слова, список действий — за сервером.
    const view = readFileSync(join(TMA_SRC, 'components/domains/hiring/TermsSheetView.tsx'), 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(view).not.toMatch(/Object\.entries\(STATUS_LABEL\)/);
    expect(view).toMatch(/sheet\.allowedStatuses/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: сервер не предлагает того, что сам отвергнет', () => {
    // DRAFT запрещён явной проверкой в setStatus, и его не должно быть
    // ни в одном предложенном списке — иначе продукт обещает действие,
    // которое заведомо не состоится.
    for (const from of Object.values(TermsSheetStatus)) {
      const allowed = allowedStatusTransitions(from);
      expect(allowed).not.toContain(TermsSheetStatus.DRAFT);
      expect(allowed).not.toContain(from);
      for (const s of allowed) expect(Object.values(TermsSheetStatus)).toContain(s);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отозвать лист теперь можно, а из терминального — только возобновить', () => {
    // Собственно возвращённое действие.
    expect(allowedStatusTransitions(TermsSheetStatus.IN_NEGOTIATION)).toContain(TermsSheetStatus.WITHDRAWN);
    expect(allowedStatusTransitions(TermsSheetStatus.DRAFT)).toContain(TermsSheetStatus.WITHDRAWN);
    // Из терминального — ровно один переход, как и требует setStatus.
    for (const terminal of [TermsSheetStatus.AGREED, TermsSheetStatus.DECLINED, TermsSheetStatus.WITHDRAWN]) {
      expect(allowedStatusTransitions(terminal)).toEqual([TermsSheetStatus.IN_NEGOTIATION]);
    }
  });

  it('ИЗМЕРЕНИЕ: призрачный CLOSED остался только там, где он настоящий', () => {
    // `CLOSED` — значение EngagementStatus (передача агентству), и там
    // его подпись нужна. Проверка следит, чтобы он не вернулся в
    // статусы ЛИСТА, а не изгоняла слово вообще.
    const api = readFileSync(join(TMA_SRC, 'lib/hiring/api.ts'), 'utf8');
    const labelBlock = api.slice(api.indexOf('const STATUS_LABEL'), api.indexOf('const EVIDENCE_LABEL'));
    expect(labelBlock).not.toMatch(/CLOSED/);
    const engagement = readFileSync(join(TMA_SRC, 'components/domains/hiring/TeamPanels.tsx'), 'utf8');
    expect(engagement).toMatch(/CLOSED: '/);
  });
});

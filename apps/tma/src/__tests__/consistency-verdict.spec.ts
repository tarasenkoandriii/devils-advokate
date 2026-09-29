// Пункт [the-sentence-did-not-look-at-the-fact] 2026-09-25 — вердикт о
// расхождениях между вариантами резюме.
//
// «Расхождений не найдено» говорилось и тогда, когда находки были, но
// все до одной отброшены проверкой цитат. Для человека это два разных
// сообщения: «их нет» и «ни одно не подтвердилось».

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConsistencyVerdict } from '../components/domains/hiring/JobSearchToolsPanel';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const html = (c: unknown) => renderToStaticMarkup(createElement(ConsistencyVerdict, { consistency: c as never }));

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: всё отброшено — «не найдено» НЕ говорится', () => {
    const out = html({ discrepancies: [], variantsCompared: 3, droppedUnverifiable: 4 });
    assert(!/не найдено/.test(out), `сказано «не найдено» поверх отброшенных находок: ${out}`);
    assert(/4 находк/.test(out), `число отброшенных не названо: ${out}`);
    assert(/не то же самое/.test(out), `разница не проговорена: ${out}`);
  }],

  ['ОБРАТНАЯ ПРОБА: ничего не отброшено — прежняя спокойная формулировка на месте', () => {
    // Иначе экран пугал бы всегда, и предупреждение перестало бы
    // что-либо значить.
    const out = html({ discrepancies: [], variantsCompared: 3, droppedUnverifiable: 0 });
    assert(/Расхождений между 3 вариантами не найдено/.test(out), `спокойный случай сломан: ${out}`);
    assert(!/отброшено/.test(out), `лишнее предупреждение: ${out}`);
  }],

  ['находки есть и что-то отброшено — сказано и то, и другое', () => {
    const out = html({ discrepancies: [{}], variantsCompared: 2, droppedUnverifiable: 2 });
    assert(/2 находк/.test(out), `отброшенное умолчали при непустом списке: ${out}`);
    assert(!/не найдено/.test(out), `вердикт «не найдено» при найденных расхождениях: ${out}`);
  }],

  ['меньше двух вариантов — вердикта нет вообще', () => {
    assert(html({ discrepancies: [], variantsCompared: 1, droppedUnverifiable: 0 }) === '', 'вердикт при одном варианте');
    assert(html(null) === '', 'вердикт без данных');
  }],
];

let failed = 0;
for (const [name, fn] of scenarios) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`✗ ${name}: ${(e as Error).message}`);
  }
}
if (failed > 0) process.exit(1);

// Сверка молчаливого необратимого 2026-09-04, экранная половина.
//
// Слияние двух карточек кандидата удаляет вторую вместе с её листом
// (каскад в базе), и пункты без пары исчезали навсегда. Серверная
// половина научилась их считать и называть; здесь проверяется, что
// человек это ВИДИТ — рисованием настоящей разметки, а не чтением
// исходника (урок [render-guards]).
//
// Экран выбрасывал результат вызова целиком: `await …; haptic('success')`.
// Человек получал вибрацию телефона — ни числа перенесённого, ни рамки
// продукта, ни слова о потерянном.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MergeReport } from '../components/MergeReport';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function html(outcome: unknown): string {
  return renderToStaticMarkup(createElement(MergeReport, { outcome: outcome as never }));
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: потеря названа числом И своими словами человека', () => {
    const out = html({
      positionsMoved: 1,
      clausesWithoutMatch: 1,
      positionsDropped: 2,
      droppedClauseTexts: ['Английский C1'],
      frame: 'Расхождения между источниками — цитатами; «кто прав» не решается',
    });
    assert(/Перенесено позиций: 1/.test(out), `не сказано, сколько перенесено: ${out}`);
    assert(out.includes('Английский C1'), `потерянный пункт не показан: ${out}`);
    assert(/не перенеслось позиций: 2/.test(out), `не сказано, сколько позиций потеряно: ${out}`);
    // Необратимость проговаривается прямо: «удалена», «нельзя».
    assert(/вернуть их нельзя/.test(out), `не сказано, что вернуть нельзя: ${out}`);
    // И рамка продукта доходит до экрана — она и была тем вопросом, с
    // которого начался заход.
    assert(/кто прав/.test(out), `рамка продукта потерялась: ${out}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: сообщение о потере произносится вслух', () => {
    const out = html({ positionsMoved: 0, clausesWithoutMatch: 3, positionsDropped: 5, droppedClauseTexts: ['A'] });
    const live = /<p[^>]*role="status"[^>]*>([\s\S]*?)<\/p>/.exec(out);
    assert(live !== null, `нет живой области: ${out}`);
    assert(/3/.test(live![1]) && /5/.test(live![1]), `числа не внутри живой области: ${out}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: когда ничего не потеряно — так и сказано, а не пустота', () => {
    // Молчание человек достраивает в свою пользу, но здесь и «потеряли»
    // было бы неправдой. Утверждение обязано быть явным.
    const out = html({ positionsMoved: 4, clausesWithoutMatch: 0, positionsDropped: 0, droppedClauseTexts: [] });
    assert(/ничего не потеряно/.test(out), `не сказано, что всё перенеслось: ${out}`);
    assert(!/role="status"/.test(out), `предупреждение показано там, где терять было нечего: ${out}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: показ примеров усечён, но об усечении сказано', () => {
    // Обрезка без подписи — форма, которую проект закрывал уже трижды.
    // Здесь усечён показ, а число названо точно.
    const out = html({ positionsMoved: 0, clausesWithoutMatch: 7, positionsDropped: 9, droppedClauseTexts: ['A', 'B'] });
    assert(/и ещё 5/.test(out), `об усечении списка не сказано: ${out}`);
    assert(/7/.test(out), `точное число потерянных пропало: ${out}`);
  }],

  ['до слияния человек предупреждён, что действие необратимо', () => {
    // Отчёт после — половина честности; вторая половина в том, чтобы
    // сказать заранее. Это проверяется по исходнику намеренно: панель
    // с формами и запросами не рисуется, а само предупреждение —
    // статический текст, поведения у него нет.
    const src = readFileSync(join(SRC, 'components/domains/hiring/TeamPanels.tsx'), 'utf8');
    assert(/Действие необратимо/.test(src), 'экран не предупреждает о необратимости слияния');
    assert(/<MergeReport\b/.test(src), 'результат слияния снова никуда не выводится');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: экран называет то правило удаления, которое действует', () => {
    // Здесь было написано «удалятся при переполнении», а код удаляет по
    // возрасту — через 30 дней, независимо от заполненности. Продукт
    // обещал человеку одно, а делал другое.
    const src = readFileSync(join(SRC, 'components/domains/hiring/IntakePanel.tsx'), 'utf8');
    assert(/через 30 дней/.test(src), 'экран не называет срок хранения');
    assert(!/остальные удалятся при переполнении/.test(src), 'на экране осталось неверное правило удаления');
  }],
];

const results: Array<{ name: string; error?: string }> = [];
for (const [name, fn] of scenarios) {
  try {
    fn();
    results.push({ name });
  } catch (err: any) {
    results.push({ name, error: err.message });
  }
}

const failed = results.filter((r) => r.error);
console.log(`\nmerge-report: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

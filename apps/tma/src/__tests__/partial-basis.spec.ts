// Сверка 2026-09-04, экранная половина — что человек видит о том, на чём
// построен разбор, который он читает.
//
// НАЙДЕНО на сервере (подробности — в серверной сверке): разборы о
// человеке строятся на срезе (пять последних прецедентов, пять самых
// весомых аргументов), а модели и человеку подавались как разборы на
// всех данных. Здесь проверяется вторая половина: приписка ДОХОДИТ до
// экрана, рисуется по-настоящему и не появляется там, где усечения не
// было.
//
// ГРАНИЦА СКАЗАНА ПРЯМО, а не умолчанием. Приписка — свойство СВЕЖЕГО
// ответа: в базе основания нет, колонки под него не существует ни у
// одной модели результата, и ручную миграцию ради подписи под текстом мы
// не заводили. Значит, открыв сохранённый разбор завтра, человек этой
// строки не увидит — и компонент говорит об этом сам, вместо того чтобы
// промолчать и дать подумать, будто разбор её помнит.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AnalysisBasisNote } from '../components/AnalysisBasisNote';
import { screensMatching } from './screen-walker';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/** Комментарии прочь перед разбором КОДА: за эту сессию проверки шесть
 * раз ловили собственный объяснительный текст. */
function code(rel: string): string {
  return read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Экраны, где человек читает вывод, построенный на срезе. */
const SCREENS = [
  'components/MotiveAnalysisSection.tsx',
  'components/OutcomeScenariosSection.tsx',
  'components/ArchetypePerspectivesSection.tsx',
  'components/SparringSection.tsx',
];

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: приписка РИСУЕТСЯ вместе с текстом основания', () => {
    // Урок [render-guards]: проверка на упоминание в исходнике проходит
    // и у выключенного экрана, поэтому компонент рисуется по-настоящему.
    const shown = renderToStaticMarkup(
      createElement(AnalysisBasisNote, {
        note: 'Разбор построен не на всех данных: прецеденты поведения — последние 5 из 23.',
      }),
    );
    assert(/последние 5 из 23/.test(shown), 'основание разбора не показано человеку');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: сказано, что приписка НЕ сохраняется вместе с разбором', () => {
    // Иначе человек, открыв разбор завтра и не увидев строки, решит, что
    // тот построен на всём. Промолчать здесь — то же самое умолчание,
    // против которого вся сверка.
    const shown = renderToStaticMarkup(createElement(AnalysisBasisNote, { note: 'Разбор построен не на всех данных: х.' }));
    assert(/не сохраняется вместе с ним/.test(shown), 'граница приписки не названа — она выглядит свойством сохранённого разбора');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: там, где усечения не было, не рисуется НИЧЕГО', () => {
    // Сообщение об усечении там, где его не было, — такой же обман,
    // только в другую сторону. У большинства людей прецедентов меньше
    // лимита, и молчание здесь единственно верное.
    for (const empty of [null, undefined, '']) {
      assert(renderToStaticMarkup(createElement(AnalysisBasisNote, { note: empty })) === '',
        `приписка нарисована при note=${JSON.stringify(empty)}`);
    }
  }],

  ['КЛЮЧЕВОЙ ТЕСТ [guard-scope]: любой экран, получающий основание, его ПОКАЗЫВАЕТ', () => {
    // Пункт [guard-scope] 2026-09-06: проверка ниже смотрит в список из
    // четырёх известных экранов — это верно как положительная проверка,
    // но пятый экран, который возьмёт `basisNote` из ответа и
    // промолчит, она не поймает. Обратное правило — по дереву.
    //
    // ЧЕГО ЭТО ПРАВИЛО НЕ ЛОВИТ, и притворяться нельзя: экран, который
    // режет список сам и не спрашивает сервер вовсе. Такой случай
    // закрыт с другой стороны — серверным правилом [partial-basis],
    // где приписку обязаны считать все четыре сборщика контекста. Здесь
    // проверяется ровно то, что проверяемо: пришло основание — покажи.
    const receives = screensMatching(SRC, /basisNote/);
    const silent = receives.filter((rel) => !/<AnalysisBasisNote/.test(code(rel)));
    assert(silent.length === 0, `основание приходит, но не показывается: ${silent.join(', ')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: все четыре экрана разбора берут основание из ответа и показывают его', () => {
    for (const rel of SCREENS) {
      const src = code(rel);
      assert(/<AnalysisBasisNote/.test(src), `${rel}: основание разбора не показывается`);
      assert(/setBasisNote\(/.test(src), `${rel}: основание не берётся из свежего ответа`);
      // Передаётся ПЕРЕМЕННАЯ состояния, а не константа: та же мутация,
      // что прошла в [decision-basis], когда баннеру подсунули null.
      assert(/<AnalysisBasisNote note=\{basisNote\}/.test(src), `${rel}: приписке передана не переменная основания`);
    }
  }],

  ['ИЗМЕРЕНИЕ: приписка появляется один раз на сессию спарринга, а не на каждую реплику', () => {
    // Свойство относится к данным о человеке, а не к отдельной фразе.
    // Повтор на каждом ответе стал бы шумом, который перестают читать, —
    // и тогда честность превратилась бы в свою противоположность.
    const src = code('components/SparringSection.tsx');
    assert((src.match(/<AnalysisBasisNote/g) ?? []).length === 1,
      'приписка про основание повторяется больше одного раза за сессию');
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
console.log(`\npartial-basis: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

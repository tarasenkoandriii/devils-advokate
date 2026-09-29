// Пункт [operator-left-a-trace-unsaid] 2026-09-25, экранная половина.
//
// Утверждение пункта — «оператор видит, что остаётся после его
// действия». Это утверждение о разметке, и проверяется она РИСОВАНИЕМ.
//
// Второе утверждение — «правило одно на все экраны оператора». Его
// разметкой не проверить: это свойство набора экранов. Поэтому оно
// проверяется чтением исходников — и только оно.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { OperatorTraceList } from '../components/OperatorTraceNotice';
import { OPERATOR_SCREENS, operatorScreenActions } from '../lib/operator-screens';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const SRC = join(__dirname, '..');
const API_OPERATOR_ACTIONS = join(SRC, '../../api/src/audit-log/operator-actions.ts');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Обязательные к следу действия — как они записаны в API. */
function auditedActions(): string[] {
  const src = readFileSync(API_OPERATOR_ACTIONS, 'utf8');
  // `indexOf('AUDITED_OPERATOR_ACTIONS')` попадал в
  // `UNAUDITED_OPERATOR_ACTIONS` — имя одного реестра является
  // подстрокой другого, и первый прогон разобрал НУЛЬ действий, отчего
  // ключевая проверка «каждый экран говорит о следе» прошла впустую.
  // Поймано пробой механизма, которая для этого и стоит.
  const block = src.slice(src.indexOf('export const AUDITED_OPERATOR_ACTIONS'));
  const body = block.slice(block.indexOf('= ['), block.indexOf('\n];'));
  return Array.from(body.matchAll(/^\s*'([^']+)',$/gm)).map((m) => m[1]);
}

// Рисуется НАСТОЯЩИЙ компонент на готовых данных: первая версия этой
// проверки повторяла его разметку у себя, то есть проверяла копию, а не
// поведение. Ровно тот дефект, который продукт чинит снаружи.
function noticeMarkup(
  traces: Array<{ action: string; what: string; resource: string; visibleToPerson: boolean; whyNotVisible: string | null }>,
  actions: string[],
  always: string,
): string {
  return renderToStaticMarkup(createElement(OperatorTraceList, { traces, actions, always }));
}

const VISIBLE = { action: 'library_entry.moderated', what: 'Заявка в библиотеку разборов рассмотрена', resource: 'LibraryEntry', visibleToPerson: true, whyNotVisible: null };
const HIDDEN = { action: 'prompt_version.rolled_back', what: 'Внутренняя версия промпта откачена', resource: 'PromptVersion', visibleToPerson: false, whyNotVisible: 'внутреннее изменение продукта, а не решение о человеке' };

const scenarios: Array<[string, () => void]> = [
  ['проба механизма: обязательные действия прочитаны из API непустым списком', () => {
    const actions = auditedActions();
    assert(actions.length === 14, `обязательных действий прочитано ${actions.length} — дальнейшие проверки ничего не значат`);
    assert(actions.includes('library_entry.moderated'), 'список разобран неверно: в нём нет модерации библиотеки');
    assert(OPERATOR_SCREENS.length === 5, `операторских экранов в реестре ${OPERATOR_SCREENS.length}`);
    assert(operatorScreenActions('app/moderation/library/page.tsx').length === 1, 'реестр экранов разобран неверно');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: каждый операторский экран рисует предупреждение о следе', () => {
    // Экраны берутся из реестра, а НЕ из того, называют ли они действия:
    // первая версия искала «файл упоминает действие — значит он
    // операторский», и мутация «убрать предупреждение вместе с именами»
    // её пережила. Круговая проверка зеленела ровно там, где уже всё
    // хорошо.
    const silent = OPERATOR_SCREENS.filter(
      (s) => !/<OperatorTraceNotice/.test(readFileSync(join(SRC, s.file), 'utf8')),
    ).map((s) => `${s.file} (${s.actions.join(', ')})`);
    assert(silent.length === 0, `эти экраны выполняют решения оператора и молчат о следе:\n  ${silent.join('\n  ')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: каждое обязательное действие закреплено ровно за одним экраном', () => {
    // Иначе новое действие появится в правиле и не появится ни на одном
    // экране — то есть оператор о нём не узнает, а человек увидит.
    const claimed = OPERATOR_SCREENS.flatMap((s) => s.actions);
    const orphan = auditedActions().filter((a) => !claimed.includes(a));
    assert(orphan.length === 0, `обязательные действия без экрана: ${orphan.join(', ')}`);
    const twice = claimed.filter((a, i) => claimed.indexOf(a) !== i);
    assert(twice.length === 0, `действие закреплено за двумя экранами: ${twice.join(', ')}`);
    const ghost = claimed.filter((a) => !auditedActions().includes(a));
    assert(ghost.length === 0, `экран обещает след действию, которого нет в правиле: ${ghost.join(', ')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: где человек увидит решение — так и сказано', () => {
    const html = noticeMarkup([VISIBLE], ['library_entry.moderated'], 'всегда');
    assert(html.includes('человек увидит это решение'), 'о том, что человек увидит решение, не сказано');
    assert(html.includes('library_entry.moderated'), 'машинное имя действия не показано оператору');
    assert(html.includes('Заявка в библиотеку разборов рассмотрена'), 'фраза, которую прочитает человек, оператору не показана');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: где не увидит — сказано ПОЧЕМУ, а не «пишется в журнал»', () => {
    const html = noticeMarkup([HIDDEN], ['prompt_version.rolled_back'], 'всегда');
    assert(!html.includes('человек увидит'), 'оператору обещано, что человек увидит то, чего он не увидит');
    assert(html.includes('человеку не показывается'), 'не сказано, что решение человеку не показывается');
    assert(html.includes('внутреннее изменение продукта'), 'причина невидимости не показана');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: на одном экране оба ответа сразу — подписью это не передать', () => {
    const html = noticeMarkup([VISIBLE, HIDDEN], ['library_entry.moderated', 'prompt_version.rolled_back'], '');
    assert(html.includes('человек увидит это решение'), 'видимое решение не названо видимым');
    assert(html.includes('человеку не показывается'), 'невидимое решение не названо невидимым');
  }],

  ['обратная проба: действие, которого нет в правиле, не выдаётся за оставляющее след', () => {
    const html = noticeMarkup([VISIBLE], ['library_entry.moderated', 'выдуманное.действие'], '');
    assert(html.includes('нет в списке обязательных к следу'), 'незнакомое действие молча пропало');
    assert(html.includes('выдуманное.действие'), 'имя незнакомого действия не показано');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: экраны не держат своей копии текста о следе', () => {
    // Дефект, из которого этот пункт и вырос: пять экранов держали бы
    // пять копий, и первое же изменение области журнала развело бы их.
    const offenders: string[] = [];
    for (const f of walk(join(SRC, 'app'))) {
      const src = readFileSync(f, 'utf8')
        .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ');
      if (/человек увидит это решение|записывается в журнал/.test(src)) offenders.push(f.slice(f.indexOf('/src/') + 1));
    }
    assert(offenders.length === 0, `экраны снова пишут о следе сами: ${offenders.join(', ')}`);
  }],
];

void (async () => {
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
})();

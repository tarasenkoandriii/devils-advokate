// Сверка 2026-09-05 — парафраз в кавычках с точной ссылкой на источник.
//
// НАЙДЕННОЕ. Продукт подбирает человеку «уместную цитату» из
// религиозного первоисточника — и в промпте САМ ЖЕ требует от модели
// обратного цитированию: «quoteText — краткий ПАРАФРАЗ своими словами,
// НЕ дословное цитирование», отдельным полем «quoteSourceReference —
// точная ссылка на источник (книга, глава, стих)». То есть продукт знает,
// что это не цитата, — и показывал это тремя способами, каждый из
// которых говорил «цитата»:
//
//  1. `«{quoteText}» — {quoteSourceReference}` в завершающем сообщении.
//     Кавычки с атрибуцией — типографский знак дословности.
//  2. Та же строка НА ПУБЛИЧНОЙ СТРАНИЦЕ обсуждения, которую открывают
//     посторонние люди по ссылке: без аккаунта, без контекста, без
//     возможности спросить. Такое пересылают дальше как цитату из
//     Писания с главой и стихом.
//  3. На экране разрядки — под меткой «🔵 Цитата», где 🔵 в этом
//     продукте означает ПУБЛИЧНЫЙ ФАКТ, то есть установленное.
//
// И рядом: «Протокол по итогам» и «Итог» на той же публичной странице —
// тексты, целиком написанные моделью по расшифровке, — читались
// посторонними как запись о состоявшемся.
//
// ССЫЛКА ОСТАЁТСЯ, и это не компромисс: по ней можно открыть
// первоисточник и прочитать, как там на самом деле. Убран вид
// проверенной точности — продукт ссылку не проверял и проверить не может.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ModelParaphrase, ModelWrittenNote } from '../components/ModelParaphrase';
import { screensMatching } from './screen-walker';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function code(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Все места, где показывается подобранный моделью фрагмент. */
const QUOTE_SCREENS = [
  'components/ClosingMessageSection.tsx',
  'components/SituationalContentSection.tsx',
  'app/public/[token]/page.tsx',
];

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: пересказ рисуется БЕЗ кавычек и назван пересказом', () => {
    const shown = renderToStaticMarkup(
      createElement(ModelParaphrase, { text: 'терпение приносит плод', source: 'Иак. 1:4' }),
    );
    assert(/Пересказ смысла, не дословная цитата/.test(shown), 'текст не назван пересказом');
    assert(!/«/.test(shown) && !/»/.test(shown), 'кавычки вернулись — это знак дословности');
    assert(/терпение приносит плод/.test(shown), 'сам текст потерялся');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: ссылка показана, но названа непроверенной', () => {
    // Убрать ссылку было бы проще и хуже: по ней человек может открыть
    // первоисточник и прочитать, как там на самом деле.
    const shown = renderToStaticMarkup(
      createElement(ModelParaphrase, { text: 'т', source: 'Иак. 1:4' }),
    );
    assert(/Иак\. 1:4/.test(shown), 'ссылка убрана — проверить стало нечем');
    assert(/Источник назван моделью/.test(shown), 'не сказано, чья это ссылка');
    assert(/не проверял/.test(shown), 'не сказано, что ссылка не проверена');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: ссылки нет — и о ней не выдумывается ни слова', () => {
    const shown = renderToStaticMarkup(createElement(ModelParaphrase, { text: 'т', source: null }));
    assert(!/Источник/.test(shown), 'сообщение об источнике при отсутствующем источнике');
    assert(/т/.test(shown), 'текст пропал вместе с источником');
    // И пустой текст не рисует пустую рамку.
    assert(renderToStaticMarkup(createElement(ModelParaphrase, { text: '', source: 'x' })) === '',
      'пустой фрагмент нарисован');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: авторство протокола и итога названо — их читают посторонние', () => {
    const shown = renderToStaticMarkup(createElement(ModelWrittenNote, { what: 'Протокол' }));
    assert(/составлен моделью по записи разговора/.test(shown), 'не сказано, кто написал текст');
    assert(/не подписанный документ/.test(shown), 'не сказано, чем этот текст НЕ является');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: ни один экран не рисует подобранное как цитату в кавычках', () => {
    // Пункт [guard-scope] 2026-09-06: здесь стоял обход СПИСКА из трёх
    // экранов, и подсунутый четвёртый с «{quoteText}» правило
    // пропускало — проверено пробой. Теперь обход по дереву: новый
    // экран с кавычками вокруг парафраза роняет проверку.
    const offenders = screensMatching(SRC, /«\{[a-zA-Z.[\]]*quoteText\}»/);
    assert(offenders.length === 0, `кавычки вокруг парафраза: ${offenders.join(', ')}`);
    // И там, где фрагмент показывается, он идёт через общий вид.
    for (const rel of QUOTE_SCREENS) {
      assert(/ModelParaphrase/.test(code(rel)), `${rel}: фрагмент показывается мимо общего вида`);
    }
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: на публичной странице авторство названо у обоих текстов', () => {
    // Посторонний читатель — тот, у кого меньше всего контекста, и
    // именно ему продукт не говорил ничего.
    const src = code('app/public/[token]/page.tsx');
    const notes = src.match(/<ModelWrittenNote/g) ?? [];
    assert(notes.length === 2, `на публичной странице должно быть два указания авторства, найдено ${notes.length}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: метка 🔵 больше не стоит над тем, что моделью придумано', () => {
    // 🔵 в этом продукте означает публичный факт — установленное.
    const src = code('components/SituationalContentSection.tsx');
    assert(!/🔵 Цитата/.test(src), 'парафраз снова помечен как публичный факт');
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
console.log(`\nquotation-marks: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

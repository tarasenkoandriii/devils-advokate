// Сверка [the-refusal-was-swallowed-midway] 2026-10-26, экранная
// половина — отказ и срез доходят до человека, а не останавливаются в
// JSON.
//
// НАЙДЕНО НА СЕРВЕРЕ (подробности — в серверной сверке
// `apps/api/src/__tests__/audit-2026-10-26-the-refusal-was-swallowed-
// midway.spec.ts`): шесть `catch` съедали отказ, который продукт уже
// сформулировал, — суточный потолок с текстом и сроком, отсутствие
// согласия EXTERNAL_AI. Результатом был более бедный ответ, выданный
// за полный.
//
// ЗДЕСЬ ВТОРАЯ ПОЛОВИНА, и она не формальность: сервер, который
// посчитал причину и никуда её не показал, — отдельный, уже названный
// в этом проекте дефект ([computed-for-the-person-never-shown]
// 2026-09-30). Поэтому приписка РИСУЕТСЯ по-настоящему, а не
// проверяется упоминанием имени в исходнике.
//
// И ПОЧЕМУ ИМЕННО РИСУЕТСЯ. Первая версия серверного сторожа искала в
// коде раздела слово `skippedCount` — мутация, заменившая условие
// показа на `false`, прошла мимо: имя в файле осталось. Решение
// «есть ли о чём говорить» вынесено в `PartialResultNotice`, и его
// проверяет разметка.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PartialResultNotice } from '../components/PartialResultNotice';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

/** Комментарии прочь перед разбором КОДА: за эту сессию собственный
 *  объяснительный текст ловили двенадцать раз. */
function code(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: срез РИСУЕТСЯ — названы и сколько показано, и сколько рассматривалось', () => {
    const shown = renderToStaticMarkup(
      createElement(PartialResultNotice, { shown: 1, considered: 3, skipped: 2, what: 'найденных рядом заведений' }),
    );
    assert(/Показано 1 из 3/.test(shown), 'человек не видит, что показана ЧАСТЬ');
    assert(/по 2 данные получить не удалось/.test(shown), 'не названо, сколько не дошло');
    assert(/найденных рядом заведений/.test(shown), 'не названо, из чего именно срез');
    assert(shown.includes('role="status"'), 'появление строки не объявлено — человек смотрит на список, а не сюда');
  }],

  ['полный ответ приписки НЕ получает: ноль пропущенных — это не срез', () => {
    const shown = renderToStaticMarkup(
      createElement(PartialResultNotice, { shown: 3, considered: 3, skipped: 0, what: 'найденных рядом заведений' }),
    );
    assert(shown === '', `полный ответ получил приписку о срезе: ${shown}`);
  }],

  ['отрицательное и нечисловое не рисуют приписку «по -1 данные получить не удалось»', () => {
    for (const bad of [-1, Number.NaN] as number[]) {
      const shown = renderToStaticMarkup(
        createElement(PartialResultNotice, { shown: 1, considered: 1, skipped: bad, what: 'х' }),
      );
      assert(shown === '', `приписка построена на мусоре skipped=${String(bad)}: ${shown}`);
    }
  }],

  ['раздел подбора мест отдаёт компоненту числа ИЗ ОТВЕТА, а не свои', () => {
    const section = code('components/VenueRecommendationSection.tsx');
    // Числа обязаны приходить из ответа сервера: `shown={2}` или
    // `skipped={0}` рисовали бы приписку, не связанную с подбором.
    assert(/shown=\{partial\.items\.length\}/.test(section), 'показанное число не из ответа');
    assert(/considered=\{partial\.consideredCount\}/.test(section), 'рассмотренное число не из ответа');
    assert(/skipped=\{partial\.skippedCount\}/.test(section), 'пропущенное число не из ответа');
    assert(/setPartial\(found\)/.test(section), 'ответ подбора не сохраняется целиком');
  }],

  ['подсказка онбординга объясняет, чего в ней нет и почему', () => {
    const form = code('components/OnboardingForm.tsx');
    assert(/suggestion\.suggestionNote/.test(form), 'причина отсутствия подсказки не показана');
  }],

  ['сверка с объявлением показывает, почему цены нет', () => {
    const ws = code('components/domains/major-purchase/MajorPurchaseWorkspace.tsx');
    assert(/out\?\.priceNote/.test(ws), 'причина отсутствия цены не показана');
    assert(/role="status"/.test(ws), 'появление строки не объявлено');
  }],
];

const results: { name: string; error?: string }[] = [];
for (const [name, fn] of scenarios) {
  try {
    fn();
    results.push({ name });
  } catch (err: any) {
    results.push({ name, error: err.message });
  }
}

const failed = results.filter((r) => r.error);
console.log(`\nthe-refusal-was-swallowed-midway: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

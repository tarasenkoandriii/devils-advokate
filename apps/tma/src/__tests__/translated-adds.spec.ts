// Сверка 2026-09-06, экранная половина — что появилось в переводе.
//
// НАЙДЕННОЕ. Экран печатал одну строку: «Потеряно: … · Добавлено: …».
// Обе половины — из САМООТЧЁТА второй модели о первой, и обе поданы
// одинаково. «ничего» рядом с «ничего» читается как «перевод чистый» —
// то самое «пробел выглядит как полнота», вокруг которого построен
// продукт. Проверки же не было вовсе: барьер «CV только из ваших слов»,
// который на переформулировке отправляет ответ на повтор, на переводе
// не стоял.
//
// ЧТО РАЗВЕДЕНО. Цифры — это ПРОВЕРКА (числа переживают перевод, их
// можно сравнить). Остальное — слова модели о себе. Одинаково называть
// их значило бы стереть разницу в цене доверия, ровно как ловил пункт
// [unmeasured-confidence].

import { createElement, ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { TranslationCheckNote } from '../components/TranslationCheckNote';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function render<P extends object>(Component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(createElement(Component, props));
}

function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsxFiles(full);
    return name.endsWith('.tsx') ? [full] : [];
  });
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: дописанные числа названы проверкой и стоят первыми', () => {
    const html = render(TranslationCheckNote, {
      backCheck: { lost: [], added: [], addedNumbers: ['30'] },
    });
    assert(/числа, которых нет в вашем тексте/.test(html), 'о дописанных числах не сказано');
    assert(/30/.test(html), 'само число потерялось');
    assert(/Это проверка, а не мнение модели/.test(html), 'проверка не отделена от самоотчёта');
    // Единственная строка здесь, которая является проверкой, — она и
    // объявляется вслух.
    assert(/role="status"/.test(html), 'находка не объявляется вслух');
    // И сказано, почему это важно именно в резюме.
    assert(/достижение/.test(html), 'не сказано, чем цифра в резюме отличается от слова');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: самоотчёт модели помечен как самоотчёт', () => {
    const html = render(TranslationCheckNote, {
      backCheck: { lost: ['Руководил командой'], added: [], addedNumbers: [] },
    });
    assert(/слова самой модели о своём переводе/.test(html), 'самоотчёт снова подан как проверка продукта');
    assert(/🟡/.test(html), 'нет принятой в продукте пометки догадки');
    assert(/Руководил командой/.test(html), 'содержимое самоотчёта потерялось');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: пустой самоотчёт не читается как «перевод чистый»', () => {
    // Прежнее «Потеряно: ничего · Добавлено: ничего» было утверждением
    // о переводе. Модель, ничего не назвавшая, — это не проверенный
    // перевод.
    const html = render(TranslationCheckNote, { backCheck: { lost: [], added: [], addedNumbers: [] } });
    assert(/модель ничего не назвала/.test(html), 'пустой самоотчёт снова выглядит как «чисто»');
    assert(!/>ничего</.test(html), 'осталось прежнее безусловное «ничего»');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: отброшенные пункты самоотчёта названы числом', () => {
    const html = render(TranslationCheckNote, {
      backCheck: { lost: [], added: [], addedNumbers: [] },
      unverifiable: 2,
    });
    assert(/Ещё 2 пункт/.test(html), 'отброшенное исчезло молча');
    assert(/список из-за этого неполон/.test(html), 'не сказано, что список неполон');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: без обратной сверки блок молчит', () => {
    // Заголовок «Обратная сверка перевода» над пустотой — обещание
    // проверки, которой не было.
    assert(render(TranslationCheckNote, { backCheck: null }) === '', 'блок рисуется без данных сверки');
    assert(render(TranslationCheckNote, { backCheck: undefined }) === '', 'блок рисуется при отсутствии поля');
  }],

  ['ИЗМЕРЕНИЕ: обе панели с переводом показывают разбор, и своих копий строки не держат', () => {
    // Строка была в двух местах и умела разъехаться — та же причина,
    // по которой в пункте [render-guards] подписи вынесли в компонент.
    const panels = ['components/domains/hiring/CandidateSheetTools.tsx', 'components/domains/hiring/BriefAndPostingPanels.tsx'];
    for (const rel of panels) {
      const src = code(join(SRC, rel));
      assert(/<TranslationCheckNote\b/.test(src), `${rel}: разбор перевода не выводится`);
      assert(!/backCheck\.lost \?\? \[\]\)\.join/.test(src), `${rel}: осталась своя копия строки самоотчёта`);
    }
    const users = tsxFiles(SRC).filter((f) => /<TranslationCheckNote\b/.test(code(f)));
    assert(users.length === panels.length, `панелей должно быть ${panels.length}, найдено ${users.length}: ` +
      users.map((f) => f.slice(SRC.length + 1)).join(', '));
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
console.log(`\ntranslated-adds: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

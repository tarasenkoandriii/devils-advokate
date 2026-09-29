// Сверка 2026-09-05, экранная половина — что человек видит о
// происхождении своих же записей.
//
// НАЙДЕНО. Форма ввода заставляет выбрать происхождение каждого факта о
// другом человеке — 🟢 личная запись, 🔵 публичный факт, ⚪ моё
// предположение, — и больше этот выбор человеку НЕ показывался никогда:
// в сохранённом списке стоял голый текст. Через неделю собственная
// догадка читается как установленное, потому что отличить её не по чему.
// Состояние факта (оспорен, истёк) не показывалось вовсе.
//
// Та же потеря на сервере (подробности — в серверной сверке): четыре
// разбора отдавали догадку модели как «известный факт».
//
// МЕТКИ ТЕ ЖЕ, ЧТО В ФОРМЕ ВВОДА. Человек выбирал их этими словами —
// значит и видеть должен эти же. Другой набор слов для того же выбора —
// способ незаметно его переписать.

import { readFileSync } from 'fs';
import { join } from 'path';
import { factSourceLabel, factStatusLabel, isGuess, FACT_SOURCE_LABEL } from '../lib/fact-provenance';
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

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: три происхождения различимы, и догадка названа догадкой', () => {
    assert(/предположение/.test(factSourceLabel('USER_GUESS')), 'догадка не названа предположением');
    assert(factSourceLabel('PERSONAL_RECORD') !== factSourceLabel('USER_GUESS'), 'запись со слов и догадка выглядят одинаково');
    assert(factSourceLabel('PUBLIC_FACT') !== factSourceLabel('USER_GUESS'), 'публичный факт и догадка выглядят одинаково');
    assert(isGuess('USER_GUESS') && !isGuess('PERSONAL_RECORD'), 'догадка определяется неверно');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: слова метки — те же, что человек выбирал при вводе', () => {
    // Иначе продукт незаметно переписывает выбор человека: он ставил
    // «моё предположение», а читает потом «непроверенное наблюдение».
    const form = read('components/PersonFactsSection.tsx');
    for (const [value, label] of Object.entries(FACT_SOURCE_LABEL)) {
      const word = label.replace(/^[^\s]+\s/, '').split(' ')[0];
      assert(new RegExp(`'${value}'`).test(form), `${value}: значения нет в форме ввода`);
      assert(new RegExp(word, 'i').test(form), `${value}: в форме ввода другое слово, чем в списке («${word}»)`);
    }
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: обычное состояние молчит, необычное — говорит', () => {
    // «ACTIVE» рядом с каждой строкой — шум, который перестают читать;
    // «оспорен» — то, что человеку нужно видеть.
    assert(factStatusLabel('ACTIVE') === null, '«активен» показывается как отметка — это шум');
    assert(factStatusLabel(null) === null, 'пустое состояние превратилось в отметку');
    assert(factStatusLabel('DISPUTED') === 'оспорен', 'оспоренный факт не помечен');
    assert(factStatusLabel('EXPIRED') === 'истёк срок', 'истёкший факт не помечен');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: список фактов показывает происхождение рядом с текстом', () => {
    const src = code('components/PersonFactsSection.tsx');
    assert(/factSourceLabel\(f\.sourceType\)/.test(src), 'в списке снова голый текст факта без происхождения');
    assert(/factStatusLabel\(f\.status\)/.test(src), 'состояние факта снова не показывается');
    // И отдельная строка у догадки: остальные метки говорят, ОТКУДА
    // факт, а эта — что факта, может быть, и нет.
    assert(/isGuess\(f\.sourceType\)/.test(src), 'у догадки нет отдельного пояснения');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: устаревшие факты тоже показывают происхождение', () => {
    // «Давно не подтверждался» значит разное для записи со слов и для
    // догадки: вторая не подтверждалась никогда, и звать перепроверять
    // её как факт значит называть её фактом.
    const src = code('components/PeopleSection.tsx');
    assert(/factSourceLabel\(f\.sourceType\)/.test(src), 'предупреждение об устаревании молчит о происхождении');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ [no-correction]: у записи есть все четыре действия, и удаление спрашивает', () => {
    // До сверки 2026-09-05 у записи о человеке было ровно два действия:
    // создать и прочитать. Метки «оспорен» и «истёк срок», добавленные
    // предыдущим пунктом, показывали состояния, в которые продукт не
    // умел переводить — это и нашлось следом.
    const src = code('components/PersonFactsSection.tsx');
    for (const action of ['confirmPersonFact(', "setPersonFactStatus(personId, f.id, 'DISPUTED')",
      "setPersonFactStatus(personId, f.id, 'EXPIRED')", 'deletePersonFact(']) {
      assert(src.includes(action), `нет действия: ${action}`);
    }
    // Удаление — единственное необратимое из четырёх: спрашивается
    // отдельно, а не срабатывает с первого нажатия.
    assert(/confirmDeleteId === f\.id/.test(src), 'удаление происходит без подтверждения');
    // И сказано, чего оно НЕ делает: выводы, построенные с участием
    // записи, остаются — связать их с ней нечем.
    assert(/останутся/.test(src), 'не сказано, что выводы с участием записи остаются');
  }],

  ['ИЗМЕРЕНИЕ: где человек вообще видит свои факты', () => {
    // Пункт [guard-scope] 2026-09-06. Комментарий здесь обещал: «Третье
    // должно уронить эту проверку» — а код обходил СПИСОК из двух, и
    // третий экран проходил насквозь (проверено пробой). Правило
    // утверждало о себе то, чего не делало: тот самый изъян, который
    // вся сессия ищет в продукте, найденный в собственной проверке.
    //
    // Теперь по дереву: экран, который показывает факты о человеке
    // (обращается к `f.sourceType` или к списку фактов) и не зовёт
    // `factSourceLabel`, роняет проверку.
    const showsFacts = screensMatching(SRC, /\.sourceType\b|personFacts|PersonFact/);
    assert(showsFacts.length >= 2, `экранов с фактами должно быть не меньше двух, найдено ${showsFacts.length}`);
    const withoutProvenance = showsFacts.filter((rel) => !/factSourceLabel\(/.test(code(rel)));
    assert(withoutProvenance.length === 0, `факты показываются без происхождения: ${withoutProvenance.join(', ')}`);
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
console.log(`\nsource-collapse: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

// Сверка 2026-09-05, экранная половина — прочитано не всё, а сказано
// как про всё.
//
// НАЙДЕННОЕ. Все подписи, заведённые прошлыми сверками, говорят о том,
// что потерялось ПОСЛЕ разбора: находка без цитаты, черновик сверх
// предела, страница, отклонённая проверкой. О том, что до разбора не
// дошло, не говорилось нигде. А доходит не всё: текст источника режется
// потолком одного запроса (16 000 знаков), текст оффера — ещё и при
// сохранении (20 000), «широкие» разборы — 24 000.
//
// Человек вставляет оффер на сорок тысяч знаков и читает «Черновиков
// позиций: 7 — подтвердите их в списке пунктов». Список условий он
// принимает за список того, что ему предложили.
//
// ДВА СОБЫТИЯ, НЕ ОДНО. «Не разобрано» повторимо: разбейте текст и
// повторите. «Не сохранено» необратимо: хвост документа в базу не
// попал. Одна подпись на оба предложила бы бесполезное действие.

import { createElement, ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { intakeNote, storedIntakeNote } from '../lib/skipped-note';
import { IntakeNotes } from '../components/SkippedNotes';

const SRC = join(__dirname, '..');

function render<P extends object>(Component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(createElement(Component, props));
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
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

/** Панели, показывающие результат разбора текста источника. Список —
 * измерение: пятая такая панель без подписи должна быть видна. */
const PANELS = [
  'components/domains/hiring/TermsSheetView.tsx',
  'components/domains/hiring/CandidateSheetTools.tsx',
  'components/domains/hiring/TeamSheetTools.tsx',
  'components/domains/hiring/BriefAndPostingPanels.tsx',
];

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: подпись появляется на экране, а не только в файле', () => {
    // Урок [render-guards]: «есть слово в исходнике» и «человек это
    // видит» — разные утверждения. Компонент рисуется целиком.
    const html = render(IntakeNotes, { intake: { used: 16000, total: 40000, limit: 16000 }, what: 'текст источника' });
    assert(/Разобран не весь текст источника/.test(html), 'подпись не выводится');
    assert(/16000/.test(html) && /40000/.test(html), 'числа потерялись');
    // Живая область: человек в этот момент читает список условий.
    assert(/role="status"/.test(html), 'подпись не объявляется вслух');
    // И текст ВНУТРИ живой области, а не рядом с ней.
    assert(/role="status"[^>]*>[^<]*Разобран/.test(html), 'живая область пуста — объявляется ничто');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: «не сохранено» и «не разобрано» — разные подписи, и порядок не случаен', () => {
    const html = render(IntakeNotes, {
      storedIntake: { used: 20000, total: 40000, limit: 20000 },
      intake: { used: 16000, total: 20000, limit: 16000 },
      what: 'текст',
    });
    assert(/Сохранён не весь/.test(html), 'об утрате при сохранении не сказано');
    assert(/Разобран не весь/.test(html), 'об усечении при разборе не сказано');
    // Необратимое — первым: с ним нужно что-то делать сейчас.
    assert(html.indexOf('Сохранён не весь') < html.indexOf('Разобран не весь'), 'необратимая утрата ушла вниз');
    assert(/повторный разбор его не найдёт/.test(html), 'не сказано, что несохранённое не вернётся');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: целиком прочитанный текст молчит', () => {
    // Подпись «прочитано 100%» приучает не читать подписи — и тогда
    // пропадёт та единственная, ради которой всё сделано.
    assert(render(IntakeNotes, { intake: { used: 500, total: 500, limit: 16000 } }) === '', 'подпись под полным текстом');
    assert(render(IntakeNotes, {}) === '', 'подпись без данных об усечении');
    assert(intakeNote(undefined) === '' && intakeNote({ used: 5, total: 5 }) === '', 'помощник выдумывает усечение');
    assert(storedIntakeNote(null) === '', 'помощник выдумывает утрату при сохранении');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: мусор вместо чисел не превращается в утверждение', () => {
    // Сервер может не прислать поле вовсе — старый клиент, другой
    // маршрут. Молчание честнее «прочитано NaN%».
    for (const bad of [null, undefined, {}, { used: 'много', total: 10 }, { used: 5 }, { used: NaN, total: 10 }]) {
      assert(intakeNote(bad as any) === '', `подпись построена на мусоре: ${JSON.stringify(bad)}`);
    }
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: сказано, что именно означает пустота дальше', () => {
    // Главное не число, а вывод: продукт не сказал о конце документа
    // НИЧЕГО — в том числе не сказал, что там пусто.
    const note = intakeNote({ used: 16000, total: 40000 });
    assert(/ни что там что-то есть, ни что там пусто/.test(note), 'не сказано, что о хвосте не сказано ничего');
    assert(/Разбейте текст на части/.test(note), 'не сказано, что делать');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: все панели разбора ВЫЗЫВАЮТ подпись, а не импортируют', () => {
    // Мутация «убрать вызов, оставить импорт» проходит проверку на
    // упоминание — этот урок стоил ошибки трижды за сессию.
    for (const rel of PANELS) {
      const src = code(join(SRC, rel));
      assert(/<IntakeNotes\b/.test(src), `${rel}: подпись не выводится на экран`);
    }
  }],

  ['ИЗМЕРЕНИЕ: где показывается подпись об усечении входа', () => {
    const users = tsxFiles(SRC).filter((f) => /<IntakeNotes\b/.test(code(f)));
    assert(users.length === PANELS.length, `панелей с подписью должно быть ${PANELS.length}, найдено ${users.length}: ` +
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
console.log(`\ninput-truncated: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

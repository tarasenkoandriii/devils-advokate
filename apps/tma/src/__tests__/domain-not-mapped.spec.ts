// Сверка 2026-09-06 — закон не показывался там, где его собрали.
//
// НАЙДЕННОЕ. Блок «Что говорит закон» брал режим проекта из рукописной
// таблицы внутри компонента: `Record<string, string>` на ШЕСТЬ доменов
// при ВОСЬМИ существующих. «Поиск работы» и «найм в компанию» в неё не
// попали, и для них блок не появлялся вовсе — молча, через
// `if (!mode) { setData(null); return; }`.
//
// Накануне для этих двух режимов были собраны нормы: украинская статья
// 11 о требованиях в вакансии, европейская директива о прозрачности
// оплаты (право узнать диапазон ДО собеседования), американская ADEA о
// формулировках объявления. Увидеть их было нельзя ни при каких
// условиях: сервер отдавал бы их исправно, а экран не спрашивал.
//
// ПОЧЕМУ ЭТО СЛУЧИЛОСЬ И ЧТО ИЗМЕНЕНО. `Record<string, ...>` принимает
// любой ключ и о пропущенном молчит. Таблица была ВТОРЫМ экземпляром
// соответствия «домен → режим», которое уже однозначно; второй
// экземпляр правды однажды расходится с первым — тот же урок, что
// [consent-purpose] вынес про `purposes`. Теперь тип
// `Record<DomainId, ProjectModeName>` требует все восемь ключей: новый
// домен без режима НЕ СОБЕРЁТСЯ. Это сильнее теста — забыть нельзя.
//
// ЗАЧЕМ ТОГДА ТЕСТ. Компилятор держит полноту таблицы, но не держит
// двух других вещей: что в ней нет второй копии где-то ещё и что экран
// не молчит, когда режима всё-таки не нашлось.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { PROJECT_MODE_BY_DOMAIN, projectModeForDomain } from '../lib/domains/project-mode';
import { DOMAIN_MANIFESTS } from '../lib/domains/manifests';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: у КАЖДОГО домена продукта есть режим проекта', () => {
    // Это и есть весь пункт: два домена из восьми не имели режима, и
    // блок о законе для них не существовал.
    const manifests = Object.values(DOMAIN_MANIFESTS);
    assert(manifests.length >= 8, `доменов должно быть не меньше 8, найдено ${manifests.length}`);
    const missing = manifests.filter((m) => projectModeForDomain(m.id) === null).map((m) => m.id);
    assert(missing.length === 0, `домены без режима проекта: ${missing.join(', ')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: именно потерянные два домена теперь на месте', () => {
    // Точечно про находку, а не только про общее правило: если
    // соответствие когда-нибудь перепишут, эти два должны уцелеть.
    assert(projectModeForDomain('job-search') === 'JOB_SEARCH', 'поиск работы снова без режима');
    assert(projectModeForDomain('employer-hiring') === 'EMPLOYER_HIRING', 'найм в компанию снова без режима');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: полноту таблицы держит ТИП, а не добрая воля', () => {
    // Сам изъян появился из-за `Record<string, ...>`: такой тип
    // принимает любой ключ и молчит о пропущенном. Ослабление типа
    // обратно до `Record<string, …>` компилятор пропустит — он
    // остаётся валидным TypeScript, — поэтому объявление проверяется
    // здесь. Проверка на ТЕКСТ оправдана ровно потому, что предмет
    // пункта и есть объявление: именно оно заменяет собой тест.
    //
    // Эта проверка добавлена после того, как мутация «ослабить тип»
    // прошла набор насквозь. Помощник мутаций сообщил «поймана» —
    // перепроверка вручную показала, что все тесты зелёные. Отчёт
    // помощника проверен, а не принят на слово.
    const src = readFileSync(join(SRC, 'lib/domains/project-mode.ts'), 'utf8');
    assert(/PROJECT_MODE_BY_DOMAIN:\s*Record<DomainId,\s*ProjectModeName>/.test(src),
      'тип таблицы ослаблен — пропуск домена снова станет молчаливым');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: в таблице нет лишних доменов, которых нет в продукте', () => {
    // Обратная сторона: режим, приписанный несуществующему домену, —
    // это запрос к серверу, который никогда не сработает, и ложное
    // ощущение полноты при чтении таблицы.
    const ids = new Set(Object.values(DOMAIN_MANIFESTS).map((m) => m.id));
    const extra = Object.keys(PROJECT_MODE_BY_DOMAIN).filter((id) => !ids.has(id as never));
    assert(extra.length === 0, `в таблице режимы для несуществующих доменов: ${extra.join(', ')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: соответствие «домен → режим» существует в ОДНОМ месте', () => {
    // Второй экземпляр правды однажды разойдётся с первым — так эта
    // находка и появилась. Правило по дереву: рукописная таблица с
    // теми же парами где-то ещё должна уронить проверку.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith('project-mode.ts')) continue;
      const src = code(file);
      if (/['"]?family-law['"]?\s*:\s*['"]FAMILY_LAW['"]/.test(src)) offenders.push(file.slice(SRC.length + 1));
    }
    assert(offenders.length === 0, `вторая копия соответствия «домен → режим»: ${offenders.join(', ')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: домен без режима не прячет блок молча', () => {
    // По типу это теперь невозможно, но если придёт кривой параметр
    // маршрута — молчание читается так же, как читалось раньше.
    const src = code(join(SRC, 'components/domains/DomainLegalDisclaimer.tsx'));
    assert(/setUnknownDomain\(true\)/.test(src), 'неизвестный домен снова гасит блок молча');
    assert(/unknownDomain &&/.test(src) || /if \(unknownDomain\)/.test(src), 'состояние заведено, но на экран не выводится');
    assert(/не признак того, что закон тут ничего не регулирует/.test(src), 'не сказано, чем пробел отличается от отсутствия норм');
    // И успешная загрузка гасит пометку — иначе она однажды зажжётся навсегда.
    assert(/setUnknownDomain\(false\)/.test(src), 'пометка о неизвестном домене не гаснет');
  }],

  ['ИЗМЕРЕНИЕ: сколько доменов и сколько из них знает блок о законе', () => {
    // Точка отсчёта: девятый домен, добавленный без режима, не
    // соберётся компилятором, а добавленный с режимом — попадёт сюда.
    const manifests = Object.values(DOMAIN_MANIFESTS);
    assert(manifests.length === 8, `доменов должно быть 8, найдено ${manifests.length}: ` +
      manifests.map((m) => m.id).join(', '));
    assert(Object.keys(PROJECT_MODE_BY_DOMAIN).length === 8, 'таблица режимов разошлась с числом доменов');
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
console.log(`\ndomain-not-mapped: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

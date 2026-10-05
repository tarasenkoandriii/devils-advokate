// Пункт [ci-built-on-a-different-node] 2026-10-01 — версия Node живёт в
// одном месте, и это проверяется.
//
// Пункт [the-runner-image-was-chosen-by-the-platform] 2026-10-05 — И ТО
// ЖЕ ПРАВИЛО ДЛЯ ОБРАЗА РАННЕРА. `runs-on` стоял `ubuntu-latest` в семи
// джобах, то есть операционную систему сборки выбирал GitHub, а не
// репозиторий; переезд на Ubuntu 26.04 начинается 19 октября 2026 и
// завершается 19 ноября. Теперь образ прибит литералом — `runs-on` НЕ
// читает ни `env`, ни иной внутренний контекст (проверено: попытка
// подставить `${{ env.… }}` сломала бы workflow), поэтому в репозитории
// это семь копий одного значения, и единственность держит проверка, а не
// дисциплина. Одно отличающееся значение разрешено и ОБЪЯВЛЕНО ниже —
// джоба раннего предупреждения на 26.04.
//
// Пункт [the-actions-ran-on-a-runtime-github-deprecated] 2026-10-05 —
// ТО ЖЕ ПРАВИЛО ДЛЯ МАЖОРОВ ДЕЙСТВИЙ. `actions/checkout` упоминается в
// этом репозитории СЕМЬ раз, и подъём мажора — семь правок, из которых
// шесть можно сделать и одну забыть. Забытая не ломает прогон: джоба
// просто поедет на другом рантайме, с предупреждением, которое уже стало
// фоном. Это ровно та форма, что и разъехавшаяся версия Node, только
// внутри одного файла.
//
// НАЙДЕННОЕ. `.github/actions/setup/action.yml` пинил Node 20, а Vercel
// собирает все четыре проекта на 24.x (проверено в панели 2026-10-01).
// Зелёный CI не обещал ничего про сборку, которая реально поедет: разные
// мажорные версии рантайма. Класс тот же, что «потолок жил в двух
// местах», только граница проходит между репозиторием и платформой.
//
// ЧТО ИМЕННО ПРОВЕРЯЕТСЯ. Не равенство с панелью Vercel — её из
// репозитория не видно НИЧЕМ, и притворяться, что видно, было бы хуже
// молчания. Проверяется, что номер в репозитории не продублирован: есть
// `.nvmrc`, и ни один workflow не прописывает версию числом. Ровно так
// она и разъехалась.
//
// И ОТДЕЛЬНО — ПРО КОММЕНТАРИИ. Первая версия этой проверки была
// трёхстрочным `grep` в самом workflow и СРАЗУ ЖЕ сработала на
// комментарии, который цитирует прежнее значение («Здесь было
// node-version: '20'»). Это девятый случай в этом проекте, когда
// проверка считает закомментированный текст кодом. Поэтому здесь
// комментарии снимаются, и ниже стои́т обратная проба именно на это.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NUMERIC_VERSION = /node-version\s*:\s*'?"?[0-9]/;

/** Строки YAML без комментариев. `#` внутри кавычек здесь не бывает, и
 *  усложнять разбор ради гипотетического случая значило бы сделать
 *  проверку труднее для чтения, чем предмет проверки. */
export function stripYamlComments(source) {
  return source
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line.replace(/\s+#.*$/, '')))
    .join('\n');
}

export function numericVersionLines(source) {
  return stripYamlComments(source)
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => NUMERIC_VERSION.test(line));
}

/** Все `uses: owner/action@vN` без комментариев, с номером строки.
 *
 *  Снятие комментариев здесь не формальность: объяснение к подъёму
 *  мажоров ЦИТИРУЕТ прежние значения (`actions/checkout@v4`), и разбор
 *  по сырому тексту объявил бы расхождение в самом абзаце, который
 *  рассказывает, что его больше нет. Та же ловушка, что ловила этот
 *  проект одиннадцать раз; ниже стои́т обратная проба именно на неё. */
export function actionUses(source) {
  return [...stripYamlComments(source).matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@(v\d+)/g)].map((m) => ({
    action: m[1],
    major: m[2],
  }));
}

/** Действия, упомянутые с РАЗНЫМИ мажорами. */
export function majorsThatDisagree(sources) {
  const seen = new Map();
  for (const src of sources) {
    for (const { action, major } of actionUses(src)) {
      if (!seen.has(action)) seen.set(action, new Set());
      seen.get(action).add(major);
    }
  }
  return [...seen.entries()]
    .filter(([, majors]) => majors.size > 1)
    .map(([action, majors]) => `${action}: ${[...majors].sort().join(' и ')}`);
}

/** Все `runs-on: <label>` без комментариев.
 *
 *  Снятие комментариев обязательно и здесь: объяснение к джобе раннего
 *  предупреждения называет ОБА образа по именам, и разбор по сырому
 *  тексту увидел бы расхождение в абзаце, который его объясняет. Это уже
 *  третья проверка в этом файле, которой нужна та же осторожность. */
export function runnerLabels(source) {
  return [...stripYamlComments(source).matchAll(/runs-on:\s*([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
}

/** Образ, на котором идёт прогон, и объявленные исключения.
 *
 *  Реестр, а не «разрешаем любое второе значение»: иначе забытый
 *  `ubuntu-latest` в новой джобе выглядел бы как законное исключение. */
export const RUNNER_IMAGE = 'ubuntu-24.04';
export const RUNNER_EXCEPTIONS = [
  {
    label: 'ubuntu-26.04',
    why: 'джоба раннего предупреждения: переезд ubuntu-latest на 26.04 (19.10–19.11.2026) измеряется заранее и не красит прогон',
  },
];

/** Метки, которые ни основная, ни объявленное исключение. */
export function undeclaredRunners(sources) {
  const allowed = new Set([RUNNER_IMAGE, ...RUNNER_EXCEPTIONS.map((e) => e.label)]);
  return [...new Set(sources.flatMap(runnerLabels))].filter((l) => !allowed.has(l));
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.ya?ml$/.test(entry)) out.push(full);
  }
  return out;
}

let failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`✓ ${name}`);
  else {
    failed += 1;
    console.log(`✗ ${name}${detail ? `: ${detail}` : ''}`);
  }
};

const nvmrcPath = join(REPO, '.nvmrc');
check('.nvmrc есть — версии Node есть где быть одной', existsSync(nvmrcPath));
if (existsSync(nvmrcPath)) {
  const value = readFileSync(nvmrcPath, 'utf8').trim();
  check('.nvmrc содержит мажорную версию', /^\d+$/.test(value), `прочитано «${value}»`);
  console.log(`  .nvmrc = ${value}`);
}

const yamls = existsSync(join(REPO, '.github')) ? walk(join(REPO, '.github')) : [];
check('.github/ содержит workflow-файлы', yamls.length > 0);
const offenders = [];
for (const file of yamls) {
  for (const [line] of numericVersionLines(readFileSync(file, 'utf8'))) {
    offenders.push(`${file.replace(`${REPO}/`, '')}:${line}`);
  }
}
check(
  'версия Node нигде не прописана числом — только через .nvmrc',
  offenders.length === 0,
  offenders.join(', '),
);
check(
  'хотя бы один файл читает .nvmrc — иначе проверка выше проходила бы на пустом месте',
  yamls.some((f) => stripYamlComments(readFileSync(f, 'utf8')).includes("node-version-file")),
);

// ── Мажоры действий ────────────────────────────────────────────────
const sources = yamls.map((f) => readFileSync(f, 'utf8'));
const allUses = sources.flatMap(actionUses);
check(
  'разбор находит вызовы действий — иначе согласие мажоров ничего не значит',
  allUses.length > 0,
);
const disagree = majorsThatDisagree(sources);
check(
  'каждое действие вызывается с ОДНИМ мажором во всём репозитории',
  disagree.length === 0,
  disagree.join('; '),
);
for (const [action, major] of [
  ...new Map(allUses.map((u) => [u.action, u.major])).entries(),
].sort()) {
  console.log(`  ${action} = ${major}`);
}

// ── Образ раннера ──────────────────────────────────────────────────
const labels = sources.flatMap(runnerLabels);
check('разбор находит runs-on — иначе согласие образов ничего не значит', labels.length > 0);
const undeclared = undeclaredRunners(sources);
check(
  'образ раннера либо основной, либо объявленное исключение',
  undeclared.length === 0,
  `не объявлены: ${undeclared.join(', ')}`,
);
check(
  `основной образ прибит литералом (${RUNNER_IMAGE}) и встречается у большинства джоб`,
  labels.filter((l) => l === RUNNER_IMAGE).length > RUNNER_EXCEPTIONS.length,
  `основного ${labels.filter((l) => l === RUNNER_IMAGE).length}, исключений объявлено ${RUNNER_EXCEPTIONS.length}`,
);
check(
  'у каждого исключения названа причина',
  RUNNER_EXCEPTIONS.every((e) => e.why.trim().length > 20),
);
check(
  'ubuntu-latest не вернулся ни в одну джобу',
  !labels.includes('ubuntu-latest'),
  'платформа снова выбирала бы ОС за репозиторий',
);
for (const [label, n] of [...labels.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map())].sort()) {
  console.log(`  runs-on ${label} × ${n}`);
}

// ОБРАТНЫЕ ПРОБЫ на разбор образов.
check(
  'обратная проба: незаявленная метка находится',
  undeclaredRunners(['    runs-on: ubuntu-latest\n']).length === 1,
);
check(
  'обратная проба: объявленное исключение незаявленным НЕ считается',
  undeclaredRunners([`    runs-on: ${RUNNER_EXCEPTIONS[0].label}\n`]).length === 0,
);
check(
  'обратная проба: метка В КОММЕНТАРИИ не считается',
  undeclaredRunners(['      # прежде здесь стоял runs-on: ubuntu-latest\n']).length === 0,
);

// ОБРАТНАЯ ПРОБА на разбор мажоров: он обязан находить расхождение и НЕ
// находить его в комментарии, который цитирует прежнее значение.
check(
  'обратная проба: два разных мажора одного действия находятся',
  majorsThatDisagree(['    - uses: actions/checkout@v7\n', '    - uses: actions/checkout@v4\n']).length === 1,
);
check(
  'обратная проба: прежний мажор В КОММЕНТАРИИ расхождением не считается',
  majorsThatDisagree([
    '    - uses: actions/checkout@v7\n',
    '      # здесь было `uses: actions/checkout@v4`, и GitHub гнал его на 24\n',
  ]).length === 0,
);
check(
  'обратная проба: разные действия с разными мажорами расхождением НЕ считаются',
  majorsThatDisagree(['    - uses: actions/checkout@v7\n    - uses: actions/setup-node@v5\n']).length === 0,
);

// ОБРАТНАЯ ПРОБА на саму проверку: она обязана (а) находить настоящую
// строку и (б) НЕ находить её в комментарии. Без второй половины
// проверка срабатывала бы на собственном объяснении — так и случилось с
// её первой версией.
const real = "    - uses: actions/setup-node@v4\n      with:\n        node-version: '20'\n";
const commented = "      # Здесь было `node-version: '20'`, а Vercel собирает на 24.x\n";
check('обратная проба: настоящая строка с версией находится', numericVersionLines(real).length === 1);
check('обратная проба: та же строка В КОММЕНТАРИИ не находится', numericVersionLines(commented).length === 0);

if (failed > 0) {
  console.log(`\nпровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nверсия Node живёт в одном месте');

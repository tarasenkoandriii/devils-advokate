// Пункт [ci-built-on-a-different-node] 2026-10-01 — версия Node живёт в
// одном месте, и это проверяется.
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

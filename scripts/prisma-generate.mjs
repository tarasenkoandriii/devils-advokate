// Пункт [the-engine-was-already-on-the-disk] 2026-10-05 — `prisma generate`
// там, где скачивать движки запрещено.
//
// ЧТО ТРИ НЕДЕЛИ СЧИТАЛОСЬ НЕВОЗМОЖНЫМ. `npx prisma generate` на машине
// разработки отвечал 403 от политики egress на `binaries.prisma.sh`, и
// отсюда следовало всё остальное: клиент Prisma отставал от схемы, 41
// набор тестов из 244 не мог даже СТАРТОВАТЬ (перечисления приходили
// `undefined`), `tsc` давал 605 ошибок, то есть тайпчек был невозможен.
// Это записано в отчётах много раз как «полная сверка в этой среде
// невыполнима». Ровно так в живой CI и уехала ошибка типа в прогоне 18:
// локально её было нечем увидеть.
//
// ЧТО ОКАЗАЛОСЬ. Движок, который Prisma хотела скачать, УЖЕ ЛЕЖАЛ НА
// ДИСКЕ. `node_modules/.prisma/client` содержит
// `libquery_engine-rhel-openssl-3.0.x.so.node` — линуксовый движок,
// который ставится для рантайма Vercel. Prisma его не берёт только
// потому, что ищет в своём кэше файл с ИМЕНЕМ ПОД СВОЮ ПЛАТФОРМУ
// (`debian-openssl-3.0.x/libquery_engine.so.node`). Политика egress тут
// ни при чём, и обходить её не нужно: нужно сказать Prisma, где взять то,
// что уже есть.
//
// ЧЕГО ЭТОТ СКРИПТ НЕ ДЕЛАЕТ, И ЭТО ВАЖНЕЕ ТОГО, ЧТО ДЕЛАЕТ:
//  • он НЕ даёт работающей базы. `migrate`, `db push`, `db seed` против
//    живого Postgres здесь по-прежнему невозможны;
//  • путь к движку СХЕМЫ он берёт из того, что лежит в дереве, и это
//    может быть бинарник под другую ОС. Для `generate` это безвредно —
//    проверяется только существование файла, запуска нет, — но любая
//    команда, которой движок схемы нужен по-настоящему, упадёт;
//  • кэш живёт вне репозитория, поэтому после переустановки
//    `node_modules` скрипт нужно прогнать снова.
//
// ПОЧЕМУ СКРИПТ, А НЕ ЗАПИСКА В ДОКУМЕНТЕ. Сначала он пробует ОБЫЧНЫЙ
// `prisma generate` и, если тот проходит, ничего больше не делает. То
// есть на машине владельца и в CI это просто `prisma generate`, а
// окружной путь включается ровно там, где прямой не работает.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readdirSync, renameSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = join(REPO, 'apps', 'api');
const CLIENT_DIR = join(REPO, 'node_modules', '.prisma', 'client');

let failed = 0;
const say = (m) => console.log(m);
const check = (what, ok, detail = '') => {
  if (ok) console.log(`✓ ${what}`);
  else {
    failed += 1;
    console.error(`✗ ${what}${detail ? ` — ${detail}` : ''}`);
  }
};

/** Версия движков — одна и та же строка, что в пути кэша Prisma. */
export function enginesVersion(repo = REPO) {
  const p = join(repo, 'node_modules', '@prisma', 'engines-version', 'package.json');
  return JSON.parse(readFileSync(p, 'utf8')).prisma.enginesVersion;
}

/** Движки, которые УЖЕ лежат в дереве. Имена платформозависимы, поэтому
 *  ищем по признаку, а не по точному имени: иначе скрипт работал бы
 *  только на той платформе, где его написали. */
export function enginesOnDisk(repo = REPO) {
  const out = { query: null, foreignQuery: null, schema: null };
  const places = [join(repo, 'node_modules', '.prisma', 'client'), join(repo, 'node_modules', '@prisma', 'engines')];
  for (const dir of places) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      // Движок запросов: библиотека под Linux (.so.node) или macOS
      // (.dylib.node). Берётся СНАЧАЛА под свою платформу — иначе на
      // Linux мог лечь darwin-движок. Для `generate` это безвредно (файл
      // не запускается, проверяется существование), но клиент получил бы
      // библиотеку, которую невозможно загрузить, и отличить это от
      // работающей установки стало бы нельзя. Первая редакция скрипта
      // так и делала, и поймалось это на собственной проверке.
      const mine = process.platform === 'darwin' ? /^libquery_engine.*\.dylib\.node$/ : /^libquery_engine.*\.so\.node$/;
      const any = /^libquery_engine.*\.(so|dylib)\.node$/;
      if (mine.test(f)) out.query = full;
      else if (!out.query && any.test(f)) out.foreignQuery = full;
      if (!out.schema && /^schema-engine(-|$)/.test(f)) out.schema = full;
    }
  }
  return out;
}

/** Целевое имя файла в кэше Prisma для ЭТОЙ платформы. */
export function cacheTarget(binaryTarget, version, home = homedir()) {
  const name = binaryTarget.startsWith('darwin') ? 'libquery_engine.dylib.node' : 'libquery_engine.so.node';
  return join(home, '.cache', 'prisma', 'master', version, binaryTarget, name);
}

/** Платформа Prisma для текущей машины. Точное имя важно: кэш ищется по
 *  нему.
 *
 *  Параметра здесь нет намеренно, и за это стоит записать отдельно: в
 *  первой редакции стоял `repo = REPO`, который не использовался, и
 *  ESLint в живом CI уронил прогон 24 на `'repo' is assigned a value but
 *  never used`. ESLint — единственная проверка, которой на машине
 *  разработки нет (неполный `npm install`), и именно она меня и поймала.
 *  Это и есть ответ на вопрос, что закрывать следующим. */
export function currentBinaryTarget() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin';
  return process.arch === 'arm64' ? 'linux-arm64-openssl-3.0.x' : 'debian-openssl-3.0.x';
}

/** Отказ ИМЕННО на скачивании движка — единственный случай, в котором
 *  окружной путь уместен. Любой другой отказ (сломанная схема, нет
 *  node_modules) окружным путём не лечится, и подменять одно другим
 *  значило бы прятать настоящую поломку за «зато клиент собрался». */
export function looksLikeDownloadRefusal(output) {
  return /binaries\.prisma\.sh|Failed to fetch/i.test(output);
}

function tryGenerate(env) {
  try {
    const out = execFileSync('npx', ['prisma', 'generate'], {
      cwd: API,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

if (process.argv.includes('--self-test')) {
  // Самопроверки разбора — без запуска самой генерации.
  check('версия движков читается', /^[0-9a-f]{40}$/.test(enginesVersion()), enginesVersion());
  const e = enginesOnDisk();
  check('движок запросов найден в дереве', e.query !== null);
  check('движок схемы найден в дереве', e.schema !== null);
  check(
    'имя файла в кэше зависит от платформы',
    cacheTarget('debian-openssl-3.0.x', 'v', '/h').endsWith('libquery_engine.so.node') &&
      cacheTarget('darwin-arm64', 'v', '/h').endsWith('libquery_engine.dylib.node'),
  );
  // ОБРАТНАЯ ПРОБА: поиск движков опознаёт настоящее имя и НЕ опознаёт
  // похожее-но-не-то. Без неё «движок найден» могло бы означать, что
  // регулярка берёт любой файл.
  const RE_QUERY = /^libquery_engine.*\.(so|dylib)\.node$/;
  check('обратная проба: настоящие имена движка опознаются', RE_QUERY.test('libquery_engine-rhel-openssl-3.0.x.so.node') && RE_QUERY.test('libquery_engine-darwin.dylib.node'));
  check('обратная проба: соседние файлы движком не считаются', !RE_QUERY.test('index.js') && !RE_QUERY.test('libquery_engine.d.ts') && !RE_QUERY.test('schema-engine-darwin'));
  // ОБРАТНАЯ ПРОБА на ВЫБОР, а не на регулярку рядом с ним.
  //
  // Первая редакция этой пробы проверяла регулярное выражение в
  // отдельности — и мутация «снять предпочтение своей платформы» её
  // ПЕРЕЖИЛА: проба смотрела на соседнее выражение, ровно тот дефект, за
  // которым в проекте стои́т сторож [probe-checked-the-neighbour].
  // Теперь проба кормит `enginesOnDisk` настоящим деревом с ДВУМЯ
  // движками и смотрит, который из них выбран.
  const tmp = mkdtempSync(join(tmpdir(), 'prisma-engines-'));
  const fake = join(tmp, 'node_modules', '@prisma', 'engines');
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, 'libquery_engine-rhel-openssl-3.0.x.so.node'), 'x');
  writeFileSync(join(fake, 'libquery_engine-darwin.dylib.node'), 'x');
  writeFileSync(join(fake, 'schema-engine-darwin'), 'x');
  const picked = enginesOnDisk(tmp);
  const ownSuffix = process.platform === 'darwin' ? '.dylib.node' : '.so.node';
  const otherSuffix = process.platform === 'darwin' ? '.so.node' : '.dylib.node';
  check('обратная проба: из двух движков выбран СВОЙ', (picked.query ?? '').endsWith(ownSuffix), picked.query ?? 'ничего');
  check('обратная проба: чужой при этом найден отдельно, а не вместо своего', (picked.foreignQuery ?? '').endsWith(otherSuffix) || picked.foreignQuery === null, picked.foreignQuery ?? 'ничего');
  // И когда своего нет вовсе — чужой становится запасным, но ИМЕННО как
  // запасной: иначе предупреждение о негодной библиотеке не выводилось бы.
  const onlyForeign = mkdtempSync(join(tmpdir(), 'prisma-foreign-'));
  const dir2 = join(onlyForeign, 'node_modules', '@prisma', 'engines');
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, `libquery_engine-other${otherSuffix}`), 'x');
  const fallback = enginesOnDisk(onlyForeign);
  check('обратная проба: без своего движка он НЕ подменяется чужим молча', fallback.query === null && fallback.foreignQuery !== null);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(onlyForeign, { recursive: true, force: true });
  // ОБРАТНАЯ ПРОБА на условие включения окружного пути: он обязан
  // включаться на отказе скачивания и НЕ включаться на любом другом.
  // Иначе сломанная схема выглядела бы как запрет сети, и «клиент
  // собрался» скрывало бы настоящую поломку.
  check(
    'обратная проба: отказ скачивания опознаётся',
    looksLikeDownloadRefusal('Error: Failed to fetch the engine file at https://binaries.prisma.sh/... - 403 Forbidden'),
  );
  check(
    'обратная проба: другой отказ окружным путём НЕ лечится',
    !looksLikeDownloadRefusal('Error: Schema parsing error: Argument "provider" is missing.') &&
      !looksLikeDownloadRefusal('EACCES: permission denied'),
  );
  process.exit(failed > 0 ? 1 : 0);
}

say('— пробую обычный prisma generate');
const direct = tryGenerate({});
if (direct.ok) {
  say('✓ обычный prisma generate прошёл — окружной путь не нужен');
  process.exit(0);
}
const refusedDownload = looksLikeDownloadRefusal(direct.out);
if (!refusedDownload) {
  console.error('✗ prisma generate упал НЕ на скачивании движка — окружной путь тут не поможет:');
  console.error(direct.out.split('\n').slice(-12).join('\n'));
  process.exit(1);
}
say('  отказ именно на скачивании движка — беру то, что уже на диске');

const version = enginesVersion();
const target = currentBinaryTarget();
const found = enginesOnDisk();
if (!found.query && found.foreignQuery) {
  say(`  ВНИМАНИЕ: движка под ${target} в дереве нет, беру под другую платформу (${found.foreignQuery}).`);
  say('  Для generate этого хватит — файл не запускается. Клиент будет годен для типов и перечислений,');
  say('  но НЕ для обращения к базе: библиотеку этой платформы загрузить нельзя.');
  found.query = found.foreignQuery;
}
check(`движок запросов есть в дереве (${target})`, found.query !== null, 'в node_modules его нет — нужен npm install');
check('движок схемы есть в дереве', found.schema !== null, 'в node_modules его нет — нужен npm install');
if (failed > 0) process.exit(1);

const cached = cacheTarget(target, version);
mkdirSync(dirname(cached), { recursive: true });
if (!existsSync(cached)) copyFileSync(found.query, cached);
say(`  движок запросов положен в кэш: ${cached}`);

// Старый клиент ОТОДВИГАЕТСЯ, а не удаляется: в подключённой папке
// моста `unlink` запрещён, и Prisma падала на `unlink` своего же
// wasm.js. Переименование внутри той же папки разрешено — тот же
// приём, которым снимаются застрявшие блокировки git.
if (existsSync(CLIENT_DIR)) {
  // Отодвинутое складывается в ОДИН каталог, а не в новый с меткой
  // времени при каждом прогоне: удалять его нечем, и каждый прогон
  // оставлял бы ещё полтораста мегабайт мусора в node_modules.
  const parkRoot = `${CLIENT_DIR}-stale`;
  mkdirSync(parkRoot, { recursive: true });
  const parked = join(parkRoot, String(Date.now()));
  renameSync(CLIENT_DIR, parked);
  say(`  прежний клиент отодвинут в ${parkRoot}`);
  say('  удалить его можно руками; он всё равно исчезнет при следующем npm install');
}

const second = tryGenerate({
  PRISMA_QUERY_ENGINE_LIBRARY: cached,
  PRISMA_SCHEMA_ENGINE_BINARY: found.schema,
  PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING: '1',
});
check('prisma generate прошёл с движками с диска', second.ok, second.out.split('\n').slice(-8).join('\n'));

if (failed > 0) process.exit(1);
say('\nклиент Prisma сгенерирован. Сеть не использовалась, политика egress не обходилась.');
say('ЧЕГО ЭТО НЕ ДАЁТ: живой базы. migrate/db push/db seed здесь по-прежнему невозможны.');

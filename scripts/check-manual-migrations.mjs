// Пункт [the-sql-nobody-ran] 2026-10-01 — ручные миграции проверяются
// запуском, а не глазами.
//
// ЧТО БЫЛО. 24 файла в `apps/api/prisma/manual-migrations/`, из них 19 —
// обычный SQL, который ВЛАДЕЛЕЦ ПРИМЕНЯЕТ РУКАМИ в Supabase. Реестр
// `admin-db-state/manual-migrations.ts` перечисляет их и у каждой держит
// пробу «применена ли на этом инстансе». Но НИЧТО не проверяло, что эти
// файлы вообще валидный SQL: на живой базе ошибка в них обнаруживается в
// тот момент, когда прод уже не работает, а текст уже вставлен в
// редактор.
//
// ── ЧТО ПОКАЗАЛ ПЕРВЫЙ ЖИВОЙ ПРОГОН, 2026-10-01 ──
//
// Моя первая редакция применяла ВСЕ 19 файлов к свежей базе и считала,
// что каждый обязан быть безвредным повтором. Джоба упала на первом же:
//
//   schema_audit_2026_08_30.sql:19:
//   ERROR: relation "ai_inference_sources" does not exist
//
// И упала ПРАВИЛЬНО — неверным было моё допущение. Эти файлы
// идемпотентны относительно СХЕМЫ СВОЕГО ВРЕМЕНИ, а не относительно
// сегодняшней. Файл от 30 августа правит таблицы, которые позднейшие
// правки схемы убрали: `ai_inference_sources` и
// `project_log_entry_people`. На базе, созданной сегодняшним
// `db push`, их нет — и `ALTER TABLE` по ним падает, сколько бы
// `IF NOT EXISTS` в файле ни стояло.
//
// ВАЖНО, ЧТО ЭТО НЕ ДЕФЕКТ ФАЙЛА. Он отработал на живой базе в своё
// время и остаётся частью истории. Дефектом была проверка, задававшая
// неверный вопрос.
//
// ЧТО ПРОВЕРЯЕТСЯ ТЕПЕРЬ. Для каждого файла считаются таблицы, которые
// он трогает, и сверяются с таблицами сегодняшней `schema.prisma`.
// Файл, трогающий отсутствующую таблицу, — ИСТОРИЧЕСКИЙ: к текущей базе
// он неприменим, CI его не применяет, и причина у этого МЕХАНИЧЕСКАЯ
// (названа отсутствующая таблица), а не ярлык, поставленный руками.
// Остальные применяются, и для них требование идемпотентности остаётся
// в силе.
//
// Это и полезное знание для оператора: «этот файл больше нельзя
// применить к новой базе» — ответ, которого реестр не давал.
//
// pg_cron-файлы исключаются отдельно и намеренно: это не изменения
// схемы, а расписания, их держит `expected-cron-jobs.ts`, и на голом
// postgres:16 расширения pg_cron нет.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DIR = join(REPO, 'apps', 'api', 'prisma', 'manual-migrations');
const REGISTRY = join(REPO, 'apps', 'api', 'src', 'admin-db-state', 'manual-migrations.ts');
const SCHEMA = join(REPO, 'apps', 'api', 'prisma', 'schema.prisma');

/** Комментарии снимаются: иначе закомментированная запись реестра
 *  считалась бы существующей, а закомментированный SQL — применяемым.
 *  Эта ловушка в проекте срабатывала девять раз. */
function stripTsComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function stripSqlComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
}

/** Имена таблиц, которые знает сегодняшняя схема: `@@map`, а если его
 *  нет — имя модели (так Prisma и называет таблицу). */
export function schemaTables(schemaSource) {
  const out = new Set();
  for (const m of schemaSource.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const mapped = /@@map\("([^"]+)"\)/.exec(m[2]);
    out.add(mapped ? mapped[1] : m[1]);
  }
  return out;
}

/** Таблицы, которые трогает SQL-файл. Берутся только те конструкции, у
 *  которых цель — существующая таблица: `ALTER TABLE`, `UPDATE`,
 *  `INSERT INTO`, `DELETE FROM`, `TRUNCATE` и `ON "t"` у индексов.
 *  `CREATE TABLE` намеренно НЕ учитывается: такой файл таблицу создаёт
 *  сам, и её отсутствие в схеме — другой разговор. */
export function tablesTouched(sqlSource) {
  const out = new Set();
  const re = /(?:ALTER\s+TABLE|UPDATE|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\s+(?:IF\s+EXISTS\s+)?"([^"]+)"|\bON\s+"([^"]+)"/gi;
  for (const m of sqlSource.matchAll(re)) out.add(m[1] ?? m[2]);
  return out;
}

const tables = schemaTables(readFileSync(SCHEMA, 'utf8'));
const registrySource = stripTsComments(readFileSync(REGISTRY, 'utf8'));
const inRegistry = [...registrySource.matchAll(/file:\s*'([^']+\.sql)'/g)].map((m) => m[1]);

const onDisk = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const cron = onDisk.filter((f) => f.startsWith('pg_cron_'));
const schemaFiles = onDisk.filter((f) => !f.startsWith('pg_cron_'));

const printOrder = process.argv.includes('--print-order');
let failed = 0;
const fail = (m) => { failed += 1; if (!printOrder) console.error(`✗ ${m}`); };
const ok = (m) => { if (!printOrder) console.log(`✓ ${m}`); };

if (tables.size === 0) fail('схема не разобралась: ни одной модели — проверка смотрела бы в пустоту');
else ok(`схема: ${tables.size} таблиц`);

if (inRegistry.length === 0) fail('реестр не разобрался: ни одной записи `file:`');
else ok(`реестр: ${inRegistry.length} записей`);

const missingInRegistry = schemaFiles.filter((f) => !inRegistry.includes(f));
if (missingInRegistry.length > 0) {
  fail(`файлы есть, а в реестре их нет: ${missingInRegistry.join(', ')}. Такой файл не проверяется CI и не показывается оператору в диагностике схемы.`);
} else ok('каждый SQL-файл есть в реестре');

const missingOnDisk = inRegistry.filter((f) => !schemaFiles.includes(f));
if (missingOnDisk.length > 0) fail(`в реестре названы файлы, которых нет на диске: ${missingOnDisk.join(', ')}`);
else ok('каждая запись реестра соответствует файлу');

const cronInRegistry = inRegistry.filter((f) => f.startsWith('pg_cron_'));
if (cronInRegistry.length > 0) fail(`pg_cron-файлы попали в реестр изменений схемы: ${cronInRegistry.join(', ')}`);
else ok(`pg_cron-файлов ${cron.length}, в реестре схемы их нет — так и должно быть`);

const duplicates = inRegistry.filter((f, i) => inRegistry.indexOf(f) !== i);
if (duplicates.length > 0) fail(`реестр называет файл дважды: ${duplicates.join(', ')}`);
else ok('повторов в реестре нет');

// ── Разделение на применяемые и исторические ────────────────────────
const applicable = [];
const historical = [];
for (const f of inRegistry) {
  const absent = [...tablesTouched(stripSqlComments(readFileSync(join(DIR, f), 'utf8')))]
    .filter((t) => !tables.has(t))
    .sort();
  (absent.length > 0 ? historical : applicable).push({ file: f, absent });
}

if (applicable.length === 0) fail('применяемых файлов не осталось — проверка идемпотентности превратилась бы в пустой цикл');
else ok(`применяемых к текущей схеме: ${applicable.length}`);

if (!printOrder) {
  for (const h of historical) {
    console.log(`•  историческая: ${h.file} — трогает таблицы, которых в схеме больше нет: ${h.absent.join(', ')}`);
  }
  console.log(
    `\nИсторические (${historical.length}) к текущей базе неприменимы и НЕ применяются в CI — это свойство истории, а не дефект файла. ` +
      `pg_cron (${cron.length}) не применяется отдельно и намеренно.`,
  );
}

if (failed > 0) {
  if (printOrder) console.error('check-manual-migrations: список не согласован, порядок не выдаётся');
  process.exit(1);
}

if (printOrder) {
  // Порядок применения — порядок реестра. Алфавит здесь ничего не
  // значит: даты в именах не префиксы.
  for (const a of applicable) console.log(join(DIR, a.file));
}

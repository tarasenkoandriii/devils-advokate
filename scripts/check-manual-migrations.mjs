// Пункт [the-sql-nobody-ran] 2026-10-01 — ручные миграции проверяются
// запуском, а не глазами.
//
// ЧТО БЫЛО. 24 файла в `apps/api/prisma/manual-migrations/`, из них 19 —
// обычный SQL, который ВЛАДЕЛЕЦ ПРИМЕНЯЕТ РУКАМИ в Supabase. Реестр
// `admin-db-state/manual-migrations.ts` перечисляет их и у каждой держит
// пробу «применена ли на этом инстансе» — это закрыл Пункт
// [latest-migration-was-from-memory]. Но НИЧТО не проверяло, что эти
// файлы вообще валидный SQL и что их безопасно применить повторно: на
// живой базе ошибка в них обнаруживается в тот момент, когда прод уже не
// работает, а оператор уже вставил текст в SQL Editor.
//
// А повторное применение здесь не теория, а норма: файлы применяются
// руками, в разные инстансы, и «применил ли я этот?» — обычный вопрос.
// Поэтому все они написаны идемпотентно (`IF NOT EXISTS`,
// `ADD VALUE IF NOT EXISTS`, `DROP NOT NULL`), и CI это ПРОВЕРЯЕТ: на
// чистую базу накатывается `prisma db push`, после чего применяются все
// 19 файлов. На свежей схеме каждый из них обязан быть безвредным
// повтором. Файл без защиты упадёт здесь, а не у владельца.
//
// ЭТОТ СКРИПТ отвечает за список: порядок берётся из реестра (а не из
// алфавита — алфавит здесь ничего не значит), и сверяется, что реестр и
// каталог совпадают в обе стороны. Новый файл, не попавший в реестр,
// иначе был бы молча не проверен и молча не показан оператору в
// диагностике.
//
// pg_cron-файлы в реестр НЕ входят и здесь исключаются намеренно: это
// не изменения схемы, а расписания, и их держит отдельный реестр
// `expected-cron-jobs.ts`. На голом postgres:16 расширения pg_cron нет,
// и притворяться, что мы их проверили, было бы хуже, чем сказать, что не
// проверяем.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DIR = join(REPO, 'apps', 'api', 'prisma', 'manual-migrations');
const REGISTRY = join(REPO, 'apps', 'api', 'src', 'admin-db-state', 'manual-migrations.ts');

/** Комментарии снимаются: иначе закомментированная запись реестра
 *  считалась бы существующей — ловушка, в которую этот проект попадал
 *  неоднократно. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const registrySource = stripComments(readFileSync(REGISTRY, 'utf8'));
const inRegistry = [...registrySource.matchAll(/file:\s*'([^']+\.sql)'/g)].map((m) => m[1]);

const onDisk = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const cron = onDisk.filter((f) => f.startsWith('pg_cron_'));
const schemaFiles = onDisk.filter((f) => !f.startsWith('pg_cron_'));

const printOrder = process.argv.includes('--print-order');
let failed = 0;
const fail = (message) => {
  failed += 1;
  if (!printOrder) console.error(`✗ ${message}`);
};
const ok = (message) => {
  if (!printOrder) console.log(`✓ ${message}`);
};

if (inRegistry.length === 0) fail('реестр не разобрался: ни одной записи `file:` — проверка смотрела бы в пустоту');
else ok(`реестр: ${inRegistry.length} записей`);

const missingInRegistry = schemaFiles.filter((f) => !inRegistry.includes(f));
if (missingInRegistry.length > 0) {
  fail(
    `файлы есть, а в реестре их нет: ${missingInRegistry.join(', ')}. ` +
      'Такой файл не проверяется CI и не показывается оператору в диагностике схемы.',
  );
} else ok('каждый SQL-файл есть в реестре');

const missingOnDisk = inRegistry.filter((f) => !schemaFiles.includes(f));
if (missingOnDisk.length > 0) {
  fail(`в реестре названы файлы, которых нет на диске: ${missingOnDisk.join(', ')}`);
} else ok('каждая запись реестра соответствует файлу');

const cronInRegistry = inRegistry.filter((f) => f.startsWith('pg_cron_'));
if (cronInRegistry.length > 0) {
  fail(
    `pg_cron-файлы попали в реестр изменений схемы: ${cronInRegistry.join(', ')}. ` +
      'Расписания живут в `expected-cron-jobs.ts`, и CI их не применяет — pg_cron на чистом postgres нет.',
  );
} else ok(`pg_cron-файлов ${cron.length}, в реестре схемы их нет — так и должно быть`);

const duplicates = inRegistry.filter((f, i) => inRegistry.indexOf(f) !== i);
if (duplicates.length > 0) fail(`реестр называет файл дважды: ${duplicates.join(', ')}`);
else ok('повторов в реестре нет');

if (failed > 0) {
  if (printOrder) console.error('check-manual-migrations: список не согласован, порядок не выдаётся');
  process.exit(1);
}

if (printOrder) {
  // Порядок применения — порядок реестра. Алфавит здесь ничего не
  // значит: даты в именах не префиксы, и сортировка по имени
  // перемешала бы зависимые правки.
  for (const f of inRegistry) console.log(join(DIR, f));
} else {
  console.log(`\nпорядок применения — из реестра, ${inRegistry.length} файлов; pg_cron (${cron.length}) не применяется намеренно`);
}

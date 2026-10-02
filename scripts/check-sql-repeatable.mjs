// Пункт [the-file-could-not-be-run-twice] 2026-10-02 — ручная миграция,
// про которую написано «повтор безвреден», обязана это выдерживать.
//
// НАЙДЕННОЕ ЖИВЫМ CI. Джоба с настоящим Postgres упала на втором файле
// из восемнадцати: `intake_session.sql:7: ERROR: type "IntakeStatus"
// already exists`. У `CREATE TYPE` в Postgres нет `IF NOT EXISTS` — ни
// в 16, ни в 17, — и файл падал на ПЕРВОМ своём операторе. Значит
// повторное применение не делало НИЧЕГО: ни таблицы, ни индексов, ни
// трёх колонок заморозки проекта в конце файла. Оператор, которому
// сказано «файлы идемпотентны», читает «тип уже есть» как «значит, всё
// на месте» — и колонок могло не быть вовсе. Пробел выглядит как
// полнота, в точности как в обрезанных списках и в удалении проекта.
//
// ИЗМЕРЕНО ПЕРЕД ПРАВИЛОМ. Применимых файлов 18. Соглашению
// `IF NOT EXISTS` следуют СЕМНАДЦАТЬ; не следует один — тот самый
// `intake_session.sql`, и у него защиты нет ни в одном операторе.
// Отдельно нашлась одна незащищённая постановка ограничения в
// `multimodal_media_queue_project.sql`. Третий подозреваемый,
// `person_fact_cascade_2026_09_04.sql`, оказался написан правильно
// (`DROP CONSTRAINT IF EXISTS` перед `ADD CONSTRAINT`) — и это важная
// часть замера: правило заводится на две настоящие строки, а не на
// общий беспорядок.
//
// ЧЕСТНАЯ ГРАНИЦА, И ОНА УЗКАЯ. Проверяется ФОРМА операторов, а не
// идемпотентность файла как таковая. `UPDATE`, который прибавляет
// единицу, этот сторож пропустит, и правильно: отличить «прибавить» от
// «выставить» разбором текста нельзя, а притворяться, что можно, — хуже
// молчания. Настоящее двойное применение проверяет джоба CI на живом
// Postgres; здесь ловятся ровно те пять пород операторов, у которых
// защита существует и её забыли написать.
//
// И ПРО КОММЕНТАРИИ. Это десятый случай в проекте, когда разбор может
// принять закомментированный текст за код. Поэтому комментарии,
// строковые литералы и тела `$$ … $$` снимаются ДО разбора, а ниже
// стоят обратные пробы ровно на это.

import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Текст без комментариев и строковых литералов. Тела `$$ … $$` ОСТАЮТСЯ:
 *  единственная защита для `CREATE TYPE` живёт именно в теле DO-блока, и
 *  вырезав его, правило ниже перестало бы её видеть.
 *
 *  ПОРЯДОК ЗДЕСЬ — НЕ СТИЛЬ, И ОН СТОИЛ ОДНОЙ ПОЙМАННОЙ ОШИБКИ. Первая
 *  редакция этого скрипта делила файл на операторы ДО снятия
 *  комментариев. Блочный комментарий с точкой с запятой внутри
 *  разрезался на куски, кусок терял открывающую `/*` — и дальше выглядел
 *  как настоящий DDL. Поймала это обратная проба ниже, на своём первом
 *  же прогоне: та самая десятая ловушка, про которую написана шапка
 *  файла, в скрипте, который заводится ради неё.
 *
 *  Остаточный случай назван: `--` внутри строкового литерала съел бы
 *  остаток строки. В этом каталоге таких строк нет, а разбор, который
 *  это различает, — уже не сторож, а разборщик SQL. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

export function stripSql(source) {
  return stripComments(source).replace(/'(?:[^']|'')*'/g, " 'LITERAL' ");
}

/** Операторы файла. `DO $$ … $$;` остаётся ОДНИМ оператором: внутри
 *  него есть свои точки с запятой, и разбивка по ним развалила бы
 *  единственную существующую защиту для `CREATE TYPE`. */
export function statements(source) {
  const out = [];
  const re = /DO\s*\$\$[\s\S]*?\$\$\s*;/gi;
  let last = 0;
  let m;
  while ((m = re.exec(source))) {
    out.push(...source.slice(last, m.index).split(';'));
    out.push(m[0]);
    last = m.index + m[0].length;
  }
  out.push(...source.slice(last).split(';'));
  return out.map((s) => s.trim()).filter(Boolean);
}

const RULES = [
  {
    name: 'CREATE TYPE без перехвата duplicate_object',
    why: 'у CREATE TYPE нет IF NOT EXISTS — единственная защита это DO-блок с EXCEPTION WHEN duplicate_object',
    hit: (st) => /\bCREATE\s+TYPE\b/i.test(st) && !/duplicate_object/i.test(st),
  },
  {
    name: 'CREATE TABLE без IF NOT EXISTS',
    why: 'повтор упадёт на «relation already exists», и всё, что в файле ниже, не применится',
    hit: (st) => /\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i.test(st),
  },
  {
    name: 'CREATE INDEX без IF NOT EXISTS',
    why: 'повтор упадёт на «relation already exists»',
    hit: (st) => /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?!IF\s+NOT\s+EXISTS)/i.test(st),
  },
  {
    name: 'ADD COLUMN без IF NOT EXISTS',
    why: 'повтор упадёт на «column already exists»',
    hit: (st) => /\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i.test(st),
  },
  {
    name: 'ALTER TYPE ADD VALUE без IF NOT EXISTS',
    why: 'повтор упадёт на «enum label already exists»',
    hit: (st) => /\bADD\s+VALUE\s+(?!IF\s+NOT\s+EXISTS)/i.test(st),
  },
];

/** Постановка ограничения, не защищённая НИ ОДНИМ из двух принятых в
 *  проекте приёмов.
 *
 *  Проверка ИМЕННАЯ, а не «есть ли где-то в файле слово DROP»: снятие
 *  другого ограничения не делает эту постановку безопасной, и общая
 *  проверка зеленела бы на файле, который падает.
 *
 *  ПРИЁМОВ ДВА, И ПЕРВЫЙ ПРОГОН ЭТОГО СТОРОЖА ЗНАЛ ТОЛЬКО ОДИН. Он выдал
 *  два замечания на `project_log_v2_2026_09_03.sql` — и оба были
 *  неправдой: файл защищён иначе, через `IF NOT EXISTS (SELECT 1 FROM
 *  pg_constraint WHERE conname = …)`. Сторож, знающий одну форму из двух,
 *  толкал бы следующего автора переписывать верный код — то есть был бы
 *  не страховкой, а шумом. Поэтому признаются оба приёма.
 *
 *  Имена берутся ДО снятия строковых литералов: во второй форме имя
 *  ограничения живёт именно в литерале, и очистка стирала бы его. */
export function constraintsWithoutDrop(source) {
  const clean = stripComments(source);
  const guarded = new Set([
    ...[...clean.matchAll(/DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+"?([A-Za-z0-9_]+)"?/gi)].map((m) => m[1]),
    ...[...clean.matchAll(/conname\s*=\s*'([A-Za-z0-9_]+)'/gi)].map((m) => m[1]),
  ]);
  const added = [...clean.matchAll(/ADD\s+CONSTRAINT\s+"?([A-Za-z0-9_]+)"?/gi)].map((m) => m[1]);
  return added.filter((n) => !guarded.has(n));
}

/** Все замечания по одному файлу. */
export function problems(source) {
  const out = [];
  // Снятие — ОДИН раз и ДО деления на операторы: см. комментарий у stripSql.
  for (const st of statements(stripSql(source))) {
    for (const rule of RULES) if (rule.hit(st)) out.push(`${rule.name} — ${rule.why}`);
  }
  for (const n of constraintsWithoutDrop(source)) {
    out.push(`ADD CONSTRAINT "${n}" без DROP CONSTRAINT IF EXISTS того же имени — у ограничений нет IF NOT EXISTS`);
  }
  return out;
}

// ── Прогон ──────────────────────────────────────────────────────────

let failed = 0;
const check = (what, pass, detail = '') => {
  if (pass) console.log(`✓ ${what}`);
  else {
    failed += 1;
    console.error(`✗ ${what}${detail ? ` — ${detail}` : ''}`);
  }
};

// Список применимых файлов берётся У СОСЕДНЕГО СКРИПТА, а не считается
// заново: «применимый» там уже определён механически (файл не трогает
// таблиц, которых в схеме больше нет), и второе определение того же
// понятия разошлось бы с первым — ровно та порода дефекта, которую
// проект ловит весь месяц.
const order = execFileSync('node', [resolve(REPO, 'scripts/check-manual-migrations.mjs'), '--print-order'], {
  encoding: 'utf8',
})
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

check('список применимых файлов получен', order.length > 0, 'соседний скрипт не вернул ни одного файла');

const offenders = [];
for (const file of order) {
  const found = problems(readFileSync(file, 'utf8'));
  for (const p of found) offenders.push(`${basename(file)}: ${p}`);
}
check(
  `все ${order.length} применимых файлов защищены от повторного применения`,
  offenders.length === 0,
  offenders.length > 0 ? `\n    ${offenders.join('\n    ')}` : '',
);

// ── Самопроверки и обратные пробы ───────────────────────────────────
//
// Без них пустой список выше означал бы не порядок, а сломанный разбор.

const BAD = `
CREATE TYPE "X" AS ENUM ('A');
CREATE TABLE "t" (id TEXT);
CREATE INDEX "t_idx" ON "t"(id);
ALTER TABLE "t" ADD COLUMN "c" TEXT;
ALTER TABLE "t" ADD CONSTRAINT "t_fk" FOREIGN KEY (id) REFERENCES "u"(id);
ALTER TYPE "X" ADD VALUE 'B';
`;
const GOOD = `
DO $$ BEGIN CREATE TYPE "X" AS ENUM ('A'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS "t" (id TEXT);
CREATE INDEX IF NOT EXISTS "t_idx" ON "t"(id);
ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "c" TEXT;
ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "t_fk";
ALTER TABLE "t" ADD CONSTRAINT "t_fk" FOREIGN KEY (id) REFERENCES "u"(id);
ALTER TYPE "X" ADD VALUE IF NOT EXISTS 'B';
`;
const COMMENTED = `
-- CREATE TYPE "X" AS ENUM ('A');
/* CREATE TABLE "t" (id TEXT);
   ALTER TABLE "t" ADD CONSTRAINT "t_fk" FOREIGN KEY (id) REFERENCES "u"(id); */
INSERT INTO notes (text) VALUES ('CREATE INDEX "t_idx" ON "t"(id)');
`;

check('проба механизма: незащищённый образец даёт все шесть замечаний', problems(BAD).length === 6, `получено ${problems(BAD).length}`);
check('проба механизма: защищённый образец не даёт ни одного', problems(GOOD).length === 0, problems(GOOD).join('; '));
check('ОБРАТНАЯ ПРОБА: те же операторы В КОММЕНТАРИЯХ и в строке не считаются', problems(COMMENTED).length === 0, problems(COMMENTED).join('; '));
check(
  'проба механизма: вторая принятая форма защиты (conname в pg_constraint) признаётся',
  constraintsWithoutDrop(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 't_fk') THEN ALTER TABLE "t" ADD CONSTRAINT "t_fk" FOREIGN KEY (id) REFERENCES "u"(id); END IF; END $$;`,
  ).length === 0,
);
check(
  'ОБРАТНАЯ ПРОБА: проверка второй формы ИМЕННАЯ — чужое имя в conname не оправдывает',
  constraintsWithoutDrop(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'other_fk') THEN ALTER TABLE "t" ADD CONSTRAINT "t_fk" FOREIGN KEY (id) REFERENCES "u"(id); END IF; END $$;`,
  ).length === 1,
);
check(
  'ОБРАТНАЯ ПРОБА: снятие ДРУГОГО ограничения не оправдывает постановку этого',
  constraintsWithoutDrop('ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "other"; ALTER TABLE "t" ADD CONSTRAINT "t_fk" FOREIGN KEY (id) REFERENCES "u"(id);').length === 1,
);
check(
  'ОБРАТНАЯ ПРОБА: DO-блок остаётся одним оператором (иначе защита CREATE TYPE развалилась бы по точкам с запятой)',
  statements(GOOD)[0].startsWith('DO') && statements(GOOD)[0].includes('duplicate_object'),
);

if (failed > 0) {
  console.log(`\nпровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nручные миграции выдерживают повторное применение');

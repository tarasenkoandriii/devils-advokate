// Сверка 2026-09-30 — числа в операторских документах против кода.
//
// НАЙДЕНО, шесть расхождений, и все в документах, по которым владелец
// РАЗВОРАЧИВАЕТ И ПРОВЕРЯЕТ прод:
//
//  1. `VERCEL.md` §2: «`pg_cron`-задания (ТРИ ФАЙЛА в
//     `prisma/manual-migrations/pg_cron_*.sql`) применяются отдельно».
//     Файлов пять, заданий в них семь. По букве этого абзаца
//     `pg_cron_job_search_refetch.sql` не применялся — и последствие
//     названо в самом реестре: «Вакансии, за которыми человек сам
//     попросил следить, не перечитываются». Документ при этом
//     противоречил себе: §3 перечисляет все пять, но первым читается
//     §2. ЕДИНСТВЕННОЕ расхождение с прямым эксплуатационным
//     последствием.
//  2. `SCHEDULER_DISPATCH_SECRET` — «три pg_cron-задания». Под ним
//     четыре задания плюс три маршрута, которые pg_cron не дёргает.
//  3. `SANDBOX-COVERAGE.md`: «13 пунктов» чеклиста — их 15 в рабочем
//     случае (13 — это число пунктов, когда база НЕДОСТУПНА); «5 типов»
//     согласий — их шесть.
//  4. `VERCEL.md` «Первый оператор»: `isOperator` открывает семь
//     вкладок — открывает десять, и три неназванные это «Sandbox»
//     (тратит реальные деньги), «БД» (экран потолков расходов) и
//     «Аудит».
//  5. `VERCEL.md`: «в схеме 225 `@@index`, в `manual-migrations/` — 122
//     `CREATE INDEX`» — 266 и 130. Вывод о расхождении схемы с продом
//     опирался на эти числа.
//  6. `DOCKER.md`: `manual-migrations/` как «два файла плюс
//     `pg_cron_*`» — в папке 24; «четыре одинаковых экрана «нет
//     доступа»» — вкладок двенадцать.
//
// ЧЕГО ЭТА СВЕРКА НЕ УМЕЕТ, и это надо сказать прямо: у markdown-файла
// нет поведения, и единственный способ проверить написанное в нём —
// прочитать написанное. Поэтому здесь ЧИСЛА сверяются с кодом и
// файлами, а не формулировки друг с другом; качество текста тестом не
// проверяется.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { EXPECTED_CRON_JOBS } from '../admin-db-state/expected-cron-jobs';

const REPO = join(__dirname, '..', '..', '..', '..');
const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'manual-migrations');

const doc = (name: string) => readFileSync(join(REPO, name), 'utf8');

function cronFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.startsWith('pg_cron_') && f.endsWith('.sql'));
}

/** Задания в файлах — по ВЫЗОВАМ, а не по упоминаниям.
 *
 * И это третий раз за сессию, когда разбор читает комментарий как код,
 * поэтому запись остаётся здесь. Предварительный замер дал «девять
 * заданий» и разошёлся с реестром на два: `grep -c cron.schedule` в
 * `pg_cron_reminders.sql` считает ТРИ, из которых две строки —
 * объяснение в комментарии («cron.schedule() — это не таблицы», «если
 * перезапускаете настройку»). Настоящих вызовов там один, и всего их
 * семь, ровно как в реестре. Ловушка та же, что уже описана в
 * `audit-2026-09-04-guard-audit.spec.ts` и в шапке
 * `blank-strings.ts`: снимать комментарии надо ПЕРЕД разбором, а не
 * после того, как число уже записано в отчёт. */
function cronJobsInFiles(): number {
  return cronFiles().reduce((n, f) => {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8').replace(/^\s*--.*$/gm, '');
    return n + (sql.match(/cron\.schedule/g) ?? []).length;
  }, 0);
}

function navTabs(): { total: number; operator: number } {
  const nav = readFileSync(join(REPO, 'apps', 'admin', 'src', 'components', 'AdminNav.tsx'), 'utf8');
  const items = [...nav.matchAll(/\{ href: '[^']+', label: '[^']+', visible: me\.(\w+) \}/g)].map((m) => m[1]);
  return { total: items.length, operator: items.filter((f) => f === 'isOperator').length };
}

describe('[three-said-seven] числа в документах деплоя совпадают с кодом', () => {
  it('проба механизма: разбор находит и файлы, и задания, и вкладки', () => {
    // Без этого любое «совпало» ниже означало бы сломанный разбор.
    expect(cronFiles().length).toBeGreaterThan(1);
    expect(cronJobsInFiles()).toBeGreaterThan(1);
    expect(navTabs().total).toBeGreaterThan(5);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: реестр крон-заданий, файлы и VERCEL.md говорят одно и то же', () => {
    const files = cronFiles();
    const jobs = cronJobsInFiles();
    // Реестр в коде и сами файлы — прежде всего между собой.
    expect(EXPECTED_CRON_JOBS.length).toBe(jobs);
    expect(files.length).toBe(5);
    expect(jobs).toBe(7);

    const vercel = doc('VERCEL.md');
    // Число файлов названо, и каждый файл назван ПОИМЁННО: по букве
    // прежнего абзаца два файла из пяти не применялись.
    expect(vercel.includes('Файлов пять, заданий в них семь')).toBe(true);
    for (const f of files) expect(vercel.includes(f)).toBe(true);
    // И «три файла» больше нигде не обещано.
    expect(/\(три файла в/.test(vercel)).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: вкладки админки — столько, сколько их в коде', () => {
    const { total, operator } = navTabs();
    expect(total).toBe(12);
    expect(operator).toBe(10);
    const vercel = doc('VERCEL.md');
    expect(vercel.includes('**десять** вкладок')).toBe(true);
    // Три прежде неназванные — поимённо: пропущены были именно они.
    for (const tab of ['«Sandbox»', '«БД»', '«Аудит»']) expect(vercel.includes(tab)).toBe(true);
    const docker = doc('DOCKER.md');
    expect(docker.includes('двенадцать одинаковых экранов')).toBe(true);
    expect(docker.includes('четыре одинаковых экрана')).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: числа индексов и ручных миграций — настоящие', () => {
    const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
    const indexes = (schema.match(/@@index/g) ?? []).length;
    const sqlFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    let creates = 0;
    for (const f of sqlFiles) {
      creates += (readFileSync(join(MIGRATIONS, f), 'utf8').match(/create\s+(unique\s+)?index/gi) ?? []).length;
    }
    const vercel = doc('VERCEL.md');
    expect(vercel.includes(`в схеме ${indexes} \`@@index\``)).toBe(true);
    expect(vercel.includes(`— ${creates} \`CREATE INDEX\``)).toBe(true);

    const docker = doc('DOCKER.md');
    expect(sqlFiles.length).toBe(24);
    expect(docker.includes('**24: пять `pg_cron_*.sql` и девятнадцать прочих**')).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: чеклист песочницы и число операторских согласий', () => {
    const svc = readFileSync(join(__dirname, '..', 'admin-sandbox', 'admin-sandbox.service.ts'), 'utf8');
    // Пункты чеклиста опознаём по их ключам в `readiness()`; два из них
    // условные (`capabilities`, `consents` — только при доступной базе),
    // и прежнее «13» описывало именно случай НЕДОСТУПНОЙ базы.
    const readiness = svc.slice(svc.indexOf('async getStatus('), svc.indexOf('async getStatus(') + 12_000);
    const keys = new Set([...readiness.matchAll(/key: '([a-z-]+)'/g)].map((m) => m[1]));
    expect(keys.size).toBe(15);
    const consentTypes = (svc.match(/ConsentType\.\w+,/g) ?? []).length;
    const coverage = doc('SANDBOX-COVERAGE.md');
    expect(coverage.includes('15 пунктов')).toBe(true);
    expect(coverage.includes('13 из них безусловные')).toBe(true);
    expect(coverage.includes(`${consentTypes} типов, source=admin-sandbox`)).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: Soniox назван в реестре внешних API, а не только в «где взять ключ»', () => {
    const keys = doc('API-AND-KEYS.md');
    const registry = keys.slice(keys.indexOf('### 1.2 Речь'), keys.indexOf('### 1.3 Google'));
    // Провайдер распознавания РУССКОГО и УКРАИНСКОГО — основных языков
    // продукта — в «полном реестре внешних API» отсутствовал.
    expect(registry.includes('SONIOX_API_KEY')).toBe(true);
    // И служебные переменные, которых в §1.5 не было.
    for (const name of [
      'STT_WEBHOOK_SECRET',
      'TRANSCRIPTIONS_PER_USER_PER_DAY',
      'TRANSCRIPTION_MINUTES_PER_USER_PER_DAY',
      'TELEGRAM_MINI_APP_URL',
      'TELEGRAM_BOT_USERNAME',
      'PLACES_REQUESTS_PER_USER_PER_DAY',
    ]) {
      expect(keys.includes(name)).toBe(true);
    }
  });
});

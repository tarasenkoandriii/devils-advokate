// Пункт [background-jobs] 2026-09-04 — что должно стоять в pg_cron,
// одним списком.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ ВООБЩЕ ПОЯВИЛСЯ. Вкладка «БД» показывала таблицу
// джоб, которые НА ИНСТАНСЕ ЕСТЬ, и сверяла расписание с тремя именами,
// зашитыми в код экрана (`EXPECTED_SCHEDULES` — только джобы из
// pg_cron_ai_jobs.sql). В репозитории джоб семь, в пяти файлах. Отсюда
// два молчания сразу:
//
//  • джоба, которую забыли применить на живом инстансе, не давала НИ
//    ОДНОЙ строки. Оператор видел таблицу из трёх зелёных «совпадает» и
//    читал её как «всё настроено» — при том, что напоминания о
//    разговорах, например, не отправлялись ни разу с самого деплоя.
//    Ровно та же форма, что уже находилась в обрезанных списках, в
//    удалении проекта и в выгрузке данных: ПРОБЕЛ ВЫГЛЯДИТ КАК ПОЛНОТА;
//  • наши же четыре джобы из остальных файлов помечались «не наша
//    (другой файл)» — то есть экран называл чужим то, что сам проект и
//    поставляет.
//
// Список здесь, в API, а не в админке: сверка «что ожидается» — знание
// backend'а о собственной инфраструктуре, экран его только рисует.
// Синхронность с SQL-файлами держит не дисциплина, а тест
// (audit-2026-09-04-background-jobs.spec.ts): он читает
// prisma/manual-migrations/pg_cron_*.sql, вытаскивает оттуда все
// cron.schedule() и требует посимвольного совпадения с этим массивом.
// Новый крон-файл без записи здесь роняет тест — иначе список снова
// отстанет от реальности, как отстал EXPECTED_SCHEDULES.

export interface ExpectedCronJob {
  /** Имя джобы ровно как в cron.schedule() SQL-файла. */
  jobname: string;
  /** Расписание ровно как в файле. */
  schedule: string;
  /** Файл, которым джоба ставится вручную через SQL Editor. */
  file: string;
  /** Что именно перестаёт работать, если джобы на инстансе нет.
   * Формулировка — для оператора, а не для разработчика: он читает её в
   * момент, когда что-то уже не работает. */
  breaksWhenMissing: string;
}

export const EXPECTED_CRON_JOBS: ExpectedCronJob[] = [
  {
    jobname: 'ai-jobs-submit',
    schedule: '* * * * *',
    file: 'pg_cron_ai_jobs.sql',
    breaksWhenMissing:
      'Задачи к моделям не уходят провайдеру: разбор остаётся в очереди (QUEUED) навсегда, человек видит вечное «считаем».',
  },
  {
    jobname: 'ai-jobs-poll',
    schedule: '*/3 * * * *',
    file: 'pg_cron_ai_jobs.sql',
    breaksWhenMissing:
      'Готовый ответ провайдера никто не забирает: задача висит в RUNNING, пока её не подберёт сторожевая — то есть до истечения аренды, а не до готовности.',
  },
  {
    jobname: 'ai-jobs-reap',
    schedule: '* * * * *',
    file: 'pg_cron_ai_jobs.sql',
    breaksWhenMissing:
      'Зависшие задачи не переводятся в ошибку, аренды аудио не истекают (файл остаётся в хранилище), голосовые реплики висят в PENDING, протухшие кэши не удаляются.',
  },
  {
    jobname: 'dispatch-scheduled-conversation-reminders',
    schedule: '* * * * *',
    file: 'pg_cron_reminders.sql',
    breaksWhenMissing:
      'Напоминания о запланированном разговоре и о постфактум-разборе не отправляются ВООБЩЕ. Отличить это от «напоминать нечего» по экрану нельзя.',
  },
  {
    jobname: 'recompute-scenario-calibration',
    schedule: '0 4 * * *',
    file: 'pg_cron_calibration.sql',
    breaksWhenMissing:
      'Эмпирическая точность сценариев не пересчитывается: калибровка застывает на дне последнего запуска и тихо расходится с реальностью.',
  },
  {
    jobname: 'abandon-stale-intake-sessions',
    schedule: '15 3 * * *',
    file: 'pg_cron_intake_abandon.sql',
    breaksWhenMissing:
      'Брошенные intake-квизы остаются «в процессе» навсегда — и в статистике воронки, и в списках у самого человека.',
  },
  {
    jobname: 'job-search-refetch-watched',
    schedule: '40 3 * * *',
    file: 'pg_cron_job_search_refetch.sql',
    breaksWhenMissing:
      'Вакансии, за которыми человек сам попросил следить, не перечитываются: изменение условий или снятие с публикации не заметит никто.',
  },
];

export interface CronJobPresence {
  jobname: string;
  schedule: string;
  file: string;
  breaksWhenMissing: string;
  /** null — джобы на инстансе нет вообще. */
  actualSchedule: string | null;
  /** false — джоба есть, но выключена (active = false). */
  active: boolean | null;
}

/** Сверка ожидаемого с фактическим. Возвращает ВСЕ ожидаемые джобы, а не
 * только совпавшие: отсутствующая обязана попасть в ответ строкой, иначе
 * повторится ровно то молчание, ради которого файл и написан. */
export function compareCronJobs(
  actual: Array<{ jobname: string; schedule: string; active: boolean }>,
): { jobs: CronJobPresence[]; missing: string[]; mismatched: string[]; disabled: string[] } {
  const byName = new Map(actual.map((j) => [j.jobname, j]));
  const jobs: CronJobPresence[] = EXPECTED_CRON_JOBS.map((e) => {
    const found = byName.get(e.jobname);
    return {
      jobname: e.jobname,
      schedule: e.schedule,
      file: e.file,
      breaksWhenMissing: e.breaksWhenMissing,
      actualSchedule: found ? found.schedule : null,
      active: found ? found.active : null,
    };
  });
  return {
    jobs,
    missing: jobs.filter((j) => j.actualSchedule === null).map((j) => j.jobname),
    mismatched: jobs.filter((j) => j.actualSchedule !== null && j.actualSchedule !== j.schedule).map((j) => j.jobname),
    disabled: jobs.filter((j) => j.actualSchedule !== null && j.active === false).map((j) => j.jobname),
  };
}

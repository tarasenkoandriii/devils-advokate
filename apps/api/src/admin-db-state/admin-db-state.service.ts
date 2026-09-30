// Пункт [db-state] 2026-09-01 — вкладка «БД» в админке: расписание
// pg_cron-джоб, лог их запусков, ответы pg_net и сводка ai_jobs — то,
// что во время живых прогонов приходилось каждый раз пробивать руками
// через SQL Editor Supabase (по прямому запросу: «чтобы не пробивать
// руками в базе каждый раз»).
//
// Read-only ПОЛНОСТЬЮ: ни одного UPDATE/unschedule — управление кронами
// остаётся за pg_cron_ai_jobs.sql (ручное применение, там же
// однострочники alter_job). Смотреть и менять — разные права; вкладка
// только смотрит.
//
// БЕЗОПАСНОСТЬ, главное решение этого файла: колонка command из
// cron.job и cron.job_run_details НЕ выбирается НИКОГДА — в командах
// наших джоб буквально захардкожен x-dispatch-secret (см.
// pg_cron_ai_jobs.sql), отдать command в браузер = показать секрет
// любому оператору и положить его в девтулзы/логи. Выбираются только
// jobname/schedule/active/статусы — этого достаточно для «жив ли крон».
//
// Каждая секция загружается независимо и падает независимо (safe()):
// на локальной БД без pg_cron/pg_net вкладка честно покажет «ошибка:
// relation cron.job does not exist» в двух секциях и живые данные в
// остальных, а не пустую страницу.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { compareCronJobs, CronJobPresence } from './expected-cron-jobs';
import { MANUAL_MIGRATIONS } from './manual-migrations';
import { compareSchemaTables, type SchemaTablesDrift } from './schema-tables';
import { ceilingsState, type CeilingsState } from './spend-ceilings-state';

export interface DbStateCronJob {
  jobname: string;
  schedule: string;
  active: boolean;
}

export interface DbStateCronRun {
  jobname: string;
  status: string;
  returnMessage: string | null;
  startTime: string | null;
  endTime: string | null;
}

export interface DbStateHttpResponse {
  statusCode: number | null;
  content: string | null;
  timedOut: boolean | null;
  errorMsg: string | null;
  created: string;
}

export interface DbStateAiJobs {
  byStatus: Record<string, number>;
  recent: Array<{
    id: string;
    taskType: string | null;
    status: string;
    retryCount: number;
    submitted: boolean;
    leaseExpiresAt: string | null;
    note: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}

/** Пункт [background-jobs] 2026-09-04: сверка «что поставляет репозиторий»
 * с «что стоит на инстансе». Отдельная секция от cronJobs намеренно —
 * cronJobs отвечает на вопрос «что там есть», эта на вопрос «чего там
 * нет», и второй вопрос экран раньше не задавал вообще. */
export interface DbStateExpectedCron {
  jobs: CronJobPresence[];
  missing: string[];
  mismatched: string[];
  disabled: string[];
}

/** Пункт [latest-migration-was-from-memory] 2026-09-24 — состояние
 * ручных миграций НА ЭТОМ инстансе.
 *
 * Три ответа, а не два: применена, не применена и «по схеме не видно».
 * Третий — честный: часть миграций снимает NOT NULL или меняет внешний
 * ключ, и по наличию колонки сказать нельзя ничего. Выдать такую за
 * применённую значило бы успокоить впустую. */
export type MigrationState = 'applied' | 'missing' | 'not-observable';

export interface DbStateMigration {
  file: string;
  state: MigrationState;
  /** Почему не видно — только для `not-observable`. */
  why?: string;
  breaksWhenMissing: string;
}

export type DbStateSection<T> = T | { error: string };

const RUNS_LIMIT = 60;
const HTTP_RESPONSES_LIMIT = 60;
const RECENT_JOBS_LIMIT = 10;

@Injectable()
export class AdminDbStateService {
  constructor(private readonly prisma: PrismaService) {}

  /** Та же граница, что у остальных операционных вкладок (§4.1
   * admin-panel-tz): состояние инфраструктуры — операторское, не
   * модераторское. */
  private async assertOperator(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isOperator: true } });
    if (!user?.isOperator) {
      throw new ForbiddenException('Требуется роль оператора');
    }
  }

  private async safe<T>(load: () => Promise<T>): Promise<DbStateSection<T>> {
    try {
      return await load();
    } catch (err) {
      // Текст ошибки Postgres («relation "cron.job" does not exist»,
      // «permission denied») — сам по себе диагноз, показываем как есть.
      return { error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
  }

  async getState(operatorUserId: string): Promise<{
    generatedAt: string;
    cronJobs: DbStateSection<DbStateCronJob[]>;
    expectedCron: DbStateSection<DbStateExpectedCron>;
    cronRuns: DbStateSection<DbStateCronRun[]>;
    httpResponses: DbStateSection<DbStateHttpResponse[]>;
    aiJobs: DbStateSection<DbStateAiJobs>;
    manualMigrations: DbStateSection<DbStateMigration[]>;
    // Пункт [deploy-step-did-nothing] 2026-09-26: сверка имён таблиц со
    // схемой. `VERCEL.md` честно писал, что боевую базу не проверяет
    // ничто; теперь проверяет — ровно в том объёме, который можно
    // утверждать точно, и говорит, чего не проверяет.
    schemaTables: DbStateSection<SchemaTablesDrift>;
    // Пункт [the-lever-that-silently-did-nothing] 2026-09-30: потолки
    // расходов на ЭТОМ развёртывании — и причина, по которой каждый
    // действует. НЕ через safe(): здесь нет ни запроса к базе, ни
    // внешнего вызова, падать нечему, и обёртка изображала бы риск,
    // которого нет.
    spendCeilings: CeilingsState;
  }> {
    await this.assertOperator(operatorUserId);
    const [cronJobs, cronRuns, httpResponses, aiJobs, manualMigrations, schemaTables] = await Promise.all([
      this.safe(() => this.fetchCronJobs()),
      this.safe(() => this.fetchCronRuns()),
      this.safe(() => this.fetchHttpResponses()),
      this.safe(() => this.fetchAiJobs()),
      this.safe(() => this.fetchManualMigrations()),
      this.safe(() => this.fetchSchemaTables()),
    ]);
    // Сверка возможна только если список джоб прочитался. Если cron.job
    // недоступна (локальная БД без pg_cron), честнее повторить ту же
    // ошибку, чем показать все семь джоб как «отсутствуют»: «не смогли
    // посмотреть» и «там пусто» — разные утверждения.
    const expectedCron: DbStateSection<DbStateExpectedCron> = Array.isArray(cronJobs)
      ? compareCronJobs(cronJobs)
      : cronJobs;
    return {
      generatedAt: new Date().toISOString(),
      cronJobs,
      expectedCron,
      cronRuns,
      httpResponses,
      aiJobs,
      manualMigrations,
      schemaTables,
      spendCeilings: ceilingsState(),
    };
  }

  /** Пункт [latest-migration-was-from-memory] 2026-09-24. Проба по
   * схеме: колонка из `information_schema`, значение перечисления из
   * `pg_enum`. Оба запроса — по каталогу базы, без чтения данных
   * пользователей. */
  private async fetchManualMigrations(): Promise<DbStateMigration[]> {
    const columns = await this.prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const present = new Set(columns.map((c) => `${c.table_name}.${c.column_name}`));
    const enums = await this.prisma.$queryRawUnsafe<Array<{ typname: string; enumlabel: string }>>(
      `SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid`,
    );
    const enumValues = new Set(enums.map((e) => `${e.typname}.${e.enumlabel}`));

    return MANUAL_MIGRATIONS.map((m) => {
      if (m.probe.kind === 'none') {
        return { file: m.file, state: 'not-observable' as const, why: m.probe.why, breaksWhenMissing: m.breaksWhenMissing };
      }
      const found =
        m.probe.kind === 'column'
          ? present.has(`${m.probe.table}.${m.probe.column}`)
          : enumValues.has(`${m.probe.type}.${m.probe.value}`);
      return { file: m.file, state: found ? ('applied' as const) : ('missing' as const), breaksWhenMissing: m.breaksWhenMissing };
    });
  }

  /** Пункт [deploy-step-did-nothing] 2026-09-26 — сверка имён таблиц.
   *
   * Схема читается с диска: единственный источник объявлений — сам
   * `schema.prisma`, и держать рядом его копию значило бы завести
   * второе место, которое разойдётся (урок пункта
   * [screen-said-what-server-unsaid]).
   *
   * Запрос — по каталогу базы, без чтения данных пользователей, как и
   * остальные секции этой вкладки. */
  private async fetchSchemaTables(): Promise<SchemaTablesDrift> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const schema = await readFile(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
    return compareSchemaTables(schema, rows.map((r) => r.table_name));
  }

  /** cron.job — jobid::int, потому что bigint не переживает
   * JSON.stringify нашего конверта (BigInt serialization error) —
   * тот же каст во всех запросах ниже. */
  private async fetchCronJobs(): Promise<DbStateCronJob[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ jobname: string | null; schedule: string; active: boolean }>
    >('SELECT jobname, schedule, active FROM cron.job ORDER BY jobname NULLS LAST');
    return rows.map((r) => ({ jobname: r.jobname ?? '(без имени)', schedule: r.schedule, active: r.active }));
  }

  /** Лог запусков. LEFT JOIN, а не JOIN: job_run_details хранит и
   * запуски уже удалённых (unschedule) джоб — их видно как jobid=N.
   * ВАЖНО про смысл: status='succeeded' у наших джоб означает только
   * «net.http_post поставлен в очередь pg_net», НЕ «HTTP-вызов прошёл» —
   * реальный ответ API в секции httpResponses ниже. */
  private async fetchCronRuns(): Promise<DbStateCronRun[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ jobname: string | null; jobid: number; status: string; return_message: string | null; start_time: Date | null; end_time: Date | null }>
    >(
      `SELECT COALESCE(j.jobname, 'jobid=' || d.jobid::text) AS jobname, d.jobid::int AS jobid,
              d.status, left(d.return_message, 300) AS return_message, d.start_time, d.end_time
         FROM cron.job_run_details d
         LEFT JOIN cron.job j ON j.jobid = d.jobid
        ORDER BY d.start_time DESC NULLS LAST
        LIMIT ${RUNS_LIMIT}`,
    );
    return rows.map((r) => ({
      jobname: r.jobname ?? `jobid=${r.jobid}`,
      status: r.status,
      returnMessage: r.return_message,
      startTime: r.start_time ? r.start_time.toISOString() : null,
      endTime: r.end_time ? r.end_time.toISOString() : null,
    }));
  }

  /** net._http_response — фактические ответы наших internal-эндпоинтов
   * на вызовы кронов ({"completed":N,...}, 401 при рассинхроне секрета,
   * 5xx при падении функции). pg_net чистит таблицу сам (TTL ~6 часов) —
   * пустая секция на тихом инстансе нормальна. URL в таблице нет
   * (pg_net его не хранит) — какой эндпоинт ответил, видно по телу. */
  private async fetchHttpResponses(): Promise<DbStateHttpResponse[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ status_code: number | null; content: string | null; timed_out: boolean | null; error_msg: string | null; created: Date }>
    >(
      `SELECT status_code, left(coalesce(content, ''), 400) AS content, timed_out, error_msg, created
         FROM net._http_response
        ORDER BY created DESC
        LIMIT ${HTTP_RESPONSES_LIMIT}`,
    );
    return rows.map((r) => ({
      statusCode: r.status_code,
      content: r.content,
      timedOut: r.timed_out,
      errorMsg: r.error_msg,
      created: r.created.toISOString(),
    }));
  }

  private async fetchAiJobs(): Promise<DbStateAiJobs> {
    const [grouped, recent] = await Promise.all([
      this.prisma.aIJob.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.aIJob.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: RECENT_JOBS_LIMIT,
        select: {
          id: true,
          taskType: true,
          status: true,
          retryCount: true,
          externalInteractionId: true,
          leaseExpiresAt: true,
          partialResult: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);
    const byStatus: Record<string, number> = {};
    for (const g of grouped as Array<{ status: string; _count: { _all: number } }>) {
      byStatus[g.status] = g._count._all;
    }
    return {
      byStatus,
      recent: recent.map((j) => ({
        id: j.id,
        taskType: j.taskType,
        status: j.status,
        retryCount: j.retryCount,
        submitted: Boolean(j.externalInteractionId),
        leaseExpiresAt: j.leaseExpiresAt ? j.leaseExpiresAt.toISOString() : null,
        // partialResult у нас несёт человекочитаемые заметки воркера
        // («ожидание: последняя ошибка опроса …») — обрезаем, не тянем
        // мегабайтные тела в сводку.
        note: j.partialResult ? j.partialResult.slice(0, 300) : null,
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
      })),
    };
  }
}

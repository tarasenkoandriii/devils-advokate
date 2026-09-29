// Пункт [db-state] 2026-09-01 — вкладка «БД»: read-only зеркало
// pg_cron/pg_net/ai_jobs. Ключевые контракты: (1) колонка command
// НИКОГДА не запрашивается — в ней захардкожен x-dispatch-secret;
// (2) секции падают независимо — локальная БД без pg_cron отдаёт
// ошибку секции, не роняет всю вкладку; (3) операторская граница.

import { ForbiddenException } from '@nestjs/common';
import { AdminDbStateService } from '../admin-db-state/admin-db-state.service';

const COLUMNS_PROBE = `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`;
const ENUMS_PROBE = `SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid`;
function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function makePrisma(opts: { isOperator?: boolean; failCron?: boolean } = {}) {
  return {
    user: {
      findUnique: jest.fn(async () => ({ isOperator: opts.isOperator ?? true })),
    },
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      if (opts.failCron && /cron\.|net\./.test(sql)) {
        throw new Error('relation "cron.job" does not exist');
      }
      if (sql.includes('FROM cron.job_run_details')) {
        return [
          {
            jobname: 'ai-jobs-poll',
            jobid: 13,
            status: 'succeeded',
            return_message: '1 row',
            start_time: new Date('2026-09-01T10:00:00Z'),
            end_time: new Date('2026-09-01T10:00:01Z'),
          },
          // Запуск удалённой (unschedule) джобы — LEFT JOIN, jobname нет.
          { jobname: 'jobid=7', jobid: 7, status: 'failed', return_message: 'boom', start_time: null, end_time: null },
        ];
      }
      if (sql.includes('FROM cron.job')) {
        return [{ jobname: 'ai-jobs-poll', schedule: '*/3 * * * *', active: true }];
      }
      // Пункт [latest-migration-was-from-memory] 2026-09-24: заглушка
      // обязана отвечать на обе пробы каталога, иначе она БЕДНЕЕ
      // production — первая проба падала, вторая не выполнялась вовсе,
      // и тест считал запросы к несуществующему коду.
      // Заглушка не умеет исполнять SQL, и поэтому НЕ МОЖЕТ судить о его
      // смысле: `table_schema = 'pg_catalog'` или дописанное `WHERE
      // false` для подстрочного поиска выглядят так же, как правильный
      // запрос. Честная замена семантике здесь — точное сравнение: две
      // пробы каталога закреплены целиком, любое отличие считается
      // незнакомым SQL. Цена известна: правка запроса потребует правки
      // заглушки. Это лучше, чем заглушка, которая отвечает на
      // испорченный запрос так же, как на исправный.
      if (normalize(sql) === normalize(COLUMNS_PROBE)) {
        return [
          { table_name: 'users', column_name: 'updatedAt' },
          { table_name: 'projects', column_name: 'frozenAt' },
        ];
      }
      if (normalize(sql) === normalize(ENUMS_PROBE)) {
        return [{ typname: 'ProjectMode', enumlabel: 'EMPLOYER_HIRING' }];
      }
      if (sql.includes('net._http_response')) {
        return [
          { status_code: 201, content: '{"completed":1,"failed":0,"waiting":0}', timed_out: false, error_msg: null, created: new Date('2026-09-01T10:00:02Z') },
        ];
      }
      throw new Error(`unexpected sql: ${sql}`);
    }),
    aIJob: {
      findFirst: async () => null, // [idempotency]: переиспользование в этих тестах не предмет проверки
      groupBy: jest.fn(async () => [
        { status: 'COMPLETED', _count: { _all: 6 } },
        { status: 'FAILED', _count: { _all: 1 } },
      ]),
      findMany: jest.fn(async () => [
        {
          id: 'job-1',
          taskType: 'media-public-review',
          status: 'RUNNING',
          retryCount: 2,
          externalInteractionId: 'inter-1',
          leaseExpiresAt: new Date('2026-09-01T11:00:00Z'),
          partialResult: 'x'.repeat(500),
          createdAt: new Date('2026-09-01T09:00:00Z'),
          updatedAt: new Date('2026-09-01T10:00:00Z'),
        },
      ]),
    },
  };
}

describe('AdminDbStateService', () => {
  it('КЛЮЧЕВОЙ ТЕСТ (секрет): ни один SQL-запрос не выбирает колонку command — в ней x-dispatch-secret', async () => {
    const prisma = makePrisma();
    const svc = new AdminDbStateService(prisma as any);
    await svc.getState('op-1');
    // Число здесь — не формальность, а обратная проба: без него цикл
    // ниже проходит и тогда, когда запросов не стало вовсе.
    // Пункт [latest-migration-was-from-memory] 2026-09-24: 3 → 5,
    // добавлены две пробы состояния ручных миграций (колонки из
    // information_schema и значения перечислений из pg_enum — каталог
    // базы, без чтения данных пользователей).
    // Пункт [deploy-step-did-nothing] 2026-09-26: 5 → 6, добавлен список
    // таблиц из information_schema — тот же каталог базы, тоже без
    // чтения данных пользователей.
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(6);
    for (const call of prisma.$queryRawUnsafe.mock.calls) {
      // d.command / j.command / голый command — под любым алиасом.
      expect(String(call[0])).not.toMatch(/\bcommand\b/i);
    }
  });

  it('маппинг секций: cron-джобы, лог (включая удалённые джобы), pg_net, сводка ai_jobs с обрезкой заметки', async () => {
    const svc = new AdminDbStateService(makePrisma() as any);
    const state = await svc.getState('op-1');

    expect(state.cronJobs).toEqual([{ jobname: 'ai-jobs-poll', schedule: '*/3 * * * *', active: true }]);

    const runs = state.cronRuns as Array<{ jobname: string; status: string; startTime: string | null }>;
    expect(runs[0]).toMatchObject({ jobname: 'ai-jobs-poll', status: 'succeeded', startTime: '2026-09-01T10:00:00.000Z' });
    expect(runs[1]).toMatchObject({ jobname: 'jobid=7', status: 'failed', startTime: null });

    const http = state.httpResponses as Array<{ statusCode: number | null; content: string | null }>;
    expect(http[0]).toMatchObject({ statusCode: 201, content: '{"completed":1,"failed":0,"waiting":0}' });

    const aiJobs = state.aiJobs as { byStatus: Record<string, number>; recent: Array<{ submitted: boolean; note: string | null }> };
    expect(aiJobs.byStatus).toEqual({ COMPLETED: 6, FAILED: 1 });
    expect(aiJobs.recent[0].submitted).toBe(true); // externalInteractionId есть
    expect(aiJobs.recent[0].note).toHaveLength(300); // 500 символов обрезаны

    // Пункт [latest-migration-was-from-memory] 2026-09-24: три честных
    // состояния, и каждое встречается. «Не видно по схеме» — отдельное
    // состояние, а не молчаливое «применена»: иначе пробел выглядел бы
    // как полнота.
    const migrations = state.manualMigrations as Array<{ file: string; state: string; why?: string }>;
    const byFile = new Map(migrations.map((m) => [m.file, m]));
    expect(byFile.get('schema_audit_2026_08_30.sql')?.state).toBe('applied');
    expect(byFile.get('public_participant_withdraw_token_2026_09_24.sql')?.state).toBe('missing');
    expect(byFile.get('job_domain_v2_2026_09_02.sql')?.state).toBe('applied'); // проба по pg_enum
    expect(byFile.get('voice_reply_processing_2026_09_02.sql')?.state).toBe('missing'); // тоже enum, но значения нет
    const notObservable = migrations.filter((m) => m.state === 'not-observable');
    expect(notObservable.length).toBeGreaterThan(0);
    for (const m of notObservable) expect(String(m.why ?? '').length).toBeGreaterThan(20);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (изоляция): без pg_cron/pg_net их секции — { error }, а ai_jobs живая', async () => {
    const svc = new AdminDbStateService(makePrisma({ failCron: true }) as any);
    const state = await svc.getState('op-1');
    expect(state.cronJobs).toEqual({ error: 'relation "cron.job" does not exist' });
    expect(state.cronRuns).toEqual({ error: 'relation "cron.job" does not exist' });
    expect(state.httpResponses).toEqual({ error: 'relation "cron.job" does not exist' });
    expect((state.aiJobs as { byStatus: Record<string, number> }).byStatus).toEqual({ COMPLETED: 6, FAILED: 1 });
  });

  it('КЛЮЧЕВОЙ ТЕСТ [background-jobs]: инстанс с одной джобой из семи честно показывает шесть отсутствующих', async () => {
    // Фейк отдаёт ровно одну строку cron.job (ai-jobs-poll). Раньше это
    // и был весь ответ: экран рисовал одну зелёную строку «совпадает» и
    // ни слова о шести неприменённых задачах.
    const svc = new AdminDbStateService(makePrisma() as any);
    const state = await svc.getState('op-1');

    const expected = state.expectedCron as {
      jobs: Array<{ jobname: string; actualSchedule: string | null }>;
      missing: string[];
    };
    expect(expected.jobs.length).toBeGreaterThan(1);
    expect(expected.missing).toContain('dispatch-scheduled-conversation-reminders');
    expect(expected.missing).toContain('ai-jobs-submit');
    expect(expected.missing).not.toContain('ai-jobs-poll');
  });

  it('[background-jobs]: недоступная cron.job — это «не смогли посмотреть», а не «семь задач отсутствуют»', async () => {
    // Разница существенная: во втором прочтении оператор пошёл бы
    // применять файлы, которые на самом деле уже применены.
    const svc = new AdminDbStateService(makePrisma({ failCron: true }) as any);
    const state = await svc.getState('op-1');
    expect(state.expectedCron).toEqual({ error: 'relation "cron.job" does not exist' });
  });

  it('не-оператор получает Forbidden до единого запроса к служебным таблицам', async () => {
    const prisma = makePrisma({ isOperator: false });
    const svc = new AdminDbStateService(prisma as any);
    await expect(svc.getState('user-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

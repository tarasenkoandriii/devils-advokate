// Пункт [db-state] 2026-09-01 — вкладка «БД»: read-only зеркало
// pg_cron/pg_net/ai_jobs. Ключевые контракты: (1) колонка command
// НИКОГДА не запрашивается — в ней захардкожен x-dispatch-secret;
// (2) секции падают независимо — локальная БД без pg_cron отдаёт
// ошибку секции, не роняет всю вкладку; (3) операторская граница.

import { ForbiddenException } from '@nestjs/common';
import { AdminDbStateService } from '../admin-db-state/admin-db-state.service';

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
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(3);
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
  });

  it('КЛЮЧЕВОЙ ТЕСТ (изоляция): без pg_cron/pg_net их секции — { error }, а ai_jobs живая', async () => {
    const svc = new AdminDbStateService(makePrisma({ failCron: true }) as any);
    const state = await svc.getState('op-1');
    expect(state.cronJobs).toEqual({ error: 'relation "cron.job" does not exist' });
    expect(state.cronRuns).toEqual({ error: 'relation "cron.job" does not exist' });
    expect(state.httpResponses).toEqual({ error: 'relation "cron.job" does not exist' });
    expect((state.aiJobs as { byStatus: Record<string, number> }).byStatus).toEqual({ COMPLETED: 6, FAILED: 1 });
  });

  it('не-оператор получает Forbidden до единого запроса к служебным таблицам', async () => {
    const prisma = makePrisma({ isOperator: false });
    const svc = new AdminDbStateService(prisma as any);
    await expect(svc.getState('user-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

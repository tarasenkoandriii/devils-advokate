import { ForbiddenException } from '@nestjs/common';
import { TelemetryService } from '../telemetry/telemetry.service';

function createFakePrisma() {
  const users = new Map<string, any>();
  const jobs: any[] = [];
  const modelVersions = new Map<string, any>();
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedUser(u: any) {
      users.set(u.id, { isOperator: false, ...u });
    },
    _seedModelVersion(v: any) {
      modelVersions.set(v.id, v);
    },
    _seedJob(j: any) {
      const job = {
        id: nextId(),
        status: 'COMPLETED',
        retryCount: 0,
        schemaValidation: 'PASS',
        inputScanStatus: 'PASSED',
        taskType: null,
        promptVersionId: null,
        createdAt: new Date(),
        completedAt: null,
        modelVersionId: 'mv-1',
        ...j,
      };
      jobs.push(job);
      return job;
    },

    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
    },
    aIJob: {
      findMany: async ({ where, orderBy, take }: any) => {
        let rows = [...jobs];
        if (where?.taskType !== undefined) rows = rows.filter((j) => j.taskType === where.taskType);
        if (where?.status !== undefined) rows = rows.filter((j) => j.status === where.status);
        if (where?.createdAt?.gte) rows = rows.filter((j) => j.createdAt.getTime() >= where.createdAt.gte.getTime());
        if (where?.createdAt?.lte) rows = rows.filter((j) => j.createdAt.getTime() <= where.createdAt.lte.getTime());
        if (orderBy?.createdAt === 'desc') rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (take) rows = rows.slice(0, take);
        return rows;
      },
    },
    aIModelVersion: {
      findMany: async ({ where }: any) => {
        const ids: string[] = where.id.in;
        return ids.map((id) => modelVersions.get(id)).filter(Boolean);
      },
    },
  };
}

function makeService(prisma: any) {
  return new TelemetryService(prisma as any);
}

describe('TelemetryService', () => {
  it('отклоняет операции для пользователя без isOperator', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', isOperator: false });
    const service = makeService(prisma);

    await expect(service.getSummary('u1')).rejects.toThrow(ForbiddenException);
  });

  it('acceptance-тест §5.1: 12 вызовов material-chat (10 COMPLETED, 2 FAILED) — сводка считает totalCalls и byStatus точно', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const now = new Date();
    for (let i = 0; i < 10; i++) {
      prisma._seedJob({ taskType: 'material-chat', status: 'COMPLETED', createdAt: now, completedAt: now });
    }
    for (let i = 0; i < 2; i++) {
      prisma._seedJob({ taskType: 'material-chat', status: 'FAILED', createdAt: now });
    }
    const service = makeService(prisma);

    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 1000).toISOString();
    const rows = await service.getSummary('op1', from, to);

    const row = rows.find((r) => r.taskType === 'material-chat');
    expect(row).toBeDefined();
    expect(row!.totalCalls).toBe(12);
    expect(row!.byStatus).toEqual({ COMPLETED: 10, FAILED: 2, TIMEOUT: 0, CANCELLED: 0 });
  });

  it('acceptance-тест §5.2: исторические job без taskType дают отдельную строку taskType=null, не пропадают и не приписываются случайной фиче', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    prisma._seedJob({ taskType: null, status: 'COMPLETED', completedAt: new Date() });
    prisma._seedJob({ taskType: 'material-chat', status: 'COMPLETED', completedAt: new Date() });
    const service = makeService(prisma);

    const rows = await service.getSummary('op1');

    const nullRow = rows.find((r) => r.taskType === null);
    expect(nullRow).toBeDefined();
    expect(nullRow!.totalCalls).toBe(1);
    expect(rows.length).toBe(2);
  });

  it('acceptance-тест §5.3: retryRate считается точным булевым условием retryCount > 0, не приближённо', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    prisma._seedJob({ taskType: 'x', retryCount: 2, status: 'COMPLETED', completedAt: new Date() });
    prisma._seedJob({ taskType: 'x', retryCount: 0, status: 'COMPLETED', completedAt: new Date() });
    prisma._seedJob({ taskType: 'x', retryCount: 0, status: 'COMPLETED', completedAt: new Date() });
    prisma._seedJob({ taskType: 'x', retryCount: 0, status: 'COMPLETED', completedAt: new Date() });
    const service = makeService(prisma);

    const rows = await service.getSummary('op1');
    const row = rows.find((r) => r.taskType === 'x');

    expect(row!.retryRate).toBeCloseTo(1 / 4, 5);
  });

  it('acceptance-тест §5.4: ни один job ещё не завершился — avgDurationMs/p95DurationMs честно null, не 0', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    prisma._seedJob({ taskType: 'y', status: 'QUEUED', completedAt: null });
    prisma._seedJob({ taskType: 'y', status: 'RUNNING', completedAt: null });
    const service = makeService(prisma);

    const rows = await service.getSummary('op1');
    const row = rows.find((r) => r.taskType === 'y');

    expect(row!.totalCalls).toBe(2);
    expect(row!.avgDurationMs).toBeNull();
    expect(row!.p95DurationMs).toBeNull();
  });

  it('acceptance-тест §5.5: GET tasks/material-chat?status=FAILED&limit=50 с 3 проваленными job в БД возвращает ровно 3, не дополняет другими статусами', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    prisma._seedModelVersion({ id: 'mv-1', version: 'claude-sonnet-5' });
    for (let i = 0; i < 3; i++) {
      prisma._seedJob({ taskType: 'material-chat', status: 'FAILED' });
    }
    for (let i = 0; i < 5; i++) {
      prisma._seedJob({ taskType: 'material-chat', status: 'COMPLETED', completedAt: new Date() });
    }
    const service = makeService(prisma);

    const details = await service.getTaskDetail('op1', 'material-chat', 50, 'FAILED');

    expect(details.length).toBe(3);
    expect(details.every((d) => d.status === 'FAILED')).toBe(true);
    expect(details[0].modelVersion).toBe('claude-sonnet-5');
  });

  it('avgDurationMs/p95DurationMs считаются только по job с заполненным completedAt, даже если часть job в выборке ещё не завершена', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    prisma._seedJob({
      taskType: 'z',
      status: 'COMPLETED',
      createdAt: new Date(base),
      completedAt: new Date(base + 1000),
    });
    prisma._seedJob({
      taskType: 'z',
      status: 'COMPLETED',
      createdAt: new Date(base),
      completedAt: new Date(base + 3000),
    });
    prisma._seedJob({ taskType: 'z', status: 'RUNNING', createdAt: new Date(base), completedAt: null });
    const service = makeService(prisma);

    const rows = await service.getSummary('op1');
    const row = rows.find((r) => r.taskType === 'z');

    expect(row!.avgDurationMs).toBeCloseTo(2000, 5);
  });

  it('getByModel группирует тот же агрегат по modelVersion вместо taskType', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    prisma._seedModelVersion({ id: 'mv-gpt', version: 'gpt-4.1' });
    prisma._seedModelVersion({ id: 'mv-claude', version: 'claude-sonnet-5' });
    prisma._seedJob({ modelVersionId: 'mv-gpt', status: 'FAILED' });
    prisma._seedJob({ modelVersionId: 'mv-gpt', status: 'FAILED' });
    prisma._seedJob({ modelVersionId: 'mv-claude', status: 'COMPLETED', completedAt: new Date() });
    const service = makeService(prisma);

    const rows = await service.getByModel('op1');

    const gptRow = rows.find((r) => r.modelVersion === 'gpt-4.1');
    const claudeRow = rows.find((r) => r.modelVersion === 'claude-sonnet-5');
    expect(gptRow!.totalCalls).toBe(2);
    expect(gptRow!.byStatus.FAILED).toBe(2);
    expect(claudeRow!.totalCalls).toBe(1);
  });

  it('inputBlockedCount считает вызовы, заблокированные на входе, как абсолютное число, не долю', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    prisma._seedJob({ taskType: 'w', inputScanStatus: 'BLOCKED', status: 'FAILED' });
    prisma._seedJob({ taskType: 'w', inputScanStatus: 'PASSED', status: 'COMPLETED', completedAt: new Date() });
    prisma._seedJob({ taskType: 'w', inputScanStatus: 'PASSED', status: 'COMPLETED', completedAt: new Date() });
    const service = makeService(prisma);

    const rows = await service.getSummary('op1');
    const row = rows.find((r) => r.taskType === 'w');

    expect(row!.inputBlockedCount).toBe(1);
  });
});

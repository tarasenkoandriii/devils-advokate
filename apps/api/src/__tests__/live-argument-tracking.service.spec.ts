import { LiveArgumentTrackingService } from '../live-argument-tracking/live-argument-tracking.service';
import { BadRequestException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const argumentsList: any[] = [];
  const trackingStatuses: any[] = [];
  const manipulationFlags: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedArgument(a: any) { argumentsList.push({ id: a.id ?? nextId(), targetPersonId: null, ...a }); },
    _seedTrackingStatus(s: any) { trackingStatuses.push({ id: nextId(), lastCheckedAt: new Date(), ...s }); },
    _seedManipulationFlag(f: any) { manipulationFlags.push({ id: nextId(), createdAt: new Date(), ...f }); },
    _getTrackingStatuses() { return trackingStatuses; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    argument: {
      findMany: async ({ where }: any) => argumentsList.filter((a) => a.projectId === where.projectId),
    },
    liveArgumentTrackingStatus: {
      findUnique: async ({ where }: any) => trackingStatuses.find((s) => s.argumentId === where.argumentId) ?? null,
      create: async ({ data }: any) => {
        const s = { id: nextId(), lastCheckedAt: new Date(), ...data };
        trackingStatuses.push(s);
        return s;
      },
      findMany: async ({ where, include }: any) =>
        trackingStatuses
          .filter((s) => s.projectId === where.projectId)
          .map((s) => (include?.argument ? { ...s, argument: argumentsList.find((a) => a.id === s.argumentId) } : s))
          .sort((a, b) => b.lastCheckedAt - a.lastCheckedAt),
      update: async ({ where, data }: any) => {
        const idx = trackingStatuses.findIndex((s) => s.argumentId === where.argumentId);
        trackingStatuses[idx] = { ...trackingStatuses[idx], ...data };
        return trackingStatuses[idx];
      },
    },
    liveManipulationFlag: {
      findFirst: async ({ where }: any) =>
        manipulationFlags.find((f) => f.projectId === where.projectId && f.createdAt >= where.createdAt.gte) ?? null,
    },
    promptVersion: {
      findFirst: async () => null,
    },
  };
}

class FakeAIRouterService {
  responseText = '[]';
  lastRequest: any = null;

  async execute(request: any) {
    this.lastRequest = request;
    if (request.validateOutput && !request.validateOutput(this.responseText)) {
      throw new Error('validation failed in fake router');
    }
    return { aiInferenceId: 'inference-1', jobId: 'job-1', text: this.responseText };
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

async function assertThrowsAsync(fn: () => Promise<unknown>, expectedType: any, message: string) {
  try {
    await fn();
    throw new Error(`FAIL: ${message} — expected to throw ${expectedType.name}, did not throw`);
  } catch (err: any) {
    if (!(err instanceof expectedType)) {
      throw new Error(`FAIL: ${message} — expected ${expectedType.name}, got ${err?.constructor?.name}: ${err?.message}`);
    }
  }
}

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';
const ARG_ID = 'arg-1';

function seedProject(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('initialize() создаёт записи трекинга со стартовым статусом NOT_MENTIONED', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ id: ARG_ID, projectId: PROJECT_ID, text: 'x', stance: 'PRO' });
    const svc = new LiveArgumentTrackingService(prisma as any, new FakeAIRouterService() as any);

    const list = await svc.initialize(USER_ID, PROJECT_ID);
    assertEqual(list.length, 1, 'одна запись трекинга создана');
    assertEqual(list[0].status, 'NOT_MENTIONED', 'стартовый статус корректный');
  });

  test('initialize() НЕ создаёт дубликат, если статус уже существует', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ id: ARG_ID, projectId: PROJECT_ID, text: 'x', stance: 'PRO' });
    prisma._seedTrackingStatus({ projectId: PROJECT_ID, argumentId: ARG_ID, status: 'NEEDS_REPEAT' });
    const svc = new LiveArgumentTrackingService(prisma as any, new FakeAIRouterService() as any);

    await svc.initialize(USER_ID, PROJECT_ID);
    assertEqual(prisma._getTrackingStatuses().length, 1, 'не создан дубликат');
    assertEqual(prisma._getTrackingStatuses()[0].status, 'NEEDS_REPEAT', 'существующий статус не сброшен инициализацией');
  });

  test('checkStatus() бросает BadRequestException, если список отслеживания пуст', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new LiveArgumentTrackingService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.checkStatus(USER_ID, PROJECT_ID, 'x'), BadRequestException, 'checkStatus() без initialize()');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: checkStatus() честно игнорирует попытку AI ПОНИЗИТЬ статус, не откатывает', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ id: ARG_ID, projectId: PROJECT_ID, text: 'x', stance: 'PRO' });
    prisma._seedTrackingStatus({ projectId: PROJECT_ID, argumentId: ARG_ID, status: 'SUFFICIENTLY_MENTIONED' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = `[{"argumentId":"${ARG_ID}","status":"NOT_MENTIONED"}]`; // AI пытается понизить
    const svc = new LiveArgumentTrackingService(prisma as any, fakeRouter as any);

    const updated = await svc.checkStatus(USER_ID, PROJECT_ID, 'x');
    assertEqual(updated.length, 0, 'попытка понижения честно проигнорирована, не применена');
    const current = prisma._getTrackingStatuses().find((s: any) => s.argumentId === ARG_ID);
    assertEqual(current.status, 'SUFFICIENTLY_MENTIONED', 'статус остался прежним, не откатился назад');
  });

  test('checkStatus() применяет реальное повышение статуса', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ id: ARG_ID, projectId: PROJECT_ID, text: 'x', stance: 'PRO' });
    prisma._seedTrackingStatus({ projectId: PROJECT_ID, argumentId: ARG_ID, status: 'NOT_MENTIONED' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = `[{"argumentId":"${ARG_ID}","status":"NEEDS_REPEAT"}]`;
    const svc = new LiveArgumentTrackingService(prisma as any, fakeRouter as any);

    const updated = await svc.checkStatus(USER_ID, PROJECT_ID, 'x');
    assertEqual(updated.length, 1, 'реальное повышение применено');
    assertEqual(updated[0].status, 'NEEDS_REPEAT', 'новый статус сохранён');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: checkStatus() понижает GENUINELY_ACCEPTED до SUFFICIENTLY_MENTIONED при недавней уловке', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ id: ARG_ID, projectId: PROJECT_ID, text: 'x', stance: 'PRO' });
    prisma._seedTrackingStatus({ projectId: PROJECT_ID, argumentId: ARG_ID, status: 'NEEDS_REPEAT' });
    prisma._seedManipulationFlag({ projectId: PROJECT_ID, technique: 'ложная дилемма', description: 'x' }); // недавняя, createdAt=now по умолчанию
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = `[{"argumentId":"${ARG_ID}","status":"GENUINELY_ACCEPTED"}]`;
    const svc = new LiveArgumentTrackingService(prisma as any, fakeRouter as any);

    const updated = await svc.checkStatus(USER_ID, PROJECT_ID, 'x');
    assertEqual(updated[0].status, 'SUFFICIENTLY_MENTIONED', '"согласие" рядом с уловкой честно НЕ подсвечено зелёным, buкально ТЗ');
  });

  test('checkStatus() позволяет GENUINELY_ACCEPTED без недавней уловки', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ id: ARG_ID, projectId: PROJECT_ID, text: 'x', stance: 'PRO' });
    prisma._seedTrackingStatus({ projectId: PROJECT_ID, argumentId: ARG_ID, status: 'NEEDS_REPEAT' });
    // Уловок не заведено вообще.
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = `[{"argumentId":"${ARG_ID}","status":"GENUINELY_ACCEPTED"}]`;
    const svc = new LiveArgumentTrackingService(prisma as any, fakeRouter as any);

    const updated = await svc.checkStatus(USER_ID, PROJECT_ID, 'x');
    assertEqual(updated[0].status, 'GENUINELY_ACCEPTED', 'без недавней уловки честное согласие принимается как есть');
  });

  test('checkStatus() честно игнорирует argumentId от AI, которого нет в отслеживаемых', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ id: ARG_ID, projectId: PROJECT_ID, text: 'x', stance: 'PRO' });
    prisma._seedTrackingStatus({ projectId: PROJECT_ID, argumentId: ARG_ID, status: 'NOT_MENTIONED' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = `[{"argumentId":"nonexistent-arg","status":"GENUINELY_ACCEPTED"}]`;
    const svc = new LiveArgumentTrackingService(prisma as any, fakeRouter as any);

    const updated = await svc.checkStatus(USER_ID, PROJECT_ID, 'x');
    assertEqual(updated.length, 0, 'несуществующий argumentId честно проигнорирован, не создана мусорная запись');
  });

  test('checkStatus() не создаёт лишний update, если статус фактически не изменился', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ id: ARG_ID, projectId: PROJECT_ID, text: 'x', stance: 'PRO' });
    prisma._seedTrackingStatus({ projectId: PROJECT_ID, argumentId: ARG_ID, status: 'NEEDS_REPEAT' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = `[{"argumentId":"${ARG_ID}","status":"NEEDS_REPEAT"}]`; // тот же статус
    const svc = new LiveArgumentTrackingService(prisma as any, fakeRouter as any);

    const updated = await svc.checkStatus(USER_ID, PROJECT_ID, 'x');
    assertEqual(updated.length, 0, 'нет реального изменения — не считается обновлением');
  });

  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  const failed = results.filter((r) => r.error);
  console.log(`\nLiveArgumentTrackingService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  // Падение вне тела теста (в фейке, в модульном коде) — это
  // провал файла, а не тихий unhandled rejection.
  console.error(err);
  process.exit(1);
});

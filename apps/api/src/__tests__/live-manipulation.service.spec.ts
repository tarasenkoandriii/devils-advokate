import { LiveManipulationService } from '../live-manipulation/live-manipulation.service';
import { BadGatewayException, BadRequestException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const flags: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _getFlags() { return flags; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    liveManipulationFlag: {
      create: async ({ data }: any) => {
        const f = { id: nextId(), createdAt: new Date(), ...data };
        flags.push(f);
        return f;
      },
      findMany: async ({ where }: any) => flags.filter((f) => f.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt),
    },
    promptVersion: {
      findFirst: async () => null,
    },
  };
}

class FakeAIRouterService {
  responseText = '[]';
  aiInferenceId = 'inference-1';
  lastRequest: any = null;

  async execute(request: any) {
    this.lastRequest = request;
    if (request.validateOutput && !request.validateOutput(this.responseText)) {
      throw new Error('validation failed in fake router');
    }
    return { aiInferenceId: this.aiInferenceId, jobId: 'job-1', text: this.responseText };
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

function seedProject(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('analyze() бросает BadRequestException для пустого transcriptWindow', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new LiveManipulationService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.analyze(USER_ID, PROJECT_ID, '   '), BadRequestException, 'analyze() с пустым транскриптом');
  });

  test('analyze() возвращает пустой массив, если AI не нашёл манипуляций — честно, не подделывает', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '[]';
    const svc = new LiveManipulationService(prisma as any, fakeRouter as any);

    const result = await svc.analyze(USER_ID, PROJECT_ID, 'Обычный нейтральный разговор');
    assertEqual(result, [], 'честный пустой массив, не выдуманная манипуляция');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: analyze() создаёт НЕСКОЛЬКО флагов за один цикл, не сжимает до одного', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { technique: 'переход на личности', description: 'Первая манипулятивная реплика', confidence: 0.7 },
      { technique: 'ложная дилемма', description: 'Вторая манипулятивная реплика в том же окне', confidence: 0.6 },
    ]);
    const svc = new LiveManipulationService(prisma as any, fakeRouter as any);

    const created = await svc.analyze(USER_ID, PROJECT_ID, 'x');
    assertEqual(created.length, 2, 'оба флага сохранены — в отличие от LiveHintEvent, здесь не действует ограничение "максимум один"');
  });

  test('analyze() сохраняет technique/description/confidence корректно', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '[{"technique":"whataboutism","description":"А вот ты сам...","confidence":0.55}]';
    const svc = new LiveManipulationService(prisma as any, fakeRouter as any);

    const created = await svc.analyze(USER_ID, PROJECT_ID, 'x');
    assertEqual(created[0].technique, 'whataboutism', 'приём сохранён');
    assertEqual(created[0].confidence, 0.55, 'уверенность сохранена как честное, не завышенное число');
  });

  test('analyze() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new LiveManipulationService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.analyze(USER_ID, PROJECT_ID, 'x'), BadGatewayException, 'analyze() при недоступности провайдера');
  });

  test('list() возвращает флаги проекта, самые новые первыми', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '[{"technique":"x","description":"y"}]';
    const svc = new LiveManipulationService(prisma as any, fakeRouter as any);

    await svc.analyze(USER_ID, PROJECT_ID, 'первый цикл');
    await svc.analyze(USER_ID, PROJECT_ID, 'второй цикл');

    const list = await svc.list(USER_ID, PROJECT_ID);
    assertEqual(list.length, 2, 'оба флага видны');
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
  console.log(`\nLiveManipulationService: ${results.length - failed.length}/${results.length} passed\n`);
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

import { MissingInformationService } from '../missing-information/missing-information.service';
import { NotFoundException, BadGatewayException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const objectives = new Map<string, any>();
  const checks: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedObjective(o: any) { objectives.set(o.projectId, o); },
    _getChecks() { return checks; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    decisionObjective: {
      findUnique: async ({ where }: any) => objectives.get(where.projectId) ?? null,
    },
    promptVersion: {
      findFirst: async () => null, // используем DEFAULT_SYSTEM_PROMPT — тот же паттерн, что steelman/turning-points
    },
    missingInformationCheck: {
      create: async ({ data }: any) => {
        const c = { id: nextId(), createdAt: new Date(), ...data };
        checks.push(c);
        return c;
      },
      findFirst: async ({ where, orderBy }: any) => {
        const matching = checks.filter((c) => c.projectId === where.projectId);
        if (matching.length === 0) return null;
        if (orderBy?.createdAt === 'desc') {
          return matching.reduce((latest, c) => (c.createdAt > latest.createdAt ? c : latest));
        }
        return matching[0];
      },
    },
  };
}

class FakeAIRouterService {
  responseText = '[]';
  aiInferenceId = 'inference-1';
  shouldThrow: Error | null = null;

  async execute(request: any) {
    if (this.shouldThrow) throw this.shouldThrow;
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

function assertThrowsAsync(fn: () => Promise<unknown>, expectedType: any, message: string) {
  return fn().then(
    () => { throw new Error(`FAIL: ${message} — expected to throw ${expectedType.name}, did not throw`); },
    (err) => {
      if (!(err instanceof expectedType)) {
        throw new Error(`FAIL: ${message} — expected ${expectedType.name}, got ${err?.constructor?.name}: ${err?.message}`);
      }
    },
  );
}

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('detect() создаёт MissingInformationCheck со списком вопросов из ответа AI', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Просить повышение?', goal: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify(['Кто принимает решение?', 'Что если откажут?']);
    const svc = new MissingInformationService(prisma as any, fakeRouter as any);

    const check = await svc.detect(USER_ID, PROJECT_ID);
    assertEqual(check.questions, ['Кто принимает решение?', 'Что если откажут?'], 'список вопросов сохранён');
    assertEqual(check.generatedByInferenceId, 'inference-1', 'provenance сохранён');
  });

  test('detect() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user', question: 'x', goal: null });
    const svc = new MissingInformationService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.detect(USER_ID, PROJECT_ID),
      NotFoundException,
      'detect() на чужой проект',
    );
  });

  test('detect() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.shouldThrow = new Error('provider unreachable');
    const svc = new MissingInformationService(prisma as any, fakeRouter as any);
    await assertThrowsAsync(
      () => svc.detect(USER_ID, PROJECT_ID),
      BadGatewayException,
      'detect() при недоступном провайдере',
    );
  });

  test('detect() может вернуть пустой список вопросов, если данных достаточно', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '[]';
    const svc = new MissingInformationService(prisma as any, fakeRouter as any);
    const check = await svc.detect(USER_ID, PROJECT_ID);
    assertEqual(check.questions, [], 'пустой список — не ошибка, а валидный результат');
  });

  test('getLatest() возвращает самую свежую проверку, не первую созданную', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    const svc = new MissingInformationService(prisma as any, fakeRouter as any);

    fakeRouter.responseText = JSON.stringify(['Старый вопрос']);
    await svc.detect(USER_ID, PROJECT_ID);
    await new Promise((r) => setTimeout(r, 5)); // гарантируем разный createdAt
    fakeRouter.responseText = JSON.stringify(['Новый вопрос']);
    await svc.detect(USER_ID, PROJECT_ID);

    const latest = await svc.getLatest(USER_ID, PROJECT_ID);
    assertEqual(latest?.questions, ['Новый вопрос'], 'возвращена именно последняя по времени проверка');
    assertEqual(prisma._getChecks().length, 2, 'старая проверка не удалена и не перезаписана, а сохранена рядом');
  });

  test('getLatest() возвращает null, если проверок ещё не было', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const svc = new MissingInformationService(prisma as any, new FakeAIRouterService() as any);
    const latest = await svc.getLatest(USER_ID, PROJECT_ID);
    assertEqual(latest, null, 'null при отсутствии проверок');
  });

  test('getLatest() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user', question: 'x', goal: null });
    const svc = new MissingInformationService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.getLatest(USER_ID, PROJECT_ID),
      NotFoundException,
      'getLatest() на чужой проект',
    );
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
  console.log(`\nMissingInformationService: ${results.length - failed.length}/${results.length} passed\n`);
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

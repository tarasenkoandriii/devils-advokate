import { ReconciliationArgumentsService } from '../reconciliation-arguments/reconciliation-arguments.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const users = new Map<string, any>();
  const argumentsStore: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedUser(u: any) { users.set(u.id, u); },
    _getArguments() { return argumentsStore; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    user: {
      findUniqueOrThrow: async ({ where }: any) => {
        const u = users.get(where.id);
        if (!u) throw new Error('not found');
        return u;
      },
    },
    promptVersion: {
      findFirst: async () => null,
    },
    argument: {
      create: async ({ data }: any) => {
        const a = { id: nextId(), createdAt: new Date(), ...data };
        argumentsStore.push(a);
        return a;
      },
      findMany: async ({ where }: any) =>
        argumentsStore.filter((a) => a.projectId === where.projectId && a.stance === where.stance).sort((a, b) => b.createdAt - a.createdAt),
    },
    $transaction: async (ops: Promise<any>[]) => Promise.all(ops),
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

function seedProject(prisma: ReturnType<typeof createFakePrisma>, religion: string | null) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Поссорился с братом из-за наследства', goal: null });
  prisma._seedUser({ id: USER_ID, religion });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('generate() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user', question: 'x', goal: null });
    const svc = new ReconciliationArgumentsService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, PROJECT_ID), NotFoundException, 'generate() на чужой проект');
  });

  test('generate() бросает BadRequestException, если религия не указана ("не указывать")', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, null);
    const svc = new ReconciliationArgumentsService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, PROJECT_ID), BadRequestException, 'generate() без указанной религии');
  });

  test('generate() подмешивает ситуацию и традицию пользователя в промпт', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, 'Христианство (православие)');
    const fakeRouter = new FakeAIRouterService();
    const svc = new ReconciliationArgumentsService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Поссорился с братом из-за наследства'), true, 'ситуация попала в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Христианство (православие)'), true, 'традиция попала в промпт');
  });

  test('generate() системный промпт явно требует короткие цитаты и запрет морального суда над оппонентом', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, 'Ислам');
    const fakeRouter = new FakeAIRouterService();
    const svc = new ReconciliationArgumentsService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.systemPrompt.includes('15 слов'), true, 'ограничение на длину цитаты явно в промпте');
    assertEqual(fakeRouter.lastRequest.systemPrompt.includes('моральн'), true, 'запрет морального суда явно в промпте');
  });

  test('generate() создаёт Argument со stance=RECONCILIATION и scriptureReference', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, 'Христианство');
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { scriptureReference: 'Матфея 18:21-22', text: 'Учит прощать не ограниченное число раз — применимо к затянувшемуся спору с братом.' },
    ]);
    const svc = new ReconciliationArgumentsService(prisma as any, fakeRouter as any);

    const created = await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(created.length, 1, 'один аргумент создан');
    assertEqual(created[0].stance, 'RECONCILIATION', 'stance корректный');
    assertEqual(created[0].scriptureReference, 'Матфея 18:21-22', 'ссылка на первоисточник сохранена отдельным полем');
    assertEqual(created[0].targetPersonId, undefined, 'не адресован конкретному стейкхолдеру');
  });

  test('generate() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, 'Иудаизм');
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new ReconciliationArgumentsService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, PROJECT_ID), BadGatewayException, 'generate() при недоступности провайдера');
  });

  test('list() возвращает только RECONCILIATION-аргументы, не смешивает с обычными за/против', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, 'Буддизм');
    prisma._getArguments().push({ id: 'other-1', projectId: PROJECT_ID, stance: 'PRO', text: 'x', createdAt: new Date() });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([{ scriptureReference: 'x', text: 'y' }]);
    const svc = new ReconciliationArgumentsService(prisma as any, fakeRouter as any);
    await svc.generate(USER_ID, PROJECT_ID);

    const list = await svc.list(USER_ID, PROJECT_ID);
    assertEqual(list.length, 1, 'только RECONCILIATION-аргумент, обычный PRO не попал в список');
  });

  test('list() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new ReconciliationArgumentsService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.list(USER_ID, PROJECT_ID), NotFoundException, 'list() на чужой проект');
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
  console.log(`\nReconciliationArgumentsService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

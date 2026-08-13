import { ProtocolService } from '../protocol/protocol.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const commitments: any[] = [];
  const objectives = new Map<string, any>();
  const conversations: any[] = [];
  const protocols: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedCommitment(c: any) { commitments.push(c); },
    _seedObjective(o: any) { objectives.set(o.projectId, o); },
    _seedConversation(c: any) { conversations.push(c); },
    _getProtocols() { return protocols; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    commitment: {
      findMany: async ({ where }: any) => commitments.filter((c) => c.projectId === where.projectId),
    },
    decisionObjective: {
      findUnique: async ({ where }: any) => objectives.get(where.projectId) ?? null,
    },
    conversation: {
      findFirst: async ({ where }: any) => {
        const list = conversations.filter((c) => c.projectId === where.projectId);
        if (list.length === 0) return null;
        return [...list].sort((a, b) => b.occurredAt - a.occurredAt)[0];
      },
    },
    promptVersion: {
      findFirst: async () => null,
    },
    protocol: {
      create: async ({ data }: any) => {
        const p = { id: nextId(), createdAt: new Date(), ...data };
        protocols.push(p);
        return p;
      },
      findMany: async ({ where }: any) => protocols.filter((p) => p.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt),
    },
  };
}

class FakeAIRouterService {
  responseText = '{"summaryText":"Итоговый протокол"}';
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
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Раздел имущества при переезде' });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('generate() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new ProtocolService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, PROJECT_ID), NotFoundException, 'generate() на чужой проект');
  });

  test('generate() бросает BadRequestException, если нет ни обязательств, ни желаемого исхода', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new ProtocolService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, PROJECT_ID), BadRequestException, 'generate() без данных для протокола');
  });

  test('generate() подмешивает обязательства (кто/что/срок) в промпт', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedCommitment({
      projectId: PROJECT_ID,
      owner: 'USER',
      description: 'Забрать мебель до конца месяца',
      dueDate: new Date('2026-01-31'),
      person: { displayName: 'Бывший сосед' },
    });
    const fakeRouter = new FakeAIRouterService();
    const svc = new ProtocolService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Забрать мебель до конца месяца'), true, 'описание обязательства попало в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('2026-01-31'), true, 'срок попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('пользователь'), true, 'владелец обязательства (USER) переведён в читаемый текст');
  });

  test('generate() подмешивает желаемый исход из DecisionObjective', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedObjective({ projectId: PROJECT_ID, desiredOutcome: 'Разъехаться без судебных тяжб' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new ProtocolService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Разъехаться без судебных тяжб'), true, 'желаемый исход попал в промпт');
  });

  test('generate() подмешивает фрагмент последнего разговора, если он есть', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedObjective({ projectId: PROJECT_ID, desiredOutcome: 'x' });
    prisma._seedConversation({
      id: 'conv-1',
      projectId: PROJECT_ID,
      occurredAt: new Date('2026-01-01'),
      transcript: { segments: [{ text: 'Договорились, что диван остаётся у меня' }] },
    });
    const fakeRouter = new FakeAIRouterService();
    const svc = new ProtocolService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Договорились, что диван остаётся у меня'), true, 'фрагмент разговора попал в промпт');
  });

  test('generate() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedObjective({ projectId: PROJECT_ID, desiredOutcome: 'x' });
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new ProtocolService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, PROJECT_ID), BadGatewayException, 'generate() при недоступности провайдера');
  });

  test('generate() создаёт запись Protocol с текстом от AI', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedObjective({ projectId: PROJECT_ID, desiredOutcome: 'x' });
    const svc = new ProtocolService(prisma as any, new FakeAIRouterService() as any);

    const protocol = await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(protocol.summaryText, 'Итоговый протокол', 'текст протокола сохранён');
  });

  test('list() возвращает протоколы проекта, самые новые первыми', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedObjective({ projectId: PROJECT_ID, desiredOutcome: 'x' });
    const svc = new ProtocolService(prisma as any, new FakeAIRouterService() as any);
    await svc.generate(USER_ID, PROJECT_ID);
    await svc.generate(USER_ID, PROJECT_ID);

    const list = await svc.list(USER_ID, PROJECT_ID);
    assertEqual(list.length, 2, 'оба протокола видны');
  });

  test('list() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new ProtocolService(prisma as any, new FakeAIRouterService() as any);
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
  console.log(`\nProtocolService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

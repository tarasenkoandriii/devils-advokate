import { ClosingMessageService } from '../closing-message/closing-message.service';
import { BadGatewayException, BadRequestException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const users = new Map<string, any>();
  const outcomes = new Map<string, any>();
  const argumentsList: any[] = [];
  const closingMessages: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedUser(u: any) { users.set(u.id, { religion: null, ...u }); },
    _seedOutcome(o: any) { outcomes.set(o.projectId, o); },
    _seedArgument(a: any) { argumentsList.push({ id: a.id ?? nextId(), targetPersonId: null, ...a }); },
    _getClosingMessages() { return closingMessages; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    user: {
      findUniqueOrThrow: async ({ where }: any) => users.get(where.id),
    },
    decisionOutcome: {
      findUnique: async ({ where }: any) => outcomes.get(where.projectId) ?? null,
    },
    argument: {
      findMany: async ({ where }: any) => argumentsList.filter((a) => a.projectId === where.projectId && a.lifecycleStatus === where.lifecycleStatus),
    },
    promptVersion: {
      findFirst: async () => null,
    },
    closingMessage: {
      create: async ({ data }: any) => {
        const m = { id: nextId(), createdAt: new Date(), ...data };
        closingMessages.push(m);
        return m;
      },
      findMany: async ({ where }: any) => closingMessages.filter((m) => m.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt),
    },
  };
}

class FakeAIRouterService {
  responseText = '{"summaryText":"Цель достигнута — вы удержали разговор в спокойном русле"}';
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

function seedProject(prisma: ReturnType<typeof createFakePrisma>, religion: string | null = null) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Переговоры о повышении зарплаты' });
  prisma._seedUser({ id: USER_ID, religion });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('КЛЮЧЕВОЙ ТЕСТ: generate() бросает BadRequestException без зафиксированного исхода — не гадает', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new ClosingMessageService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, PROJECT_ID), BadRequestException, 'generate() без DecisionOutcome');
  });

  test('generate() подмешивает зафиксированный исход и заметки в промпт', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedOutcome({ projectId: PROJECT_ID, actualOutcome: 'WENT_POORLY', outcomeNotes: 'оппонент не согласился на условия', predictedLean: null });
    const fakeRouter = new FakeAIRouterService();
    const svc = new ClosingMessageService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('WENT_POORLY'), true, 'исход попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('оппонент не согласился на условия'), true, 'заметки попали в промпт');
  });

  test('generate() подмешивает отклонённые аргументы для честного объяснения причины', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedOutcome({ projectId: PROJECT_ID, actualOutcome: 'WENT_POORLY', predictedLean: null });
    prisma._seedArgument({ projectId: PROJECT_ID, text: 'Аргумент про рыночную зарплату', lifecycleStatus: 'REJECTED' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new ClosingMessageService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Аргумент про рыночную зарплату'), true, 'отклонённый аргумент попал в промпт для честного объяснения причины');
  });

  test('generate() НЕ запрашивает цитату в системном промпте без указанного вероисповедания', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, null);
    prisma._seedOutcome({ projectId: PROJECT_ID, actualOutcome: 'WENT_WELL', predictedLean: null });
    const fakeRouter = new FakeAIRouterService();
    const svc = new ClosingMessageService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.systemPrompt.includes('quoteText'), false, 'без вероисповедания системный промпт не просит цитату вообще');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: generate() честно отбрасывает цитату от AI, если вероисповедание не указано, даже если AI её вернул', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, null); // явно НЕ указано
    prisma._seedOutcome({ projectId: PROJECT_ID, actualOutcome: 'WENT_WELL', predictedLean: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '{"summaryText":"Отлично","quoteText":"случайно вставленная цитата","quoteSourceReference":"Некий источник"}';
    const svc = new ClosingMessageService(prisma as any, fakeRouter as any);

    const message = await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(message.quoteText, null, 'цитата НЕ персистится, если пользователь не давал согласия — не полагается только на промпт');
    assertEqual(message.quoteSourceReference, null, 'ссылка на источник тоже honestly null');
  });

  test('generate() сохраняет цитату, когда вероисповедание указано и AI вернул оба поля', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, 'Христианство');
    prisma._seedOutcome({ projectId: PROJECT_ID, actualOutcome: 'WENT_WELL', predictedLean: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '{"summaryText":"Отлично","quoteText":"Радуйтесь с радующимися","quoteSourceReference":"Рим. 12:15"}';
    const svc = new ClosingMessageService(prisma as any, fakeRouter as any);

    const message = await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(message.quoteText, 'Радуйтесь с радующимися', 'цитата сохранена');
    assertEqual(message.quoteSourceReference, 'Рим. 12:15', 'ссылка на источник сохранена отдельным полем');
  });

  test('generate() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedOutcome({ projectId: PROJECT_ID, actualOutcome: 'MIXED', predictedLean: null });
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new ClosingMessageService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, PROJECT_ID), BadGatewayException, 'generate() при недоступности провайдера');
  });

  test('list() возвращает завершающие сообщения проекта, самые новые первыми', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedOutcome({ projectId: PROJECT_ID, actualOutcome: 'WENT_WELL', predictedLean: null });
    const svc = new ClosingMessageService(prisma as any, new FakeAIRouterService() as any);
    await svc.generate(USER_ID, PROJECT_ID);
    await svc.generate(USER_ID, PROJECT_ID);

    const list = await svc.list(USER_ID, PROJECT_ID);
    assertEqual(list.length, 2, 'оба сообщения видны');
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
  console.log(`\nClosingMessageService: ${results.length - failed.length}/${results.length} passed\n`);
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

import { BreakingQuestionsService } from '../breaking-questions/breaking-questions.service';
import { BadGatewayException, BadRequestException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const argumentsList: any[] = [];
  const motiveHypotheses: any[] = [];
  const questionSets: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedArgument(a: any) { argumentsList.push({ id: a.id ?? nextId(), targetPersonId: null, ...a }); },
    _seedMotiveHypothesis(m: any) { motiveHypotheses.push(m); },
    _getQuestionSets() { return questionSets; },

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
    motiveHypothesis: {
      findMany: async ({ where }: any) => motiveHypotheses.filter((m) => m.projectId === where.projectId && m.personId === where.personId),
    },
    promptVersion: {
      findFirst: async () => null,
    },
    breakingQuestionSet: {
      create: async ({ data }: any) => {
        const q = { id: nextId(), createdAt: new Date(), ...data };
        questionSets.push(q);
        return q;
      },
      findMany: async ({ where }: any) => questionSets.filter((q) => q.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt),
    },
  };
}

class FakeAIRouterService {
  responseText = '{"breakingQuestion":"Пробивающий вопрос","compromiseQuestion":"Компромиссный вопрос"}';
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
const PERSON_ID = 'person-1';

function seedProject(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('generate() бросает BadRequestException для пустого transcriptWindow', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new BreakingQuestionsService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, PROJECT_ID, '   '), BadRequestException, 'generate() с пустым транскриптом');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: generate() создаёт оба вопроса за один вызов', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new BreakingQuestionsService(prisma as any, new FakeAIRouterService() as any);

    const result = await svc.generate(USER_ID, PROJECT_ID, 'фрагмент разговора');
    assertEqual(result.breakingQuestion, 'Пробивающий вопрос', 'пробивающий вопрос сохранён');
    assertEqual(result.compromiseQuestion, 'Компромиссный вопрос', 'компромиссный вопрос сохранён в той же записи');
  });

  test('generate() подмешивает базу аргументов проекта в промпт', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ projectId: PROJECT_ID, text: 'Ключевой аргумент проекта', stance: 'PRO' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new BreakingQuestionsService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID, 'x');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Ключевой аргумент проекта'), true, 'аргумент попал в промпт');
  });

  test('generate() подмешивает гипотезы мотива, если targetPersonId передан', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedMotiveHypothesis({ projectId: PROJECT_ID, personId: PERSON_ID, explanation: 'Гипотеза о мотиве собеседника' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new BreakingQuestionsService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID, 'x', PERSON_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Гипотеза о мотиве собеседника'), true, 'гипотеза мотива попала в промпт');
  });

  test('generate() НЕ запрашивает гипотезы мотива без targetPersonId', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedMotiveHypothesis({ projectId: PROJECT_ID, personId: PERSON_ID, explanation: 'Гипотеза, которая не должна попасть' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new BreakingQuestionsService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID, 'x');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Гипотеза, которая не должна попасть'), false, 'без targetPersonId гипотезы не запрашиваются вообще');
  });

  test('generate() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new BreakingQuestionsService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, PROJECT_ID, 'x'), BadGatewayException, 'generate() при недоступности провайдера');
  });

  test('list() возвращает наборы вопросов проекта, самые новые первыми', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new BreakingQuestionsService(prisma as any, new FakeAIRouterService() as any);

    await svc.generate(USER_ID, PROJECT_ID, 'первый вызов');
    await svc.generate(USER_ID, PROJECT_ID, 'второй вызов');

    const list = await svc.list(USER_ID, PROJECT_ID);
    assertEqual(list.length, 2, 'оба набора видны');
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
  console.log(`\nBreakingQuestionsService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

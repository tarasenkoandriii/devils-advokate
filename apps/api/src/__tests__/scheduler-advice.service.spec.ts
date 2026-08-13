import { SchedulerAdviceService } from '../scheduler-advice/scheduler-advice.service';
import { BadGatewayException, BadRequestException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const projectPeople: any[] = [];
  const people = new Map<string, any>();
  const facts: any[] = [];
  const relationships: any[] = [];
  const advice: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedProjectPerson(pp: any) { projectPeople.push(pp); },
    _seedFact(f: any) { facts.push({ id: nextId(), status: 'ACTIVE', ...f }); },
    _seedRelationship(r: any) { relationships.push(r); },
    _getAdvice() { return advice; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    projectPerson: {
      findMany: async ({ where }: any) => projectPeople.filter((pp) => pp.projectId === where.projectId).map((pp) => ({ ...pp, person: people.get(pp.personId) })),
    },
    personFact: {
      findMany: async ({ where }: any) =>
        facts
          .filter((f) => where.personId.in.includes(f.personId) && f.sourceType === where.sourceType && f.status === where.status)
          .map((f) => ({ ...f, person: people.get(f.personId) })),
    },
    relationship: {
      findMany: async ({ where }: any) =>
        relationships
          .filter((r) => where.personAId.in.includes(r.personAId) && where.personBId.in.includes(r.personBId))
          .map((r) => ({ ...r, personA: people.get(r.personAId), personB: people.get(r.personBId) })),
    },
    promptVersion: {
      findFirst: async () => null,
    },
    schedulerAdvice: {
      create: async ({ data }: any) => {
        const a = { id: nextId(), createdAt: new Date(), ...data };
        advice.push(a);
        return a;
      },
      findMany: async ({ where }: any) => advice.filter((a) => a.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt),
    },
  };
}

class FakeAIRouterService {
  responseText = '[{"adviceText":"С Иваном лучше встретиться отдельно — есть конфликт с Петром"}]';
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
const PERSON_A = 'person-a';
const PERSON_B = 'person-b';

function seedProject(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Раздел имущества' });
  prisma._seedPerson({ id: PERSON_A, displayName: 'Иван' });
  prisma._seedPerson({ id: PERSON_B, displayName: 'Пётр' });
  prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_A, status: 'PERSONA' });
  prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_B, status: 'PERSONA' });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('КЛЮЧЕВОЙ ТЕСТ: generate() бросает BadRequestException без личных фактов и без связей — не гадает на пустом месте', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new SchedulerAdviceService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, PROJECT_ID), BadRequestException, 'generate() без данных вообще');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: generate() запрашивает PersonFact ТОЛЬКО с sourceType=PERSONAL_RECORD, не PUBLIC_FACT/USER_GUESS', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedFact({ personId: PERSON_A, content: 'Предпочитает вечерние встречи', sourceType: 'PERSONAL_RECORD' });
    prisma._seedFact({ personId: PERSON_A, content: 'Публично известный факт', sourceType: 'PUBLIC_FACT' });
    prisma._seedFact({ personId: PERSON_A, content: 'Догадка пользователя', sourceType: 'USER_GUESS' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new SchedulerAdviceService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Предпочитает вечерние встречи'), true, 'PERSONAL_RECORD факт попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Публично известный факт'), false, 'PUBLIC_FACT НЕ попал в промпт — "строго со слов" не про публичные факты');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Догадка пользователя'), false, 'USER_GUESS НЕ попал в промпт — не "со слов", а предположение');
  });

  test('generate() подмешивает связи между людьми в промпт для "раздельные/групповые встречи"', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedRelationship({ personAId: PERSON_A, personBId: PERSON_B, label: 'в открытом конфликте' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new SchedulerAdviceService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('в открытом конфликте'), true, 'связь между людьми попала в промпт');
  });

  test('generate() подмешивает статусы персона/фигурант в промпт', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x' });
    prisma._seedPerson({ id: PERSON_A, displayName: 'Иван' });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_A, status: 'FIGURANT' });
    prisma._seedFact({ personId: PERSON_A, content: 'Не любит утренние встречи', sourceType: 'PERSONAL_RECORD' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new SchedulerAdviceService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('фигурант'), true, 'статус попал в промпт');
  });

  test('generate() создаёт по записи SchedulerAdvice на каждый пункт списка от AI', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedFact({ personId: PERSON_A, content: 'x', sourceType: 'PERSONAL_RECORD' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '[{"adviceText":"Совет 1"},{"adviceText":"Совет 2"}]';
    const svc = new SchedulerAdviceService(prisma as any, fakeRouter as any);

    const created = await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(created.length, 2, 'оба совета из списка сохранены отдельными записями');
  });

  test('generate() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedFact({ personId: PERSON_A, content: 'x', sourceType: 'PERSONAL_RECORD' });
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new SchedulerAdviceService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, PROJECT_ID), BadGatewayException, 'generate() при недоступности провайдера');
  });

  test('list() возвращает советы проекта, самые новые первыми', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedFact({ personId: PERSON_A, content: 'x', sourceType: 'PERSONAL_RECORD' });
    const svc = new SchedulerAdviceService(prisma as any, new FakeAIRouterService() as any);
    await svc.generate(USER_ID, PROJECT_ID);

    const list = await svc.list(USER_ID, PROJECT_ID);
    assertEqual(list.length, 1, 'совет виден через list()');
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
  console.log(`\nSchedulerAdviceService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

import { OutcomeForecastingService } from '../outcome-forecasting/outcome-forecasting.service';
import { BadGatewayException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const argumentsStore: any[] = [];
  const people = new Map<string, any>();
  const projectPeople: any[] = [];
  const traits: any[] = [];
  const relationships: any[] = [];
  const precedents: any[] = [];
  const protectedNotes: any[] = [];
  const scenarios: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedArgument(a: any) { argumentsStore.push(a); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedProjectPerson(pp: any) { projectPeople.push({ stakeholderRole: null, ...pp }); },
    _seedTrait(t: any) { traits.push(t); },
    _seedRelationship(r: any) { relationships.push(r); },
    _seedPrecedent(p: any) { precedents.push(p); },
    _seedProtectedNote(n: any) { protectedNotes.push(n); },
    _getScenarios() { return scenarios; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    argument: {
      findMany: async ({ where }: any) =>
        argumentsStore.filter((a) => a.projectId === where.projectId && (where.targetPersonId?.equals === undefined ? a.targetPersonId == null : true)),
    },
    projectPerson: {
      findFirst: async ({ where, include }: any) => {
        const pp = projectPeople.find((x) => x.projectId === where.projectId && x.stakeholderRole === where.stakeholderRole);
        if (!pp) return null;
        if (include?.person) return { ...pp, person: people.get(pp.personId) };
        return pp;
      },
    },
    personCommunicationTrait: {
      findMany: async ({ where }: any) => traits.filter((t) => t.personId === where.personId),
    },
    relationship: {
      findMany: async ({ where }: any) => relationships.filter((r) => r.personAId === where.OR[0].personAId || r.personBId === where.OR[1].personBId),
    },
    behaviorPrecedent: {
      findMany: async ({ where }: any) => precedents.filter((p) => p.personId === where.personId),
    },
    protectedNote: {
      findMany: async ({ where }: any) => protectedNotes.filter((n) => n.projectId === where.projectId),
    },
    promptVersion: {
      findFirst: async () => null,
    },
    outcomeScenario: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), createdAt: new Date(), ...data };
        scenarios.push(s);
        return s;
      },
      findMany: async ({ where }: any) => scenarios.filter((s) => s.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt),
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
const PERSON_ID = 'person-1';

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenariosList: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenariosList.push([name, fn]);

  test('generateScenarios() честно указывает, что решающий не определён', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    const svc = new OutcomeForecastingService(prisma as any, fakeRouter as any);

    await svc.generateScenarios(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('ещё не определён'), true, 'честное указание отсутствия решающего в промпте');
  });

  test('generateScenarios() подмешивает профиль/связи/прецеденты решающего человека, если роль подтверждена', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Стоит ли просить о повышении?', goal: null });
    prisma._seedPerson({ id: PERSON_ID, displayName: 'Начальник Иван' });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_ID, stakeholderRole: 'DECISION_MAKER' });
    prisma._seedTrait({ personId: PERSON_ID, traitType: 'RESPONDS_TO_DATA', value: 'Просит конкретные цифры' });
    prisma._seedRelationship({ personAId: PERSON_ID, personBId: 'other', label: 'муж финансового директора' });
    prisma._seedPrecedent({ personId: PERSON_ID, precedentDescription: 'В марте отказал без объяснений' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new OutcomeForecastingService(prisma as any, fakeRouter as any);

    await svc.generateScenarios(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Начальник Иван'), true, 'имя решающего попало в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Просит конкретные цифры'), true, 'коммуникационный профиль попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('муж финансового директора'), true, 'связь попала в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('В марте отказал без объяснений'), true, 'прецедент попал в промпт');
  });

  test('generateScenarios() подмешивает защищённые заметки в промпт', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    prisma._seedProtectedNote({ projectId: PROJECT_ID, type: 'ACE_IN_THE_HOLE', content: 'Есть предложение от другой компании', triggerCondition: null });
    const fakeRouter = new FakeAIRouterService();
    const svc = new OutcomeForecastingService(prisma as any, fakeRouter as any);

    await svc.generateScenarios(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Есть предложение от другой компании'), true, 'защищённая заметка попала в промпт');
  });

  test('generateScenarios() подмешивает пользовательские сценарии в промпт', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    const svc = new OutcomeForecastingService(prisma as any, fakeRouter as any);

    await svc.generateScenarios(USER_ID, PROJECT_ID, ['Если промолчу', 'Если предложу компромисс']);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Если промолчу'), true, 'первый пользовательский сценарий попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Если предложу компромисс'), true, 'второй пользовательский сценарий попал в промпт');
  });

  test('generateScenarios() создаёт OutcomeScenario с правильными полями', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { scenarioType: 'DO_NOTHING', outcomeDescription: 'Ничего не изменится в ближайший квартал', confidence: 'MEDIUM' },
      { scenarioType: 'USER_DEFINED', userDescription: 'Если промолчу', outcomeDescription: 'Вопрос забудется', confidence: 'LOW', protectedNoteHint: 'стоит достать туз в рукаве' },
    ]);
    const svc = new OutcomeForecastingService(prisma as any, fakeRouter as any);

    const created = await svc.generateScenarios(USER_ID, PROJECT_ID, ['Если промолчу']);
    assertEqual(created.length, 2, 'оба сценария созданы');
    assertEqual(created[0].scenarioType, 'DO_NOTHING', 'первый — DO_NOTHING');
    assertEqual(created[0].userDescription, null, 'userDescription null для не-USER_DEFINED');
    assertEqual(created[1].userDescription, 'Если промолчу', 'userDescription сохранён для USER_DEFINED');
    assertEqual(created[1].protectedNoteHint, 'стоит достать туз в рукаве', 'подсказка про защищённую заметку сохранена');
  });

  test('generateScenarios() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new OutcomeForecastingService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.generateScenarios(USER_ID, PROJECT_ID), BadGatewayException, 'generateScenarios() при недоступности провайдера');
  });

  test('list() сортирует по типу сценария (DO_NOTHING → ASSUME_HARM → ASSUME_HELP → USER_DEFINED), не по времени создания', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    const svc = new OutcomeForecastingService(prisma as any, fakeRouter as any);

    // Создаём в ОБРАТНОМ порядке типов — USER_DEFINED первым по времени.
    fakeRouter.responseText = JSON.stringify([{ scenarioType: 'USER_DEFINED', userDescription: 'x', outcomeDescription: 'd1', confidence: 'LOW' }]);
    await svc.generateScenarios(USER_ID, PROJECT_ID, ['x']);
    fakeRouter.responseText = JSON.stringify([{ scenarioType: 'DO_NOTHING', outcomeDescription: 'd2', confidence: 'MEDIUM' }]);
    await svc.generateScenarios(USER_ID, PROJECT_ID);

    const list = await svc.list(USER_ID, PROJECT_ID);
    assertEqual(list.length, 2, 'оба сценария видны');
    assertEqual(list[0].scenarioType, 'DO_NOTHING', 'DO_NOTHING идёт первым, несмотря на то что создан позже USER_DEFINED');
  });

  test('list() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new OutcomeForecastingService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.list(USER_ID, PROJECT_ID), NotFoundException, 'list() на чужой проект');
  });

  for (const [name, fn] of scenariosList) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  const failed = results.filter((r) => r.error);
  console.log(`\nOutcomeForecastingService: ${results.length - failed.length}/${results.length} passed\n`);
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

import { StakeholderMapService } from '../stakeholder-map/stakeholder-map.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const people = new Map<string, any>();
  const projectPeople: any[] = [];
  const facts: any[] = [];
  const relationships: any[] = [];
  const argumentsStore: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedProjectPerson(pp: any) { projectPeople.push({ id: pp.id ?? nextId(), stakeholderRole: null, stakeholderRoleConfirmedByUser: false, ...pp }); },
    _seedFact(f: any) { facts.push(f); },
    _seedRelationship(r: any) { relationships.push(r); },
    _getArguments() { return argumentsStore; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    projectPerson: {
      findMany: async ({ where, include }: any) => {
        let result = projectPeople.filter((pp) => pp.projectId === where.projectId);
        if (where.stakeholderRole?.not === null) result = result.filter((pp) => pp.stakeholderRole !== null);
        if (include?.person) {
          result = result.map((pp) => {
            const person = people.get(pp.personId);
            const personWithFacts = include.person.include?.facts
              ? { ...person, facts: facts.filter((f) => f.personId === pp.personId) }
              : person;
            return { ...pp, person: personWithFacts };
          });
        }
        return result;
      },
      findFirst: async ({ where, include }: any) => {
        const pp = projectPeople.find((x) => x.projectId === where.projectId && x.personId === where.personId);
        if (!pp) return null;
        if (where.project?.ownerId) {
          const project = projects.get(pp.projectId);
          if (project.ownerId !== where.project.ownerId) return null;
        }
        if (include?.person) {
          const person = people.get(pp.personId);
          const personWithFacts = include.person.include?.facts
            ? { ...person, facts: facts.filter((f) => f.personId === pp.personId) }
            : person;
          return { ...pp, person: personWithFacts };
        }
        return pp;
      },
      update: async ({ where, data }: any) => {
        const idx = projectPeople.findIndex((pp) => pp.id === where.id);
        projectPeople[idx] = { ...projectPeople[idx], ...data };
        return projectPeople[idx];
      },
    },
    relationship: {
      findMany: async ({ where }: any) => {
        const personAIds = where.OR.map((o: any) => o.personAId);
        return relationships.filter((r) => personAIds.includes(r.personAId));
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
      findMany: async ({ where }: any) => {
        let result = argumentsStore.filter((a) => a.projectId === where.projectId);
        if (where.targetPersonId?.not === null) result = result.filter((a) => a.targetPersonId !== null);
        return result;
      },
    },
    $transaction: async (ops: Promise<any>[]) => Promise.all(ops),
  };
}

class FakeAIRouterService {
  responseText = '{}';
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
const PERSON_A = 'person-a';
const PERSON_B = 'person-b';

function seedProjectWithOnePerson(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Стоит ли просить о повышении?', goal: null });
  prisma._seedPerson({ id: PERSON_A, displayName: 'Начальник Иван' });
  prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_A });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('suggestRoles() бросает BadRequestException, если в проекте нет ни одного человека', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const svc = new StakeholderMapService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.suggestRoles(USER_ID, PROJECT_ID), BadRequestException, 'suggestRoles() без людей');
  });

  test('suggestRoles() подмешивает факты и связи в промпт', async () => {
    const prisma = createFakePrisma();
    seedProjectWithOnePerson(prisma);
    prisma._seedFact({ personId: PERSON_A, content: 'Работает финансовым директором' });
    prisma._seedPerson({ id: PERSON_B, displayName: 'HR Оксана' });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_B });
    prisma._seedRelationship({ personAId: PERSON_A, personBId: PERSON_B, label: 'начальник' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ roleSuggestions: [], gapSuggestions: [] });
    const svc = new StakeholderMapService(prisma as any, fakeRouter as any);

    await svc.suggestRoles(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Работает финансовым директором'), true, 'факт попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('начальник'), true, 'связь попала в промпт');
  });

  test('suggestRoles() отфильтровывает предложения со ссылкой на несуществующего personId', async () => {
    const prisma = createFakePrisma();
    seedProjectWithOnePerson(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({
      roleSuggestions: [
        { personId: PERSON_A, role: 'DECISION_MAKER', reasoning: 'x' },
        { personId: 'does-not-exist', role: 'ADVISOR', reasoning: 'y' },
      ],
      gapSuggestions: [],
    });
    const svc = new StakeholderMapService(prisma as any, fakeRouter as any);

    const result = await svc.suggestRoles(USER_ID, PROJECT_ID);
    assertEqual(result.roleSuggestions.length, 1, 'только предложение с реальным personId прошло');
  });

  test('suggestRoles() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedProjectWithOnePerson(prisma);
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new StakeholderMapService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.suggestRoles(USER_ID, PROJECT_ID), BadGatewayException, 'suggestRoles() при недоступности провайдера');
  });

  test('confirmRole() бросает NotFoundException для персоны не из этого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const svc = new StakeholderMapService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.confirmRole(USER_ID, PROJECT_ID, 'not-in-project', 'ALLY' as any),
      NotFoundException,
      'confirmRole() на персону не из проекта',
    );
  });

  test('confirmRole() проставляет роль и флаг подтверждения пользователем', async () => {
    const prisma = createFakePrisma();
    seedProjectWithOnePerson(prisma);
    const svc = new StakeholderMapService(prisma as any, new FakeAIRouterService() as any);

    const updated = await svc.confirmRole(USER_ID, PROJECT_ID, PERSON_A, 'DECISION_MAKER' as any);
    assertEqual(updated.stakeholderRole, 'DECISION_MAKER', 'роль проставлена');
    assertEqual(updated.stakeholderRoleConfirmedByUser, true, 'флаг подтверждения выставлен явным вызовом');
  });

  test('generateArgumentsForStakeholder() бросает NotFoundException для персоны не из проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const svc = new StakeholderMapService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.generateArgumentsForStakeholder(USER_ID, PROJECT_ID, 'not-in-project'),
      NotFoundException,
      'generateArgumentsForStakeholder() на персону не из проекта',
    );
  });

  test('generateArgumentsForStakeholder() создаёт Argument с targetPersonId', async () => {
    const prisma = createFakePrisma();
    seedProjectWithOnePerson(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { text: 'Ваши результаты за квартал выше плана', stance: 'pro', weight: 0.8 },
    ]);
    const svc = new StakeholderMapService(prisma as any, fakeRouter as any);

    const created = await svc.generateArgumentsForStakeholder(USER_ID, PROJECT_ID, PERSON_A);
    assertEqual(created.length, 1, 'один аргумент создан');
    assertEqual(created[0].targetPersonId, PERSON_A, 'targetPersonId проставлен');
    assertEqual(created[0].stance, 'PRO', 'stance преобразован корректно');
  });

  test('generateArgumentsForStakeholder() подмешивает подтверждённую роль в промпт', async () => {
    const prisma = createFakePrisma();
    seedProjectWithOnePerson(prisma);
    const svc = new StakeholderMapService(prisma as any, new FakeAIRouterService() as any);
    await svc.confirmRole(USER_ID, PROJECT_ID, PERSON_A, 'BLOCKER' as any);

    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([]);
    const svc2 = new StakeholderMapService(prisma as any, fakeRouter as any);
    await svc2.generateArgumentsForStakeholder(USER_ID, PROJECT_ID, PERSON_A);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('блокер'), true, 'роль "блокер" попала в промпт');
  });

  test('listByStakeholder() группирует аргументы по персоне, включает только людей с подтверждённой ролью', async () => {
    const prisma = createFakePrisma();
    seedProjectWithOnePerson(prisma);
    prisma._seedPerson({ id: PERSON_B, displayName: 'HR Оксана' });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_B }); // без роли
    const svc = new StakeholderMapService(prisma as any, new FakeAIRouterService() as any);
    await svc.confirmRole(USER_ID, PROJECT_ID, PERSON_A, 'DECISION_MAKER' as any);

    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([{ text: 'x', stance: 'pro' }]);
    const svcWithRouter = new StakeholderMapService(prisma as any, fakeRouter as any);
    await svcWithRouter.generateArgumentsForStakeholder(USER_ID, PROJECT_ID, PERSON_A);

    const map = await svc.listByStakeholder(USER_ID, PROJECT_ID);
    assertEqual(map.length, 1, 'только PERSON_A (с подтверждённой ролью) попал в карту, PERSON_B без роли — нет');
    assertEqual(map[0].arguments.length, 1, 'аргумент привязан к правильному стейкхолдеру');
  });

  test('listByStakeholder() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user', question: 'x', goal: null });
    const svc = new StakeholderMapService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.listByStakeholder(USER_ID, PROJECT_ID), NotFoundException, 'listByStakeholder() на чужой проект');
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
  console.log(`\nStakeholderMapService: ${results.length - failed.length}/${results.length} passed\n`);
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

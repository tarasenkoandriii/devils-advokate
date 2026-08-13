import { ArchetypePerspectiveService } from '../archetype-perspective/archetype-perspective.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const argumentsStore: any[] = [];
  const perspectives: any[] = [];
  const people = new Map<string, any>();
  const projectPeople: any[] = [];
  const traits: any[] = [];
  const relationships: any[] = [];
  const precedents: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedArgument(a: any) { argumentsStore.push(a); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedProjectPerson(pp: any) { projectPeople.push(pp); },
    _seedTrait(t: any) { traits.push(t); },
    _seedRelationship(r: any) { relationships.push(r); },
    _seedPrecedent(p: any) { precedents.push(p); },
    _getPerspectives() { return perspectives; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    argument: {
      findMany: async ({ where }: any) =>
        argumentsStore.filter(
          (a) =>
            a.projectId === where.projectId &&
            (where.targetPersonId === undefined ? true : a.targetPersonId === where.targetPersonId) &&
            (where.stance === undefined ? true : a.stance === where.stance),
        ),
    },
    promptVersion: {
      findFirst: async () => null,
    },
    projectPerson: {
      findFirst: async ({ where, include }: any) => {
        const pp = projectPeople.find((x) => x.projectId === where.projectId && x.personId === where.personId);
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
    archetypePerspective: {
      create: async ({ data }: any) => {
        const p = { id: nextId(), createdAt: new Date(), ...data };
        perspectives.push(p);
        return p;
      },
      findMany: async ({ where }: any) => perspectives.filter((p) => p.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt),
    },
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

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('generate() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new ArchetypePerspectiveService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.generate(USER_ID, PROJECT_ID, 'LAWYER' as any),
      NotFoundException,
      'generate() на чужой проект',
    );
  });

  test('generate() бросает BadRequestException для CUSTOM без customArchetypeDescription', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const svc = new ArchetypePerspectiveService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.generate(USER_ID, PROJECT_ID, 'CUSTOM' as any),
      BadRequestException,
      'generate() с CUSTOM без описания',
    );
  });

  test('generate() принимает CUSTOM с описанием и подмешивает его в промпт', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Стоит ли увольняться?', goal: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ reaction: 'x' });
    const svc = new ArchetypePerspectiveService(prisma as any, fakeRouter as any);

    const result = await svc.generate(USER_ID, PROJECT_ID, 'CUSTOM' as any, 'Строгий бывший армейский командир');
    assertEqual(result.customArchetypeDescription, 'Строгий бывший армейский командир', 'описание сохранено');
    assertEqual(
      fakeRouter.lastRequest.userPrompt.includes('Строгий бывший армейский командир'),
      true,
      'кастомное описание попало в промпт',
    );
  });

  test('generate() подмешивает встроенное описание архетипа для не-CUSTOM типов', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ reaction: 'x' });
    const svc = new ArchetypePerspectiveService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID, 'JEALOUS_SPOUSE' as any);
    assertEqual(
      fakeRouter.lastRequest.userPrompt.includes('ревнивая жена'),
      true,
      'встроенное описание архетипа JEALOUS_SPOUSE попало в промпт',
    );
  });

  test('generate() подмешивает топ-аргументы проекта в промпт', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    prisma._seedArgument({ projectId: PROJECT_ID, text: 'Зарплата ниже рынка на 20%', stance: 'PRO', weight: 0.9 });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ reaction: 'x' });
    const svc = new ArchetypePerspectiveService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID, 'LAWYER' as any);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Зарплата ниже рынка на 20%'), true, 'аргумент проекта попал в промпт');
  });

  test('generate() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new ArchetypePerspectiveService(prisma as any, failingRouter as any);
    await assertThrowsAsync(
      () => svc.generate(USER_ID, PROJECT_ID, 'POLICE_OFFICER' as any),
      BadGatewayException,
      'generate() при недоступности провайдера',
    );
  });

  test('generate() успешно создаёт ArchetypePerspective с provenance', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ reaction: 'С точки зрения закона тут всё чисто, но стоит зафиксировать письменно.' });
    const svc = new ArchetypePerspectiveService(prisma as any, fakeRouter as any);

    const result = await svc.generate(USER_ID, PROJECT_ID, 'POLICE_OFFICER' as any);
    assertEqual(result.archetypeType, 'POLICE_OFFICER', 'archetypeType сохранён');
    assertEqual(result.reaction, 'С точки зрения закона тут всё чисто, но стоит зафиксировать письменно.', 'reaction сохранён');
    assertEqual(result.generatedByInferenceId, 'inference-1', 'provenance проставлен');
    assertEqual(result.customArchetypeDescription, null, 'customArchetypeDescription null для встроенного архетипа');
  });

  test('list() возвращает перспективы проекта, отсортированные по свежести', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    const svc = new ArchetypePerspectiveService(prisma as any, fakeRouter as any);

    fakeRouter.responseText = JSON.stringify({ reaction: 'Первая' });
    await svc.generate(USER_ID, PROJECT_ID, 'LAWYER' as any);
    await new Promise((r) => setTimeout(r, 5));
    fakeRouter.responseText = JSON.stringify({ reaction: 'Вторая' });
    await svc.generate(USER_ID, PROJECT_ID, 'PSYCHOLOGIST' as any);

    const list = await svc.list(USER_ID, PROJECT_ID);
    assertEqual(list.length, 2, 'обе перспективы видны');
    assertEqual(list[0].reaction, 'Вторая', 'самая свежая первой');
  });

  test('list() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new ArchetypePerspectiveService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.list(USER_ID, PROJECT_ID), NotFoundException, 'list() на чужой проект');
  });

  // ── Пункт 46: REAL_PERSON — вторая ветка §3.11, ранее отложенная ──

  test('generate() бросает BadRequestException для REAL_PERSON без targetPersonId', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const svc = new ArchetypePerspectiveService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.generate(USER_ID, PROJECT_ID, 'REAL_PERSON' as any),
      BadRequestException,
      'generate() REAL_PERSON без targetPersonId',
    );
  });

  test('generate() бросает NotFoundException, если targetPersonId не привязан к проекту', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const svc = new ArchetypePerspectiveService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.generate(USER_ID, PROJECT_ID, 'REAL_PERSON' as any, undefined, 'not-in-project'),
      NotFoundException,
      'generate() REAL_PERSON с чужим/несуществующим personId',
    );
  });

  test('generate() REAL_PERSON подмешивает коммуникационный профиль, связи и прецеденты в промпт', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Стоит ли просить о повышении?', goal: null });
    prisma._seedPerson({ id: 'person-1', displayName: 'Начальник Иван' });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: 'person-1' });
    prisma._seedTrait({ personId: 'person-1', traitType: 'RESPONDS_TO_DATA', value: 'Просит конкретные цифры перед решением' });
    prisma._seedRelationship({ personAId: 'person-1', personBId: 'person-2', label: 'муж финансового директора' });
    prisma._seedPrecedent({ personId: 'person-1', precedentDescription: 'В марте отказал в похожей просьбе без объяснений' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ reaction: 'x' });
    const svc = new ArchetypePerspectiveService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID, 'REAL_PERSON' as any, undefined, 'person-1');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Просит конкретные цифры перед решением'), true, 'коммуникационный профиль попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('муж финансового директора'), true, 'связь попала в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('В марте отказал в похожей просьбе'), true, 'прецедент попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Начальник Иван'), true, 'имя человека попало в промпт');
  });

  test('generate() REAL_PERSON без известных данных честно предупреждает AI не выдумывать', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    prisma._seedPerson({ id: 'person-1', displayName: 'Незнакомец' });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: 'person-1' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ reaction: 'x' });
    const svc = new ArchetypePerspectiveService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID, 'REAL_PERSON' as any, undefined, 'person-1');
    assertEqual(
      fakeRouter.lastRequest.userPrompt.includes('не выдумывай подробностей'),
      true,
      'явное предупреждение AI не выдумывать при отсутствии данных',
    );
  });

  test('generate() REAL_PERSON создаёт ArchetypePerspective с targetPersonId, customArchetypeDescription=null', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    prisma._seedPerson({ id: 'person-1', displayName: 'Иван' });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: 'person-1' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ reaction: 'Он бы спросил про конкретные цифры' });
    const svc = new ArchetypePerspectiveService(prisma as any, fakeRouter as any);

    const result = await svc.generate(USER_ID, PROJECT_ID, 'REAL_PERSON' as any, undefined, 'person-1');
    assertEqual(result.archetypeType, 'REAL_PERSON', 'archetypeType сохранён');
    assertEqual(result.targetPersonId, 'person-1', 'targetPersonId сохранён');
    assertEqual(result.customArchetypeDescription, null, 'customArchetypeDescription null для REAL_PERSON');
  });

  // ── Пункт 54: focusOnOwnPositionWeaknesses — критика собственной
  // позиции (§3.17 ТЗ, "тот же механизм, развёрнутый на 180°") ──

  test('generate() в режиме focusOnOwnPositionWeaknesses фильтрует только PRO project-level аргументы', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    prisma._seedArgument({ id: 'a1', projectId: PROJECT_ID, stance: 'PRO', text: 'Мой сильный аргумент', targetPersonId: null });
    prisma._seedArgument({ id: 'a2', projectId: PROJECT_ID, stance: 'CON', text: 'Контраргумент', targetPersonId: null });
    prisma._seedArgument({ id: 'a3', projectId: PROJECT_ID, stance: 'PRO', text: 'Адресный аргумент', targetPersonId: 'person-x' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ reaction: 'x' });
    const svc = new ArchetypePerspectiveService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID, 'LAWYER' as any, undefined, undefined, undefined, true);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Мой сильный аргумент'), true, 'PRO project-level аргумент попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Контраргумент'), false, 'CON-аргумент не попал в промпт критики собственной позиции');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Адресный аргумент'), false, 'адресный (targetPersonId) аргумент не попал');
  });

  test('generate() в режиме focusOnOwnPositionWeaknesses формулирует промпт на поиск слабых мест, не общую реакцию', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ reaction: 'x' });
    const svc = new ArchetypePerspectiveService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID, 'LAWYER' as any, undefined, undefined, undefined, true);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('СЛАБЫЕ МЕСТА'), true, 'промпт прицельно просит слабые места, не общую реакцию');
  });

  test('generate() сохраняет focusOnOwnPositionWeaknesses=true в записи', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ reaction: 'Слабое место: не учтён риск X' });
    const svc = new ArchetypePerspectiveService(prisma as any, fakeRouter as any);

    const result = await svc.generate(USER_ID, PROJECT_ID, 'LAWYER' as any, undefined, undefined, undefined, true);
    assertEqual(result.focusOnOwnPositionWeaknesses, true, 'флаг режима сохранён');
  });

  test('generate() без явного параметра — обычный режим (focusOnOwnPositionWeaknesses=false по умолчанию)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    prisma._seedArgument({ id: 'a1', projectId: PROJECT_ID, stance: 'CON', text: 'Контраргумент виден в обычном режиме', targetPersonId: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ reaction: 'x' });
    const svc = new ArchetypePerspectiveService(prisma as any, fakeRouter as any);

    const result = await svc.generate(USER_ID, PROJECT_ID, 'LAWYER' as any);
    assertEqual(result.focusOnOwnPositionWeaknesses, false, 'по умолчанию обычный режим');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Контраргумент виден в обычном режиме'), true, 'в обычном режиме CON-аргументы тоже видны (не фильтруются)');
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
  console.log(`\nArchetypePerspectiveService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

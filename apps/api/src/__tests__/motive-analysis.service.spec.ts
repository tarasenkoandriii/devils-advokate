import { MotiveAnalysisService } from '../motive-analysis/motive-analysis.service';
import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const projectPeople: any[] = [];
  const people = new Map<string, any>();
  const facts: any[] = [];
  const precedents: any[] = [];
  const traits: any[] = [];
  const relationships: any[] = [];
  const objectives = new Map<string, any>();
  const hypotheses: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedProjectPerson(pp: any) { projectPeople.push(pp); },
    _seedFact(f: any) { facts.push({ status: 'ACTIVE', ...f }); },
    _seedPrecedent(p: any) { precedents.push(p); },
    _seedTrait(t: any) { traits.push(t); },
    _seedRelationship(r: any) { relationships.push(r); },
    _seedObjective(o: any) { objectives.set(o.projectId, o); },
    _seedHypothesis(h: any) { hypotheses.push({ id: h.id ?? nextId(), createdAt: new Date(), ...h }); },
    _getHypotheses() { return hypotheses; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    projectPerson: {
      findFirst: async ({ where, include }: any) => {
        const pp = projectPeople.find((x) => x.projectId === where.projectId && x.personId === where.personId);
        if (!pp) return null;
        if (include?.person) return { ...pp, person: people.get(pp.personId) };
        return pp;
      },
    },
    personFact: {
      findMany: async ({ where }: any) => facts.filter((f) => f.personId === where.personId && f.status === where.status),
    },
    behaviorPrecedent: {
      findMany: async ({ where }: any) => precedents.filter((p) => p.personId === where.personId),
    },
    personCommunicationTrait: {
      findMany: async ({ where }: any) => traits.filter((t) => t.personId === where.personId),
    },
    relationship: {
      findMany: async ({ where }: any) => relationships.filter((r) => r.personAId === where.OR[0].personAId || r.personBId === where.OR[1].personBId),
    },
    decisionObjective: {
      findUnique: async ({ where }: any) => objectives.get(where.projectId) ?? null,
    },
    promptVersion: {
      findFirst: async () => null,
    },
    motiveHypothesis: {
      create: async ({ data }: any) => {
        const h = { id: nextId(), createdAt: new Date(), ...data };
        hypotheses.push(h);
        return h;
      },
      findMany: async ({ where }: any) =>
        hypotheses
          .filter((h) => (where.projectId === undefined || h.projectId === where.projectId) && (where.personId === undefined || h.personId === where.personId) && (where.createdByUserId === undefined || h.createdByUserId === where.createdByUserId) && (where.createdAt?.gte === undefined || h.createdAt >= where.createdAt.gte))
          .sort((a, b) => b.createdAt - a.createdAt),
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
const PERSON_ID = 'person-1';

function seedProjectWithPerson(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Как договориться о снижении арендной платы?', goal: null });
  prisma._seedPerson({ id: PERSON_ID, displayName: 'Арендодатель Пётр' });
  prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_ID });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('analyze() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new MotiveAnalysisService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.analyze(USER_ID, PROJECT_ID, PERSON_ID), NotFoundException, 'analyze() на чужой проект');
  });

  test('analyze() бросает NotFoundException, если персона не привязана к проекту', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const svc = new MotiveAnalysisService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.analyze(USER_ID, PROJECT_ID, PERSON_ID), NotFoundException, 'analyze() с персоной не из проекта');
  });

  test('analyze() бросает BadRequestException, если про персону ничего не известно', async () => {
    const prisma = createFakePrisma();
    seedProjectWithPerson(prisma);
    const svc = new MotiveAnalysisService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.analyze(USER_ID, PROJECT_ID, PERSON_ID), BadRequestException, 'analyze() без единого известного факта/прецедента/профиля');
  });

  test('analyze() подмешивает факты/прецеденты/профиль/связи в промпт', async () => {
    const prisma = createFakePrisma();
    seedProjectWithPerson(prisma);
    prisma._seedFact({ personId: PERSON_ID, content: 'Недавно купил новую квартиру' });
    prisma._seedPrecedent({ personId: PERSON_ID, precedentDescription: 'В прошлом году отказал в скидке другому арендатору' });
    prisma._seedTrait({ personId: PERSON_ID, traitType: 'RESPONDS_TO_DATA', value: 'Реагирует на конкретные цифры' });
    prisma._seedRelationship({ personAId: PERSON_ID, personBId: 'other', label: 'сосед по дому' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new MotiveAnalysisService(prisma as any, fakeRouter as any);

    await svc.analyze(USER_ID, PROJECT_ID, PERSON_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Недавно купил новую квартиру'), true, 'факт попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('В прошлом году отказал в скидке'), true, 'прецедент попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Реагирует на конкретные цифры'), true, 'профиль попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('сосед по дому'), true, 'связь попала в промпт');
  });

  test('analyze() подмешивает DecisionObjective пользователя, если он заполнен', async () => {
    const prisma = createFakePrisma();
    seedProjectWithPerson(prisma);
    prisma._seedFact({ personId: PERSON_ID, content: 'x' });
    prisma._seedObjective({ projectId: PROJECT_ID, desiredOutcome: 'Снизить аренду на 20%', minimumAcceptableOutcome: 'Хотя бы на 10%', constraints: [], nonNegotiables: ['Не переезжать'], negotiables: [] });
    const fakeRouter = new FakeAIRouterService();
    const svc = new MotiveAnalysisService(prisma as any, fakeRouter as any);

    await svc.analyze(USER_ID, PROJECT_ID, PERSON_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Снизить аренду на 20%'), true, 'желаемый исход попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Не переезжать'), true, 'нон-негошиэйблы попали в промпт');
  });

  test('analyze() честно указывает отсутствие DecisionObjective, не выдумывает цель', async () => {
    const prisma = createFakePrisma();
    seedProjectWithPerson(prisma);
    prisma._seedFact({ personId: PERSON_ID, content: 'x' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new MotiveAnalysisService(prisma as any, fakeRouter as any);

    await svc.analyze(USER_ID, PROJECT_ID, PERSON_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('не структурирована'), true, 'честное указание отсутствия Decision Objective');
  });

  test('analyze() создаёт несколько MotiveHypothesis из списка гипотез в ответе', async () => {
    const prisma = createFakePrisma();
    seedProjectWithPerson(prisma);
    prisma._seedFact({ personId: PERSON_ID, content: 'x' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { explanation: 'Возможно, экономит на будущий ремонт', supportingFactsSummary: 'Недавняя покупка квартиры', confidence: 'MEDIUM' },
      { explanation: 'Возможно, не хочет создавать прецедент для других арендаторов', supportingFactsSummary: 'Прошлый отказ другому арендатору', confidence: 'HIGH' },
    ]);
    const svc = new MotiveAnalysisService(prisma as any, fakeRouter as any);

    const created = await svc.analyze(USER_ID, PROJECT_ID, PERSON_ID);
    assertEqual(created.length, 2, 'обе гипотезы созданы как отдельные записи');
    assertEqual(created[0].confidence, 'MEDIUM', 'уверенность первой гипотезы сохранена');
  });

  test('analyze() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedProjectWithPerson(prisma);
    prisma._seedFact({ personId: PERSON_ID, content: 'x' });
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new MotiveAnalysisService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.analyze(USER_ID, PROJECT_ID, PERSON_ID), BadGatewayException, 'analyze() при недоступности провайдера');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: rate limit считает РАЗЛИЧНЫЕ вызовы анализа (inferenceId), а не строки гипотез', async () => {
    const prisma = createFakePrisma();
    seedProjectWithPerson(prisma);
    // Досеиваем 9 "вызовов" — каждый с 3 гипотезами (27 строк), но
    // только 9 РАЗЛИЧНЫХ generatedByInferenceId — лимит 10, значит
    // 10-й вызов должен ещё пройти (9 < 10), а не упасть, как было бы
    // при подсчёте по строкам (27 >= 10 сразу).
    for (let call = 0; call < 9; call++) {
      for (let h = 0; h < 3; h++) {
        prisma._seedHypothesis({ createdByUserId: USER_ID, generatedByInferenceId: `call-${call}`, personId: PERSON_ID, projectId: PROJECT_ID, explanation: 'x', supportingFactsSummary: 'x', confidence: 'LOW' });
      }
    }
    prisma._seedFact({ personId: PERSON_ID, content: 'x' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new MotiveAnalysisService(prisma as any, fakeRouter as any);

    // 10-й вызов (9 предыдущих РАЗЛИЧНЫХ анализов < лимита 10) — должен пройти.
    await svc.analyze(USER_ID, PROJECT_ID, PERSON_ID);
  });

  test('rate limit блокирует после достижения дневного лимита РАЗЛИЧНЫХ анализов', async () => {
    const prisma = createFakePrisma();
    seedProjectWithPerson(prisma);
    for (let call = 0; call < 10; call++) {
      prisma._seedHypothesis({ createdByUserId: USER_ID, generatedByInferenceId: `call-${call}`, personId: PERSON_ID, projectId: PROJECT_ID, explanation: 'x', supportingFactsSummary: 'x', confidence: 'LOW' });
    }
    prisma._seedFact({ personId: PERSON_ID, content: 'x' });
    const svc = new MotiveAnalysisService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.analyze(USER_ID, PROJECT_ID, PERSON_ID), ForbiddenException, 'analyze() при достижении дневного лимита (10 различных анализов)');
  });

  test('list() возвращает гипотезы для персоны и проекта', async () => {
    const prisma = createFakePrisma();
    seedProjectWithPerson(prisma);
    prisma._seedHypothesis({ personId: PERSON_ID, projectId: PROJECT_ID, createdByUserId: USER_ID, explanation: 'x', supportingFactsSummary: 'x', confidence: 'LOW' });
    const svc = new MotiveAnalysisService(prisma as any, new FakeAIRouterService() as any);

    const list = await svc.list(USER_ID, PROJECT_ID, PERSON_ID);
    assertEqual(list.length, 1, 'гипотеза видна');
  });

  test('list() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new MotiveAnalysisService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.list(USER_ID, PROJECT_ID, PERSON_ID), NotFoundException, 'list() на чужой проект');
  });

  // ── Пункт 74: suggestsFigurantStatus (§3.38 ТЗ) ──

  test('КЛЮЧЕВОЙ ТЕСТ: analyze() честно проставляет suggestsFigurantStatus=false, если AI не вернул это поле вообще', async () => {
    const prisma = createFakePrisma();
    seedProjectWithPerson(prisma);
    prisma._seedFact({ personId: PERSON_ID, content: 'x' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { explanation: 'Обычная гипотеза без конфликта', supportingFactsSummary: 'x', confidence: 'LOW' },
    ]);
    const svc = new MotiveAnalysisService(prisma as any, fakeRouter as any);

    const created = await svc.analyze(USER_ID, PROJECT_ID, PERSON_ID);
    assertEqual(created[0].suggestsFigurantStatus, false, 'по умолчанию false — не подставляется true без явного указания AI');
  });

  test('analyze() сохраняет suggestsFigurantStatus=true, когда AI явно его вернул', async () => {
    const prisma = createFakePrisma();
    seedProjectWithPerson(prisma);
    prisma._seedFact({ personId: PERSON_ID, content: 'x' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      {
        explanation: 'Мотив прямо противоречит цели пользователя',
        supportingFactsSummary: 'x',
        confidence: 'HIGH',
        suggestsFigurantStatus: true,
      },
    ]);
    const svc = new MotiveAnalysisService(prisma as any, fakeRouter as any);

    const created = await svc.analyze(USER_ID, PROJECT_ID, PERSON_ID);
    assertEqual(created[0].suggestsFigurantStatus, true, 'явное true от AI сохранено, не отброшено');
  });

  test('analyze() требует от AI явного true — не подставляет true просто из-за наличия поля со значением false', async () => {
    const prisma = createFakePrisma();
    seedProjectWithPerson(prisma);
    prisma._seedFact({ personId: PERSON_ID, content: 'x' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { explanation: 'x', supportingFactsSummary: 'x', confidence: 'LOW', suggestsFigurantStatus: false },
    ]);
    const svc = new MotiveAnalysisService(prisma as any, fakeRouter as any);

    const created = await svc.analyze(USER_ID, PROJECT_ID, PERSON_ID);
    assertEqual(created[0].suggestsFigurantStatus, false, 'явное false сохранено как false, не искажено');
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
  console.log(`\nMotiveAnalysisService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

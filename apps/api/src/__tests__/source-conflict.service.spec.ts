import { SourceConflictService } from '../source-conflict/source-conflict.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const people = new Map<string, any>();
  const facts = new Map<string, any>();
  const conflicts: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedFact(f: any) { facts.set(f.id, f); },
    _getConflicts() { return conflicts; },

    person: {
      findFirst: async ({ where }: any) => {
        const p = people.get(where.id);
        if (!p || p.createdByUserId !== where.createdByUserId) return null;
        return p;
      },
    },
    personFact: {
      findMany: async ({ where }: any) =>
        [...facts.values()].filter((f) => f.personId === where.personId && f.status !== 'EXPIRED'),
    },
    promptVersion: {
      findFirst: async () => null,
    },
    sourceConflict: {
      create: async ({ data }: any) => {
        const c = { id: nextId(), resolvedAt: null, createdAt: new Date(), ...data };
        conflicts.push(c);
        return c;
      },
      findMany: async ({ where }: any) => conflicts.filter((c) => c.personId === where.personId),
      findUnique: async ({ where }: any) => {
        const c = conflicts.find((c) => c.id === where.id);
        if (!c) return null;
        return { ...c, person: people.get(c.personId) };
      },
      update: async ({ where, data }: any) => {
        const idx = conflicts.findIndex((c) => c.id === where.id);
        conflicts[idx] = { ...conflicts[idx], ...data };
        return conflicts[idx];
      },
    },
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
const PERSON_ID = 'person-1';

function seedPersonWithTwoFacts(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
  prisma._seedFact({ id: 'fact-1', personId: PERSON_ID, status: 'ACTIVE', sourceType: 'PUBLIC_FACT', content: 'Работает в компании X с 2020 года.' });
  prisma._seedFact({ id: 'fact-2', personId: PERSON_ID, status: 'ACTIVE', sourceType: 'PERSONAL_RECORD', content: 'Говорил, что уволился из компании X в 2022.' });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('detect() бросает NotFoundException для чужой персоны', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: 'other-user' });
    const svc = new SourceConflictService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.detect(USER_ID, PERSON_ID), NotFoundException, 'detect() на чужую персону');
  });

  test('detect() бросает BadRequestException, если фактов меньше двух', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    prisma._seedFact({ id: 'fact-1', personId: PERSON_ID, status: 'ACTIVE', sourceType: 'PUBLIC_FACT', content: 'x' });
    const svc = new SourceConflictService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.detect(USER_ID, PERSON_ID), BadRequestException, 'detect() с одним фактом');
  });

  test('detect() исключает EXPIRED факты из сравнения', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    prisma._seedFact({ id: 'fact-1', personId: PERSON_ID, status: 'ACTIVE', sourceType: 'PUBLIC_FACT', content: 'x' });
    prisma._seedFact({ id: 'fact-2', personId: PERSON_ID, status: 'EXPIRED', sourceType: 'PUBLIC_FACT', content: 'y' });
    const svc = new SourceConflictService(prisma as any, new FakeAIRouterService() as any);
    // Активных фактов после фильтра EXPIRED — только 1, должно упасть
    await assertThrowsAsync(() => svc.detect(USER_ID, PERSON_ID), BadRequestException, 'detect() с одним активным фактом (EXPIRED исключён)');
  });

  test('detect() создаёт SourceConflict с 3 полями из ответа AI', async () => {
    const prisma = createFakePrisma();
    seedPersonWithTwoFacts(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      {
        factAId: 'fact-1',
        factBId: 'fact-2',
        conflictDescription: 'Один факт говорит, что человек всё ещё работает в X, другой — что уволился.',
        possibleExplanations: ['Второй факт мог устареть', 'Первый источник мог не знать об увольнении'],
        clarifyingQuestion: 'Работает ли человек в компании X сейчас?',
      },
    ]);
    const svc = new SourceConflictService(prisma as any, fakeRouter as any);

    const created = await svc.detect(USER_ID, PERSON_ID);
    assertEqual(created.length, 1, 'количество созданных конфликтов');
    assertEqual(created[0].factAId, 'fact-1', 'factAId сохранён');
    assertEqual(created[0].factBId, 'fact-2', 'factBId сохранён');
    assertEqual(
      created[0].possibleExplanations,
      ['Второй факт мог устареть', 'Первый источник мог не знать об увольнении'],
      'possibleExplanations сохранён как список',
    );
    assertEqual(created[0].resolvedAt, null, 'новый конфликт не разрешён по умолчанию');
  });

  test('detect() пропускает конфликт со ссылкой на несуществующий factId, не падает целиком', async () => {
    const prisma = createFakePrisma();
    seedPersonWithTwoFacts(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { factAId: 'fact-does-not-exist', factBId: 'fact-2', conflictDescription: 'x', possibleExplanations: [], clarifyingQuestion: 'y' },
      { factAId: 'fact-1', factBId: 'fact-2', conflictDescription: 'реальный конфликт', possibleExplanations: [], clarifyingQuestion: 'z' },
    ]);
    const svc = new SourceConflictService(prisma as any, fakeRouter as any);

    const created = await svc.detect(USER_ID, PERSON_ID);
    assertEqual(created.length, 1, 'только валидный конфликт создан, невалидный пропущен без падения');
  });

  test('detect() пропускает "конфликт" факта самого с собой', async () => {
    const prisma = createFakePrisma();
    seedPersonWithTwoFacts(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { factAId: 'fact-1', factBId: 'fact-1', conflictDescription: 'x', possibleExplanations: [], clarifyingQuestion: 'y' },
    ]);
    const svc = new SourceConflictService(prisma as any, fakeRouter as any);

    const created = await svc.detect(USER_ID, PERSON_ID);
    assertEqual(created.length, 0, 'факт не может конфликтовать сам с собой');
  });

  test('detect() НЕ передаёт projectId в AIRouterService (не привязан к одному проекту)', async () => {
    const prisma = createFakePrisma();
    seedPersonWithTwoFacts(prisma);
    const fakeRouter = new FakeAIRouterService();
    const svc = new SourceConflictService(prisma as any, fakeRouter as any);
    await svc.detect(USER_ID, PERSON_ID);
    assertEqual(fakeRouter.lastRequest.projectId, undefined, 'projectId не передан (глобальное согласие, не project-scoped)');
  });

  test('list() возвращает конфликты персоны с включёнными фактами', async () => {
    const prisma = createFakePrisma();
    seedPersonWithTwoFacts(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { factAId: 'fact-1', factBId: 'fact-2', conflictDescription: 'x', possibleExplanations: [], clarifyingQuestion: 'y' },
    ]);
    const svc = new SourceConflictService(prisma as any, fakeRouter as any);
    await svc.detect(USER_ID, PERSON_ID);

    const list = await svc.list(USER_ID, PERSON_ID);
    assertEqual(list.length, 1, 'количество в list()');
  });

  // Пункт 32 (расширенный аудит тестов) — ветка BadGatewayException в
  // detect() не тестировалась ни разу.
  test('detect() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedPersonWithTwoFacts(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.execute = async () => { throw new Error('provider timeout'); };
    const svc = new SourceConflictService(prisma as any, fakeRouter as any);
    await assertThrowsAsync(
      () => svc.detect(USER_ID, PERSON_ID),
      BadGatewayException,
      'detect() при недоступности провайдера',
    );
  });

  test('markResolved() ставит resolvedAt, не трогая ни один PersonFact', async () => {
    const prisma = createFakePrisma();
    seedPersonWithTwoFacts(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { factAId: 'fact-1', factBId: 'fact-2', conflictDescription: 'x', possibleExplanations: [], clarifyingQuestion: 'y' },
    ]);
    const svc = new SourceConflictService(prisma as any, fakeRouter as any);
    const [created] = await svc.detect(USER_ID, PERSON_ID);

    const resolved = await svc.markResolved(USER_ID, created.id);
    assertEqual(resolved.resolvedAt !== null, true, 'resolvedAt проставлен');
    // Факты остаются как были — сервис их вообще не трогает
    const facts = await prisma.personFact.findMany({ where: { personId: PERSON_ID } });
    assertEqual(facts.length, 2, 'оба факта остались нетронутыми');
  });

  test('markResolved() бросает NotFoundException на чужой конфликт', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: 'other-user' });
    prisma._seedFact({ id: 'fact-1', personId: PERSON_ID, status: 'ACTIVE', sourceType: 'PUBLIC_FACT', content: 'x' });
    prisma._seedFact({ id: 'fact-2', personId: PERSON_ID, status: 'ACTIVE', sourceType: 'PUBLIC_FACT', content: 'y' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { factAId: 'fact-1', factBId: 'fact-2', conflictDescription: 'x', possibleExplanations: [], clarifyingQuestion: 'y' },
    ]);
    const svc = new SourceConflictService(prisma as any, fakeRouter as any);
    const [created] = await svc.detect('other-user', PERSON_ID);

    await assertThrowsAsync(
      () => svc.markResolved(USER_ID, created.id),
      NotFoundException,
      'markResolved() на чужой конфликт',
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
  console.log(`\nSourceConflictService: ${results.length - failed.length}/${results.length} passed\n`);
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

import { PersonFactsService } from '../person-facts/person-facts.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const people = new Map<string, any>();
  const projects = new Map<string, any>();
  const facts: any[] = [];
  const sources: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedProject(p: any) { projects.set(p.id, p); },
    _getFacts() { return facts; },
    _getSources() { return sources; },

    person: {
      findFirst: async ({ where }: any) => {
        const p = people.get(where.id);
        if (!p || p.createdByUserId !== where.createdByUserId) return null;
        return p;
      },
    },
    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    personFact: {
      create: async ({ data }: any) => {
        const f = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        facts.push(f);
        return f;
      },
      findUnique: async ({ where, include }: any) => {
        const f = facts.find((x) => x.id === where.id);
        if (!f) return null;
        if (include?.sources) return { ...f, sources: sources.filter((s) => s.personFactId === f.id) };
        return f;
      },
      findMany: async ({ where, include }: any) => {
        let result = facts.filter((f) => f.personId === where.personId);
        if (include?.sources) {
          result = result.map((f) => ({ ...f, sources: sources.filter((s) => s.personFactId === f.id) }));
        }
        return [...result].sort((a, b) => b.createdAt - a.createdAt);
      },
    },
    factSource: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), createdAt: new Date(), ...data };
        sources.push(s);
        return s;
      },
    },
  };
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
const PERSON_ID = 'person-1';
const PROJECT_ID = 'proj-1';

function seedPerson(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('create() бросает NotFoundException для чужой персоны', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: 'other-user' });
    const svc = new PersonFactsService(prisma as any);
    await assertThrowsAsync(
      () => svc.create(USER_ID, PERSON_ID, { content: 'x', sourceType: 'USER_GUESS' as any, projectId: PROJECT_ID }),
      NotFoundException,
      'create() на чужую персону',
    );
  });

  test('create() бросает BadRequestException для пустого content', async () => {
    const prisma = createFakePrisma();
    seedPerson(prisma);
    const svc = new PersonFactsService(prisma as any);
    await assertThrowsAsync(
      () => svc.create(USER_ID, PERSON_ID, { content: '   ', sourceType: 'USER_GUESS' as any, projectId: PROJECT_ID }),
      BadRequestException,
      'create() с пустым content',
    );
  });

  test('create() бросает BadRequestException, если scope=PROJECT без projectId', async () => {
    const prisma = createFakePrisma();
    seedPerson(prisma);
    const svc = new PersonFactsService(prisma as any);
    await assertThrowsAsync(
      () => svc.create(USER_ID, PERSON_ID, { content: 'x', sourceType: 'USER_GUESS' as any }),
      BadRequestException,
      'create() scope=PROJECT без projectId',
    );
  });

  test('create() бросает BadRequestException, если projectId указан для НЕ-PROJECT scope', async () => {
    const prisma = createFakePrisma();
    seedPerson(prisma);
    const svc = new PersonFactsService(prisma as any);
    await assertThrowsAsync(
      () => svc.create(USER_ID, PERSON_ID, { content: 'x', sourceType: 'USER_GUESS' as any, scope: 'PERSON_GLOBAL' as any, projectId: PROJECT_ID }),
      BadRequestException,
      'create() projectId для PERSON_GLOBAL',
    );
  });

  test('create() бросает NotFoundException для чужого projectId', async () => {
    const prisma = createFakePrisma();
    seedPerson(prisma);
    prisma._seedProject({ id: 'other-proj', ownerId: 'other-user' });
    const svc = new PersonFactsService(prisma as any);
    await assertThrowsAsync(
      () => svc.create(USER_ID, PERSON_ID, { content: 'x', sourceType: 'USER_GUESS' as any, projectId: 'other-proj' }),
      NotFoundException,
      'create() с чужим projectId',
    );
  });

  test('create() успешно создаёт факт с scope=PROJECT и projectId', async () => {
    const prisma = createFakePrisma();
    seedPerson(prisma);
    const svc = new PersonFactsService(prisma as any);

    const fact = await svc.create(USER_ID, PERSON_ID, { content: 'Работает в банке', sourceType: 'PERSONAL_RECORD' as any, projectId: PROJECT_ID });
    assertEqual(fact!.content, 'Работает в банке', 'содержимое сохранено');
    assertEqual(fact!.scope, 'PROJECT', 'scope по умолчанию PROJECT');
  });

  test('create() успешно создаёт факт с scope=PERSON_GLOBAL без projectId', async () => {
    const prisma = createFakePrisma();
    seedPerson(prisma);
    const svc = new PersonFactsService(prisma as any);

    const fact = await svc.create(USER_ID, PERSON_ID, { content: 'x', sourceType: 'USER_GUESS' as any, scope: 'PERSON_GLOBAL' as any });
    assertEqual(fact!.projectId, null, 'projectId не проставлен для PERSON_GLOBAL');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: create() сохраняет hasGeoTag/metadataStripped, вычисленные на клиенте, не пересчитывает их сама', async () => {
    const prisma = createFakePrisma();
    seedPerson(prisma);
    const svc = new PersonFactsService(prisma as any);

    const fact = await svc.create(USER_ID, PERSON_ID, {
      content: 'Скриншот переписки',
      sourceType: 'PERSONAL_RECORD' as any,
      projectId: PROJECT_ID,
      source: { fileRef: 'local-file-123', hasGeoTag: true, metadataStripped: false },
    });
    assertEqual(fact!.sources[0].hasGeoTag, true, 'hasGeoTag сохранён как есть, пришёл от клиента');
    assertEqual(fact!.sources[0].metadataStripped, false, 'metadataStripped сохранён как есть');
  });

  test('create() без source не создаёт FactSource вообще', async () => {
    const prisma = createFakePrisma();
    seedPerson(prisma);
    const svc = new PersonFactsService(prisma as any);

    await svc.create(USER_ID, PERSON_ID, { content: 'x', sourceType: 'USER_GUESS' as any, projectId: PROJECT_ID });
    assertEqual(prisma._getSources().length, 0, 'источник не создан, если source не передан');
  });

  test('listForPerson() бросает NotFoundException для чужой персоны', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: 'other-user' });
    const svc = new PersonFactsService(prisma as any);
    await assertThrowsAsync(() => svc.listForPerson(USER_ID, PERSON_ID), NotFoundException, 'listForPerson() на чужую персону');
  });

  test('listForPerson() возвращает факты с источниками', async () => {
    const prisma = createFakePrisma();
    seedPerson(prisma);
    const svc = new PersonFactsService(prisma as any);
    await svc.create(USER_ID, PERSON_ID, {
      content: 'x',
      sourceType: 'PERSONAL_RECORD' as any,
      projectId: PROJECT_ID,
      source: { url: 'https://example.com/doc' },
    });

    const list = await svc.listForPerson(USER_ID, PERSON_ID);
    assertEqual(list.length, 1, 'один факт виден');
    assertEqual(list[0].sources.length, 1, 'источник включён в ответ');
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
  console.log(`\nPersonFactsService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

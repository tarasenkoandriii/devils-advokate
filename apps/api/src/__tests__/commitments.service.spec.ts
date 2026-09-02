import { CommitmentsService } from '../commitments/commitments.service';
import { NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const people = new Map<string, any>();
  const commitments = new Map<string, any>();
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedPerson(p: any) { people.set(p.id, p); },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    person: {
      findFirst: async ({ where }: any) => {
        const p = people.get(where.id);
        if (!p || p.createdByUserId !== where.createdByUserId) return null;
        return p;
      },
    },
    commitment: {
      create: async ({ data }: any) => {
        const c = {
          id: nextId(), createdAt: new Date(), updatedAt: new Date(),
          status: 'IN_PROGRESS', completedAt: null, dueDate: null,
          ...data,
        };
        commitments.set(c.id, c);
        return c;
      },
      findMany: async ({ where }: any) =>
        [...commitments.values()].filter((c) =>
          (where.projectId ? c.projectId === where.projectId : true) &&
          (where.personId ? c.personId === where.personId : true),
        ),
      findUnique: async ({ where, include }: any) => {
        const c = commitments.get(where.id);
        if (!c) return null;
        if (include?.project) return { ...c, project: projects.get(c.projectId) };
        return c;
      },
      update: async ({ where, data }: any) => {
        const merged = { ...commitments.get(where.id), ...data };
        commitments.set(where.id, merged);
        return merged;
      },
    },
  };
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
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('create() создаёт Commitment со статусом IN_PROGRESS', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    const svc = new CommitmentsService(prisma as any);
    const c = await svc.create(USER_ID, PROJECT_ID, {
      personId: PERSON_ID, owner: 'FIGURANT' as any, description: 'Пришлёт документы до пятницы',
    });
    assertEqual(c.status, 'IN_PROGRESS', 'статус нового обязательства');
    assertEqual(c.isOverdue, false, 'isOverdue без dueDate');
  });

  test('create() бросает NotFoundException для чужой персоны', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: 'other-user' });
    const svc = new CommitmentsService(prisma as any);
    await assertThrowsAsync(
      () => svc.create(USER_ID, PROJECT_ID, { personId: PERSON_ID, owner: 'USER' as any, description: 'x' }),
      NotFoundException,
      'create() с чужой персоной',
    );
  });

  test('isOverdue=true для просроченного IN_PROGRESS обязательства', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    const svc = new CommitmentsService(prisma as any);
    const past = new Date(Date.now() - 86400000).toISOString(); // вчера
    const c = await svc.create(USER_ID, PROJECT_ID, {
      personId: PERSON_ID, owner: 'FIGURANT' as any, description: 'Просроченное', dueDate: past,
    });
    assertEqual(c.isOverdue, true, 'isOverdue для прошедшего dueDate');
  });

  test('isOverdue=false для будущего dueDate', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    const svc = new CommitmentsService(prisma as any);
    const future = new Date(Date.now() + 86400000).toISOString(); // завтра
    const c = await svc.create(USER_ID, PROJECT_ID, {
      personId: PERSON_ID, owner: 'USER' as any, description: 'Будущее', dueDate: future,
    });
    assertEqual(c.isOverdue, false, 'isOverdue для будущего dueDate');
  });

  test('update(status=COMPLETED) снимает isOverdue даже с прошедшим dueDate', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    const svc = new CommitmentsService(prisma as any);
    const past = new Date(Date.now() - 86400000).toISOString();
    const c = await svc.create(USER_ID, PROJECT_ID, {
      personId: PERSON_ID, owner: 'FIGURANT' as any, description: 'x', dueDate: past,
    });
    const updated = await svc.update(USER_ID, c.id, { status: 'COMPLETED' as any });
    assertEqual(updated.isOverdue, false, 'isOverdue после завершения просроченного обязательства');
    assertEqual(updated.completedAt !== null, true, 'completedAt проставлен при завершении');
  });

  test('update(status=IN_PROGRESS) обратно снимает completedAt', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    const svc = new CommitmentsService(prisma as any);
    const c = await svc.create(USER_ID, PROJECT_ID, { personId: PERSON_ID, owner: 'USER' as any, description: 'x' });
    await svc.update(USER_ID, c.id, { status: 'COMPLETED' as any });
    const reopened = await svc.update(USER_ID, c.id, { status: 'IN_PROGRESS' as any });
    assertEqual(reopened.completedAt, null, 'completedAt снят при возврате в IN_PROGRESS');
  });

  test('update() бросает NotFoundException на чужое обязательство', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: 'other-user' });
    const svc = new CommitmentsService(prisma as any);
    const c = await svc.create('other-user', PROJECT_ID, { personId: PERSON_ID, owner: 'USER' as any, description: 'x' });
    await assertThrowsAsync(
      () => svc.update(USER_ID, c.id, { status: 'COMPLETED' as any }),
      NotFoundException,
      'update() на чужое обязательство',
    );
  });

  test('listByPerson() возвращает обязательства по всем проектам этого фигуранта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-a', ownerId: USER_ID });
    prisma._seedProject({ id: 'proj-b', ownerId: USER_ID });
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    const svc = new CommitmentsService(prisma as any);
    await svc.create(USER_ID, 'proj-a', { personId: PERSON_ID, owner: 'USER' as any, description: 'A' });
    await svc.create(USER_ID, 'proj-b', { personId: PERSON_ID, owner: 'FIGURANT' as any, description: 'B' });
    const list = await svc.listByPerson(USER_ID, PERSON_ID);
    assertEqual(list.length, 2, 'количество обязательств по фигуранту сразу по двум проектам');
  });

  test('listByProject() возвращает только обязательства этого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-a', ownerId: USER_ID });
    prisma._seedProject({ id: 'proj-b', ownerId: USER_ID });
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    const svc = new CommitmentsService(prisma as any);
    await svc.create(USER_ID, 'proj-a', { personId: PERSON_ID, owner: 'USER' as any, description: 'A' });
    await svc.create(USER_ID, 'proj-b', { personId: PERSON_ID, owner: 'FIGURANT' as any, description: 'B' });
    const list = await svc.listByProject(USER_ID, 'proj-a');
    assertEqual(list.length, 1, 'количество обязательств только в proj-a');
    assertEqual(list[0].description, 'A', 'правильное обязательство вернулось');
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
  console.log(`\nCommitmentsService: ${results.length - failed.length}/${results.length} passed\n`);
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

import { StaleFactService } from '../stale-fact/stale-fact.service';

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function createFakePrisma() {
  const projects = new Map<string, any>();
  const people = new Map<string, any>();
  const projectPeople: any[] = [];
  const facts: any[] = [];

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedProjectPerson(pp: any) { projectPeople.push(pp); },
    _seedFact(f: any) { facts.push(f); },

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
    projectPerson: {
      findMany: async ({ where }: any) =>
        projectPeople
          .filter((pp) => pp.projectId === where.projectId)
          .map((pp) => ({ personId: pp.personId, person: { displayName: people.get(pp.personId)?.displayName ?? null } })),
    },
    personFact: {
      findMany: async ({ where }: any) => {
        let result = facts;
        if (where.personId?.in) result = result.filter((f) => where.personId.in.includes(f.personId));
        if (where.personId && typeof where.personId === 'string') result = result.filter((f) => f.personId === where.personId);
        result = result.filter((f) => f.status !== 'EXPIRED');
        return result;
      },
    },
  };
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';
const PERSON_ID = 'person-1';

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('listForProject() возвращает факт старше 365 дней', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID, displayName: 'Иван' });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_ID });
    prisma._seedFact({ id: 'fact-1', personId: PERSON_ID, status: 'ACTIVE', content: 'Старый факт', lastVerifiedAt: daysAgo(400), createdAt: daysAgo(400) });
    const svc = new StaleFactService(prisma as any);

    const stale = await svc.listForProject(USER_ID, PROJECT_ID);
    assertEqual(stale.length, 1, 'факт старше порога найден');
    assertEqual(stale[0].personDisplayName, 'Иван', 'имя фигуранта подставлено');
    assertEqual(stale[0].ageInDays > 365, true, 'ageInDays посчитан корректно');
  });

  test('listForProject() НЕ возвращает факт младше 365 дней', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID, displayName: 'Иван' });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_ID });
    prisma._seedFact({ id: 'fact-1', personId: PERSON_ID, status: 'ACTIVE', content: 'Свежий факт', lastVerifiedAt: daysAgo(30), createdAt: daysAgo(30) });
    const svc = new StaleFactService(prisma as any);

    const stale = await svc.listForProject(USER_ID, PROJECT_ID);
    assertEqual(stale.length, 0, 'свежий факт не попадает в список устаревших');
  });

  test('listForProject() исключает EXPIRED факты', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID, displayName: 'Иван' });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_ID });
    prisma._seedFact({ id: 'fact-1', personId: PERSON_ID, status: 'EXPIRED', content: 'Старый и уже помеченный устаревшим формально', lastVerifiedAt: daysAgo(500), createdAt: daysAgo(500) });
    const svc = new StaleFactService(prisma as any);

    const stale = await svc.listForProject(USER_ID, PROJECT_ID);
    assertEqual(stale.length, 0, 'EXPIRED факт не дублируется в списке устаревших (уже своя категория)');
  });

  test('listForProject() агрегирует по НЕСКОЛЬКИМ фигурантам проекта разом', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedPerson({ id: 'person-a', createdByUserId: USER_ID, displayName: 'А' });
    prisma._seedPerson({ id: 'person-b', createdByUserId: USER_ID, displayName: 'Б' });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: 'person-a' });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: 'person-b' });
    prisma._seedFact({ id: 'fact-a', personId: 'person-a', status: 'ACTIVE', content: 'x', lastVerifiedAt: daysAgo(400), createdAt: daysAgo(400) });
    prisma._seedFact({ id: 'fact-b', personId: 'person-b', status: 'ACTIVE', content: 'y', lastVerifiedAt: daysAgo(500), createdAt: daysAgo(500) });
    const svc = new StaleFactService(prisma as any);

    const stale = await svc.listForProject(USER_ID, PROJECT_ID);
    assertEqual(stale.length, 2, 'устаревшие факты обоих фигурантов проекта найдены');
  });

  test('listForProject() сортирует по убыванию возраста (самые старые первыми)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID, displayName: 'Иван' });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_ID });
    prisma._seedFact({ id: 'fact-newer', personId: PERSON_ID, status: 'ACTIVE', content: 'Менее старый', lastVerifiedAt: daysAgo(370), createdAt: daysAgo(370) });
    prisma._seedFact({ id: 'fact-older', personId: PERSON_ID, status: 'ACTIVE', content: 'Более старый', lastVerifiedAt: daysAgo(700), createdAt: daysAgo(700) });
    const svc = new StaleFactService(prisma as any);

    const stale = await svc.listForProject(USER_ID, PROJECT_ID);
    assertEqual(stale[0].id, 'fact-older', 'самый старый факт идёт первым');
    assertEqual(stale[1].id, 'fact-newer', 'менее старый факт идёт вторым');
  });

  test('listForProject() возвращает пустой список, если у проекта нет фигурантов', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const svc = new StaleFactService(prisma as any);
    const stale = await svc.listForProject(USER_ID, PROJECT_ID);
    assertEqual(stale, [], 'пустой список, если фигурантов нет вообще');
  });

  test('listByPerson() работает для одного конкретного фигуранта', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID, displayName: 'Иван' });
    prisma._seedFact({ id: 'fact-1', personId: PERSON_ID, status: 'ACTIVE', content: 'Старый факт', lastVerifiedAt: daysAgo(400), createdAt: daysAgo(400) });
    const svc = new StaleFactService(prisma as any);

    const stale = await svc.listByPerson(USER_ID, PERSON_ID);
    assertEqual(stale.length, 1, 'listByPerson находит устаревший факт');
  });

  test('listByPerson() возвращает пустой список для чужой персоны (не бросает исключение)', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: 'other-user', displayName: 'Иван' });
    const svc = new StaleFactService(prisma as any);
    const stale = await svc.listByPerson(USER_ID, PERSON_ID);
    assertEqual(stale, [], 'чужая персона — пустой список, не ошибка (read-only агрегация)');
  });

  test('lastVerifiedAt=null использует createdAt как базовую дату (тот же fallback, что Evidence Gap)', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID, displayName: 'Иван' });
    prisma._seedFact({ id: 'fact-1', personId: PERSON_ID, status: 'ACTIVE', content: 'Факт без lastVerifiedAt', lastVerifiedAt: null, createdAt: daysAgo(400) });
    const svc = new StaleFactService(prisma as any);

    const stale = await svc.listByPerson(USER_ID, PERSON_ID);
    assertEqual(stale.length, 1, 'факт без lastVerifiedAt всё равно оценивается по createdAt');
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
  console.log(`\nStaleFactService: ${results.length - failed.length}/${results.length} passed\n`);
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

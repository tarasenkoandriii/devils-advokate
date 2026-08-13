import { LibraryService } from '../library/library.service';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const users = new Map<string, any>();
  const argumentsStore: any[] = [];
  const entries: any[] = [];
  const libraryArguments: any[] = [];
  const experiences: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedUser(u: any) { users.set(u.id, { isLibraryModerator: false, ...u }); },
    _seedArgument(a: any) { argumentsStore.push(a); },
    _seedEntry(e: any) { entries.push({ id: e.id ?? nextId(), status: 'PENDING', upvotes: 0, downvotes: 0, createdAt: new Date(), ...e }); },
    _getEntries() { return entries; },
    _getLibraryArguments() { return libraryArguments; },
    _getExperiences() { return experiences; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
    },
    argument: {
      findMany: async ({ where }: any) =>
        argumentsStore.filter(
          (a) =>
            a.projectId === where.projectId &&
            (where.targetPersonId === undefined ? true : a.targetPersonId === null) &&
            (where.stance?.in ? where.stance.in.includes(a.stance) : true),
        ),
    },
    libraryEntry: {
      findFirst: async ({ where }: any) => {
        let result = entries.filter((e) => {
          if (where.sourceProjectId !== undefined && e.sourceProjectId !== where.sourceProjectId) return false;
          if (where.id !== undefined && e.id !== where.id) return false;
          if (where.status !== undefined && e.status !== where.status) return false;
          return true;
        });
        return result[0] ?? null;
      },
      findUnique: async ({ where }: any) => entries.find((e) => e.id === where.id) ?? null,
      findMany: async ({ where }: any) => {
        let result = entries;
        if (where?.status !== undefined) result = result.filter((e) => e.status === where.status);
        if (where?.category !== undefined) result = result.filter((e) => e.category === where.category);
        return [...result].sort((a, b) => b.upvotes - a.upvotes);
      },
      create: async ({ data }: any) => {
        const e = { id: nextId(), status: 'PENDING', upvotes: 0, downvotes: 0, createdAt: new Date(), ...data };
        entries.push(e);
        return e;
      },
      update: async ({ where, data }: any) => {
        const idx = entries.findIndex((e) => e.id === where.id);
        entries[idx] = { ...entries[idx], ...data };
        return entries[idx];
      },
    },
    libraryArgument: {
      create: async ({ data }: any) => {
        const a = { id: nextId(), ...data };
        libraryArguments.push(a);
        return a;
      },
    },
    libraryExperience: {
      create: async ({ data }: any) => {
        const e = { id: nextId(), createdAt: new Date(), ...data };
        experiences.push(e);
        return e;
      },
    },
    $transaction: async (ops: Promise<any>[]) => Promise.all(ops),
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
const MODERATOR_ID = 'moderator-1';
const PROJECT_ID = 'proj-1';

function seedProject(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Стоит ли переезжать в другой город?' });
  prisma._seedUser({ id: USER_ID });
  prisma._seedUser({ id: MODERATOR_ID, isLibraryModerator: true });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('submitProject() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new LibraryService(prisma as any);
    await assertThrowsAsync(() => svc.submitProject(USER_ID, PROJECT_ID, 'Заголовок', 'Категория'), NotFoundException, 'submitProject() на чужой проект');
  });

  test('submitProject() бросает BadRequestException для пустого title/category', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new LibraryService(prisma as any);
    await assertThrowsAsync(() => svc.submitProject(USER_ID, PROJECT_ID, '  ', 'Категория'), BadRequestException, 'submitProject() с пустым title');
  });

  test('submitProject() бросает BadRequestException, если в проекте нет общих аргументов', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new LibraryService(prisma as any);
    await assertThrowsAsync(() => svc.submitProject(USER_ID, PROJECT_ID, 'Заголовок', 'Переезд'), BadRequestException, 'submitProject() без аргументов');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: submitProject() копирует только общие PRO/CON аргументы (не адресные, не RECONCILIATION), снапшотом', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ projectId: PROJECT_ID, text: 'Общий аргумент за', stance: 'PRO', targetPersonId: null });
    prisma._seedArgument({ projectId: PROJECT_ID, text: 'Адресный аргумент', stance: 'PRO', targetPersonId: 'person-1' });
    prisma._seedArgument({ projectId: PROJECT_ID, text: 'Религиозный аргумент', stance: 'RECONCILIATION', targetPersonId: null });
    const svc = new LibraryService(prisma as any);

    await svc.submitProject(USER_ID, PROJECT_ID, 'Переезд в другой город', 'Переезд');
    assertEqual(prisma._getLibraryArguments().length, 1, 'скопирован только один — общий PRO/CON');
    assertEqual(prisma._getLibraryArguments()[0].text, 'Общий аргумент за', 'именно общий аргумент');
  });

  test('submitProject() бросает BadRequestException при повторной отправке того же проекта', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ projectId: PROJECT_ID, text: 'x', stance: 'PRO', targetPersonId: null });
    const svc = new LibraryService(prisma as any);
    await svc.submitProject(USER_ID, PROJECT_ID, 'Заголовок', 'Категория');
    await assertThrowsAsync(() => svc.submitProject(USER_ID, PROJECT_ID, 'Другой заголовок', 'Другая категория'), BadRequestException, 'submitProject() повторно для того же проекта');
  });

  test('listPendingForModeration() бросает ForbiddenException для НЕ-модератора', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new LibraryService(prisma as any);
    await assertThrowsAsync(() => svc.listPendingForModeration(USER_ID), ForbiddenException, 'listPendingForModeration() без роли модератора');
  });

  test('listPendingForModeration() работает для модератора', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedEntry({ status: 'PENDING', title: 'x', category: 'y', sourceProjectId: PROJECT_ID, submittedByUserId: USER_ID });
    const svc = new LibraryService(prisma as any);

    const pending = await svc.listPendingForModeration(MODERATOR_ID);
    assertEqual(pending.length, 1, 'модератор видит заявку на модерации');
  });

  test('moderate() бросает ForbiddenException для НЕ-модератора', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedEntry({ status: 'PENDING' });
    const [entry] = prisma._getEntries();
    const svc = new LibraryService(prisma as any);
    await assertThrowsAsync(() => svc.moderate(USER_ID, entry.id, 'ACCEPT'), ForbiddenException, 'moderate() без роли модератора');
  });

  test('moderate() ACCEPT переводит запись в статус ACCEPTED', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedEntry({ status: 'PENDING' });
    const [entry] = prisma._getEntries();
    const svc = new LibraryService(prisma as any);

    const updated = await svc.moderate(MODERATOR_ID, entry.id, 'ACCEPT');
    assertEqual(updated.status, 'ACCEPTED', 'статус изменён модератором');
  });

  test('moderate() бросает BadRequestException при повторной модерации', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedEntry({ status: 'ACCEPTED' });
    const [entry] = prisma._getEntries();
    const svc = new LibraryService(prisma as any);
    await assertThrowsAsync(() => svc.moderate(MODERATOR_ID, entry.id, 'REJECT'), BadRequestException, 'moderate() на уже обработанную запись');
  });

  test('browse() возвращает только ACCEPTED записи', async () => {
    const prisma = createFakePrisma();
    prisma._seedEntry({ status: 'ACCEPTED', category: 'Переезд' });
    prisma._seedEntry({ status: 'PENDING', category: 'Переезд' });
    const svc = new LibraryService(prisma as any);

    const list = await svc.browse();
    assertEqual(list.length, 1, 'только принятая запись видна публично');
  });

  test('getEntry() бросает NotFoundException для ещё не принятой записи', async () => {
    const prisma = createFakePrisma();
    prisma._seedEntry({ status: 'PENDING' });
    const [entry] = prisma._getEntries();
    const svc = new LibraryService(prisma as any);
    await assertThrowsAsync(() => svc.getEntry(entry.id), NotFoundException, 'getEntry() на непринятую запись — не публикуется преждевременно');
  });

  test('vote() увеличивает счётчик только для ACCEPTED записи', async () => {
    const prisma = createFakePrisma();
    prisma._seedEntry({ status: 'ACCEPTED' });
    const [entry] = prisma._getEntries();
    const svc = new LibraryService(prisma as any);

    const voted = await svc.vote(entry.id, 'up');
    assertEqual(voted.upvotes, 1, 'счётчик увеличен');
  });

  test('vote() бросает NotFoundException для ещё не принятой записи', async () => {
    const prisma = createFakePrisma();
    prisma._seedEntry({ status: 'PENDING' });
    const [entry] = prisma._getEntries();
    const svc = new LibraryService(prisma as any);
    await assertThrowsAsync(() => svc.vote(entry.id, 'up'), NotFoundException, 'vote() на непринятую запись');
  });

  test('addExperience() поддерживает анонимность (authorDisplayName не передан)', async () => {
    const prisma = createFakePrisma();
    prisma._seedEntry({ status: 'ACCEPTED' });
    const [entry] = prisma._getEntries();
    const svc = new LibraryService(prisma as any);

    const experience = await svc.addExperience(entry.id, 'Мой опыт с похожим решением');
    assertEqual(experience.authorDisplayName, null, 'анонимный опыт');
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
  console.log(`\nLibraryService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

import { ProtectedNoteService } from '../protected-note/protected-note.service';
import { NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const notes: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _getNotes() { return notes; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    protectedNote: {
      create: async ({ data }: any) => {
        const n = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        notes.push(n);
        return n;
      },
      findMany: async ({ where }: any) => {
        const matching = notes.filter((n) => n.projectId === where.projectId);
        return [...matching].sort((a, b) => (a.planOrder ?? 999) - (b.planOrder ?? 999));
      },
      findUnique: async ({ where }: any) => {
        const n = notes.find((n) => n.id === where.id);
        if (!n) return null;
        return { ...n, project: projects.get(n.projectId) };
      },
      update: async ({ where, data }: any) => {
        const idx = notes.findIndex((n) => n.id === where.id);
        notes[idx] = { ...notes[idx], ...data };
        return notes[idx];
      },
      delete: async ({ where }: any) => {
        const idx = notes.findIndex((n) => n.id === where.id);
        const [deleted] = notes.splice(idx, 1);
        return deleted;
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

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('create() сохраняет ACE_IN_THE_HOLE без triggerCondition/planOrder', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const svc = new ProtectedNoteService(prisma as any);

    const note = await svc.create(USER_ID, PROJECT_ID, {
      type: 'ACE_IN_THE_HOLE' as any,
      content: 'У меня есть письмо с его прошлым обещанием',
    });
    assertEqual(note.content, 'У меня есть письмо с его прошлым обещанием', 'content сохранён');
    assertEqual(note.triggerCondition, null, 'triggerCondition null по умолчанию');
    assertEqual(note.planOrder, null, 'planOrder null по умолчанию');
  });

  test('create() сохраняет FALLBACK_PLAN с triggerCondition и planOrder', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const svc = new ProtectedNoteService(prisma as any);

    const note = await svc.create(USER_ID, PROJECT_ID, {
      type: 'FALLBACK_PLAN' as any,
      content: 'Предложить компромисс по срокам',
      triggerCondition: 'Если откажет наотрез',
      planOrder: 1,
    });
    assertEqual(note.triggerCondition, 'Если откажет наотрез', 'triggerCondition сохранён');
    assertEqual(note.planOrder, 1, 'planOrder сохранён');
  });

  test('create() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new ProtectedNoteService(prisma as any);
    await assertThrowsAsync(
      () => svc.create(USER_ID, PROJECT_ID, { type: 'ACE_IN_THE_HOLE' as any, content: 'x' }),
      NotFoundException,
      'create() на чужой проект',
    );
  });

  test('list() сортирует FALLBACK_PLAN по planOrder (План Б перед Планом В)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const svc = new ProtectedNoteService(prisma as any);

    await svc.create(USER_ID, PROJECT_ID, { type: 'FALLBACK_PLAN' as any, content: 'План В', planOrder: 2 });
    await svc.create(USER_ID, PROJECT_ID, { type: 'FALLBACK_PLAN' as any, content: 'План Б', planOrder: 1 });

    const list = await svc.list(USER_ID, PROJECT_ID);
    assertEqual(list.map((n: any) => n.content), ['План Б', 'План В'], 'сортировка по planOrder, не по порядку создания');
  });

  test('update() изменяет content без ownership-проблем для владельца', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const svc = new ProtectedNoteService(prisma as any);
    const note = await svc.create(USER_ID, PROJECT_ID, { type: 'ACE_IN_THE_HOLE' as any, content: 'Старый текст' });

    const updated = await svc.update(USER_ID, note.id, { content: 'Новый текст' });
    assertEqual(updated.content, 'Новый текст', 'content обновлён');
  });

  test('update() бросает NotFoundException для чужой заметки', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new ProtectedNoteService(prisma as any);
    const note = await svc.create('other-user', PROJECT_ID, { type: 'ACE_IN_THE_HOLE' as any, content: 'x' });

    await assertThrowsAsync(
      () => svc.update(USER_ID, note.id, { content: 'y' }),
      NotFoundException,
      'update() на чужую заметку',
    );
  });

  test('delete() удаляет заметку владельца', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const svc = new ProtectedNoteService(prisma as any);
    const note = await svc.create(USER_ID, PROJECT_ID, { type: 'ACE_IN_THE_HOLE' as any, content: 'x' });

    await svc.delete(USER_ID, note.id);
    assertEqual(prisma._getNotes().length, 0, 'заметка удалена');
  });

  test('delete() бросает NotFoundException для чужой заметки', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new ProtectedNoteService(prisma as any);
    const note = await svc.create('other-user', PROJECT_ID, { type: 'ACE_IN_THE_HOLE' as any, content: 'x' });

    await assertThrowsAsync(
      () => svc.delete(USER_ID, note.id),
      NotFoundException,
      'delete() на чужую заметку',
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
  console.log(`\nProtectedNoteService: ${results.length - failed.length}/${results.length} passed\n`);
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

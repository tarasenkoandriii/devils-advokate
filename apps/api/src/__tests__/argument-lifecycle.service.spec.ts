import { ArgumentLifecycleService } from '../arguments/argument-lifecycle.service';
import { NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const arguments_ = new Map<string, any>();
  const events: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedArgument(a: any) { arguments_.set(a.id, a); },
    _getEvents() { return events; },

    argument: {
      findUnique: async ({ where }: any) => {
        const a = arguments_.get(where.id);
        if (!a) return null;
        return { ...a, project: projects.get(a.projectId) };
      },
      update: async ({ where, data }: any) => {
        const merged = { ...arguments_.get(where.id), ...data };
        arguments_.set(where.id, merged);
        return merged;
      },
    },
    argumentLifecycleEvent: {
      create: async ({ data }: any) => {
        const e = { id: nextId(), createdAt: new Date(), ...data };
        events.push(e);
        return e;
      },
      findMany: async ({ where }: any) =>
        events.filter((e) => e.argumentId === where.argumentId).sort((a, b) => a.createdAt - b.createdAt),
      count: async ({ where }: any) => {
        let result = events.filter((e) => e.argumentId === where.argumentId);
        if (where.toStatus?.in) result = result.filter((e) => where.toStatus.in.includes(e.toStatus));
        return result.length;
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
const ARG_ID = 'arg-1';

function seedArgument(prisma: ReturnType<typeof createFakePrisma>, lifecycleStatus = 'DRAFT') {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
  prisma._seedArgument({ id: ARG_ID, projectId: PROJECT_ID, lifecycleStatus, text: 'x' });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('transition() бросает NotFoundException для чужого аргумента', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    prisma._seedArgument({ id: ARG_ID, projectId: PROJECT_ID, lifecycleStatus: 'DRAFT', text: 'x' });
    const svc = new ArgumentLifecycleService(prisma as any);
    await assertThrowsAsync(
      () => svc.transition(USER_ID, ARG_ID, 'TESTED' as any),
      NotFoundException,
      'transition() на чужой аргумент',
    );
  });

  test('transition() обновляет lifecycleStatus и создаёт событие с fromStatus/toStatus', async () => {
    const prisma = createFakePrisma();
    seedArgument(prisma, 'DRAFT');
    const svc = new ArgumentLifecycleService(prisma as any);

    const updated = await svc.transition(USER_ID, ARG_ID, 'TESTED' as any);
    assertEqual(updated.lifecycleStatus, 'TESTED', 'lifecycleStatus обновлён на аргументе');
    assertEqual(prisma._getEvents().length, 1, 'создано одно событие истории');
    assertEqual(prisma._getEvents()[0].fromStatus, 'DRAFT', 'fromStatus зафиксирован верно');
    assertEqual(prisma._getEvents()[0].toStatus, 'TESTED', 'toStatus зафиксирован верно');
  });

  test('transition() допускает переход НЕ по линейной цепочке (аргумент используют повторно после отказа)', async () => {
    const prisma = createFakePrisma();
    seedArgument(prisma, 'REJECTED'); // уже был отвергнут ранее
    const svc = new ArgumentLifecycleService(prisma as any);

    // Пробуем использовать этот же аргумент снова в другом разговоре —
    // не должно быть заблокировано никакой линейной логикой переходов.
    const updated = await svc.transition(USER_ID, ARG_ID, 'USED' as any);
    assertEqual(updated.lifecycleStatus, 'USED', 'переход REJECTED → USED не заблокирован (не строгий конечный автомат)');
  });

  test('transition() сохраняет conversationId и note, если переданы', async () => {
    const prisma = createFakePrisma();
    seedArgument(prisma, 'TESTED');
    const svc = new ArgumentLifecycleService(prisma as any);

    await svc.transition(USER_ID, ARG_ID, 'USED' as any, { conversationId: 'conv-1', note: 'Использован во вторник' });
    assertEqual(prisma._getEvents()[0].conversationId, 'conv-1', 'conversationId сохранён');
    assertEqual(prisma._getEvents()[0].note, 'Использован во вторник', 'note сохранён');
  });

  test('getHistory() возвращает события в хронологическом порядке', async () => {
    const prisma = createFakePrisma();
    seedArgument(prisma, 'DRAFT');
    const svc = new ArgumentLifecycleService(prisma as any);

    await svc.transition(USER_ID, ARG_ID, 'TESTED' as any);
    await svc.transition(USER_ID, ARG_ID, 'USED' as any);
    await svc.transition(USER_ID, ARG_ID, 'REJECTED' as any);

    const history = await svc.getHistory(USER_ID, ARG_ID);
    assertEqual(history.length, 3, 'все три перехода зафиксированы');
    assertEqual(history.map((h: any) => h.toStatus), ['TESTED', 'USED', 'REJECTED'], 'порядок хронологический');
  });

  test('getFailureInsight() возвращает insight=null, если провалов меньше 3', async () => {
    const prisma = createFakePrisma();
    seedArgument(prisma, 'DRAFT');
    const svc = new ArgumentLifecycleService(prisma as any);

    await svc.transition(USER_ID, ARG_ID, 'REJECTED' as any);
    await svc.transition(USER_ID, ARG_ID, 'USED' as any);
    await svc.transition(USER_ID, ARG_ID, 'COUNTERED' as any);

    const insight = await svc.getFailureInsight(USER_ID, ARG_ID);
    assertEqual(insight.failureCount, 2, 'посчитаны REJECTED+COUNTERED вместе');
    assertEqual(insight.insight, null, 'insight=null ниже порога в 3, не показываем "0 раз"-подобный текст');
  });

  test('getFailureInsight() возвращает текст insight при достижении порога в 3', async () => {
    const prisma = createFakePrisma();
    seedArgument(prisma, 'DRAFT');
    const svc = new ArgumentLifecycleService(prisma as any);

    await svc.transition(USER_ID, ARG_ID, 'REJECTED' as any);
    await svc.transition(USER_ID, ARG_ID, 'USED' as any);
    await svc.transition(USER_ID, ARG_ID, 'COUNTERED' as any);
    await svc.transition(USER_ID, ARG_ID, 'USED' as any);
    await svc.transition(USER_ID, ARG_ID, 'REJECTED' as any);

    const insight = await svc.getFailureInsight(USER_ID, ARG_ID);
    assertEqual(insight.failureCount, 3, 'счётчик провалов = 3');
    assertEqual(
      insight.insight,
      'Этот аргумент уже 3 раз не сработал — возможно, стоит пересмотреть формулировку или отказаться от него.',
      'insight сформирован при достижении порога',
    );
  });

  test('getFailureInsight() НЕ считает ACCEPTED/VERIFIED/EXPIRED как провал', async () => {
    const prisma = createFakePrisma();
    seedArgument(prisma, 'DRAFT');
    const svc = new ArgumentLifecycleService(prisma as any);

    await svc.transition(USER_ID, ARG_ID, 'ACCEPTED' as any);
    await svc.transition(USER_ID, ARG_ID, 'VERIFIED' as any);
    await svc.transition(USER_ID, ARG_ID, 'EXPIRED' as any);

    const insight = await svc.getFailureInsight(USER_ID, ARG_ID);
    assertEqual(insight.failureCount, 0, 'успешные/нейтральные статусы не считаются провалом');
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
  console.log(`\nArgumentLifecycleService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

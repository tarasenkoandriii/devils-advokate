import { LiveHintsService } from '../live-hints/live-hints.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const argumentsList: any[] = [];
  const hintEvents: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedArgument(a: any) { argumentsList.push({ id: a.id ?? nextId(), targetPersonId: null, ...a }); },
    _seedHintEvent(e: any) { hintEvents.push({ id: nextId(), dismissed: false, createdAt: new Date(), ...e }); },
    _getHintEvents() { return hintEvents; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    argument: {
      findMany: async ({ where }: any) =>
        argumentsList.filter(
          (a) =>
            a.projectId === where.projectId &&
            a.stance !== 'RECONCILIATION' &&
            a.stance !== 'COMPROMISE_PROPOSAL' &&
            a.lifecycleStatus !== 'USED',
        ),
    },
    liveHintEvent: {
      create: async ({ data }: any) => {
        const e = { id: nextId(), dismissed: false, createdAt: new Date(), ...data };
        hintEvents.push(e);
        return e;
      },
      findMany: async ({ where, select }: any) => {
        let result = hintEvents.filter((e) => e.projectId === where.projectId);
        if (where.suggestedArgumentId?.not === null) result = result.filter((e) => e.suggestedArgumentId !== null);
        if (select?.suggestedArgumentId) return result.map((e) => ({ suggestedArgumentId: e.suggestedArgumentId }));
        return result.sort((a, b) => b.createdAt - a.createdAt);
      },
      findFirst: async ({ where }: any) => hintEvents.find((e) => e.id === where.id && e.projectId === where.projectId) ?? null,
      update: async ({ where, data }: any) => {
        const idx = hintEvents.findIndex((e) => e.id === where.id);
        hintEvents[idx] = { ...hintEvents[idx], ...data };
        return hintEvents[idx];
      },
    },
    promptVersion: {
      findFirst: async () => null,
    },
  };
}

class FakeAIRouterService {
  responseText: string = 'null';
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

function seedProject(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('analyze() бросает BadRequestException для пустого transcriptWindow', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new LiveHintsService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.analyze(USER_ID, PROJECT_ID, '   '), BadRequestException, 'analyze() с пустым транскриптом');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: analyze() честно возвращает null, если AI решил, что уместной подсказки нет — не подделывает', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = 'null';
    const svc = new LiveHintsService(prisma as any, fakeRouter as any);

    const result = await svc.analyze(USER_ID, PROJECT_ID, 'Обычный нейтральный разговор без ничего примечательного');
    assertEqual(result, null, 'честный null, не выдуманная подсказка ради подсказки');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: analyze() исключает уже USED аргументы из кандидатов — не предлагает то, что уже прозвучало', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ projectId: PROJECT_ID, text: 'Уже озвученный аргумент', stance: 'PRO', lifecycleStatus: 'USED' });
    prisma._seedArgument({ projectId: PROJECT_ID, text: 'Свежий неозвученный аргумент', stance: 'PRO', lifecycleStatus: 'DRAFT' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new LiveHintsService(prisma as any, fakeRouter as any);

    await svc.analyze(USER_ID, PROJECT_ID, 'x');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Уже озвученный аргумент'), false, 'USED-аргумент не попал в список кандидатов промпта');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Свежий неозвученный аргумент'), true, 'неозвученный аргумент попал в список кандидатов');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: analyze() не предлагает аргумент повторно, если он уже фигурировал в LiveHintEvent этой сессии', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ id: 'arg-1', projectId: PROJECT_ID, text: 'Аргумент, уже предложенный ранее', stance: 'PRO', lifecycleStatus: 'DRAFT' });
    prisma._seedHintEvent({ projectId: PROJECT_ID, hintType: 'ARGUMENT_SUGGESTION', hintText: 'x', suggestedArgumentId: 'arg-1' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new LiveHintsService(prisma as any, fakeRouter as any);

    await svc.analyze(USER_ID, PROJECT_ID, 'x');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Аргумент, уже предложенный ранее'), false, 'ранее уже предложенный аргумент исключён из кандидатов, не только USED-статус проверяется');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: analyze() создаёт LiveHintEvent с корректным suggestedArgumentId по индексу от AI', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ id: 'arg-1', projectId: PROJECT_ID, text: 'Первый кандидат', stance: 'PRO', lifecycleStatus: 'DRAFT' });
    prisma._seedArgument({ id: 'arg-2', projectId: PROJECT_ID, text: 'Второй кандидат', stance: 'CON', lifecycleStatus: 'DRAFT' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '{"hintType":"ARGUMENT_SUGGESTION","hintText":"Сейчас хороший момент упомянуть второй аргумент","suggestedArgumentIndex":1}';
    const svc = new LiveHintsService(prisma as any, fakeRouter as any);

    const hint = await svc.analyze(USER_ID, PROJECT_ID, 'x');
    assertEqual(hint?.suggestedArgumentId, 'arg-2', 'индекс 1 от AI корректно сопоставлен со вторым кандидатом в списке');
  });

  test('analyze() честно не подставляет случайный аргумент, если индекс от AI "поплыл" (вне диапазона)', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedArgument({ id: 'arg-1', projectId: PROJECT_ID, text: 'Единственный кандидат', stance: 'PRO', lifecycleStatus: 'DRAFT' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '{"hintType":"ARGUMENT_SUGGESTION","hintText":"x","suggestedArgumentIndex":5}';
    const svc = new LiveHintsService(prisma as any, fakeRouter as any);

    const hint = await svc.analyze(USER_ID, PROJECT_ID, 'x');
    assertEqual(hint?.suggestedArgumentId, null, 'индекс вне диапазона — честно null, не угадывание похожего аргумента');
  });

  test('analyze() создаёт TOPIC_REPETITION без suggestedArgumentId', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '{"hintType":"TOPIC_REPETITION","hintText":"Оппонент второй раз возвращается к теме бюджета"}';
    const svc = new LiveHintsService(prisma as any, fakeRouter as any);

    const hint = await svc.analyze(USER_ID, PROJECT_ID, 'x');
    assertEqual(hint?.hintType, 'TOPIC_REPETITION', 'тип подсказки сохранён корректно');
    assertEqual(hint?.suggestedArgumentId, null, 'для этого типа аргумент честно не привязывается');
  });

  test('analyze() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new LiveHintsService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.analyze(USER_ID, PROJECT_ID, 'x'), BadGatewayException, 'analyze() при недоступности провайдера');
  });

  test('markDismissed() бросает NotFoundException для чужого события', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new LiveHintsService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.markDismissed(USER_ID, PROJECT_ID, 'nonexistent'), NotFoundException, 'markDismissed() на несуществующее событие');
  });

  test('markDismissed() успешно помечает событие отклонённым', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '{"hintType":"TOPIC_REPETITION","hintText":"x"}';
    const svc = new LiveHintsService(prisma as any, fakeRouter as any);

    const hint = await svc.analyze(USER_ID, PROJECT_ID, 'x');
    const dismissed = await svc.markDismissed(USER_ID, PROJECT_ID, hint!.id);
    assertEqual(dismissed.dismissed, true, 'факт отклонения зафиксирован');
  });

  test('list() возвращает подсказки проекта, самые новые первыми', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '{"hintType":"TOPIC_REPETITION","hintText":"x"}';
    const svc = new LiveHintsService(prisma as any, fakeRouter as any);

    await svc.analyze(USER_ID, PROJECT_ID, 'x');
    await svc.analyze(USER_ID, PROJECT_ID, 'y');

    const list = await svc.list(USER_ID, PROJECT_ID);
    assertEqual(list.length, 2, 'обе подсказки видны');
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
  console.log(`\nLiveHintsService: ${results.length - failed.length}/${results.length} passed\n`);
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

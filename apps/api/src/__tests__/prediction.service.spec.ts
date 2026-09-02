import { PredictionService } from '../prediction/prediction.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const predictions = new Map<string, any>();
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _getPredictions() { return [...predictions.values()]; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    prediction: {
      create: async ({ data }: any) => {
        const p = {
          id: nextId(), createdAt: new Date(), predictedAt: new Date(),
          actualOutcome: null, actualOutcomeRecordedAt: null, difference: null, lesson: null,
          ...data,
        };
        predictions.set(p.id, p);
        return p;
      },
      findMany: async ({ where }: any) => [...predictions.values()].filter((p) => p.projectId === where.projectId),
      findUnique: async ({ where }: any) => {
        const p = predictions.get(where.id);
        if (!p) return null;
        return { ...p, project: projects.get(p.projectId) };
      },
      update: async ({ where, data }: any) => {
        const merged = { ...predictions.get(where.id), ...data };
        predictions.set(where.id, merged);
        return merged;
      },
    },
    promptVersion: {
      findFirst: async () => null,
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

  test('create() создаёт Prediction с actualOutcome=null (фаза прогноза)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const svc = new PredictionService(prisma as any, new FakeAIRouterService() as any);

    const pred = await svc.create(USER_ID, PROJECT_ID, 'Начальник согласится на удалённую работу 2 дня в неделю');
    assertEqual(pred.predictedOutcome, 'Начальник согласится на удалённую работу 2 дня в неделю', 'predictedOutcome сохранён');
    assertEqual(pred.actualOutcome, null, 'actualOutcome ещё не заполнен на этой фазе');
    assertEqual(pred.difference, null, 'difference ещё не заполнен');
    assertEqual(pred.lesson, null, 'lesson ещё не заполнен');
  });

  test('create() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new PredictionService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.create(USER_ID, PROJECT_ID, 'x'),
      NotFoundException,
      'create() на чужой проект',
    );
  });

  test('recordActualOutcome() заполняет difference/lesson из ответа AI', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const fakeRouter = new FakeAIRouterService();
    const svc = new PredictionService(prisma as any, fakeRouter as any);
    const pred = await svc.create(USER_ID, PROJECT_ID, 'Согласится на 2 дня удалённо');

    fakeRouter.responseText = JSON.stringify({
      difference: 'Согласился только на 1 день, не на 2',
      lesson: 'В следующий раз стоит запрашивать больше, чем реально нужно, с запасом на торг',
    });

    const updated = await svc.recordActualOutcome(USER_ID, pred.id, 'Согласился на 1 день удалённо в неделю');
    assertEqual(updated.actualOutcome, 'Согласился на 1 день удалённо в неделю', 'actualOutcome сохранён');
    assertEqual(updated.difference, 'Согласился только на 1 день, не на 2', 'difference сохранён');
    assertEqual(updated.lesson, 'В следующий раз стоит запрашивать больше, чем реально нужно, с запасом на торг', 'lesson сохранён');
    assertEqual(updated.actualOutcomeRecordedAt !== null, true, 'actualOutcomeRecordedAt проставлен');
    assertEqual(updated.generatedByInferenceId, 'inference-1', 'provenance сохранён');
  });

  test('recordActualOutcome() бросает BadRequestException при повторном вызове (исход уже записан)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const fakeRouter = new FakeAIRouterService();
    const svc = new PredictionService(prisma as any, fakeRouter as any);
    const pred = await svc.create(USER_ID, PROJECT_ID, 'x');

    fakeRouter.responseText = JSON.stringify({ difference: 'd', lesson: 'l' });
    await svc.recordActualOutcome(USER_ID, pred.id, 'первый результат');

    await assertThrowsAsync(
      () => svc.recordActualOutcome(USER_ID, pred.id, 'второй результат, перезаписывающий историю'),
      BadRequestException,
      'recordActualOutcome() повторно на уже разрешённый прогноз',
    );
  });

  test('recordActualOutcome() бросает NotFoundException для чужого прогноза', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new PredictionService(prisma as any, new FakeAIRouterService() as any);
    const pred = await svc.create('other-user', PROJECT_ID, 'x');

    await assertThrowsAsync(
      () => svc.recordActualOutcome(USER_ID, pred.id, 'y'),
      NotFoundException,
      'recordActualOutcome() на чужой прогноз',
    );
  });

  test('list() возвращает прогнозы проекта, включая ещё неразрешённые', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const svc = new PredictionService(prisma as any, new FakeAIRouterService() as any);
    await svc.create(USER_ID, PROJECT_ID, 'Прогноз 1');
    await svc.create(USER_ID, PROJECT_ID, 'Прогноз 2');

    const list = await svc.list(USER_ID, PROJECT_ID);
    assertEqual(list.length, 2, 'оба прогноза видны, включая неразрешённые');
  });

  // Пункт 32 (расширенный аудит тестов) — ветка BadGatewayException в
  // recordActualOutcome() не тестировалась ни разу.
  test('recordActualOutcome() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const fakeRouter = new FakeAIRouterService();
    const svc = new PredictionService(prisma as any, fakeRouter as any);
    const pred = await svc.create(USER_ID, PROJECT_ID, 'x');

    fakeRouter.execute = async () => { throw new Error('provider timeout'); };
    await assertThrowsAsync(
      () => svc.recordActualOutcome(USER_ID, pred.id, 'y'),
      BadGatewayException,
      'recordActualOutcome() при недоступности провайдера',
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
  console.log(`\nPredictionService: ${results.length - failed.length}/${results.length} passed\n`);
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

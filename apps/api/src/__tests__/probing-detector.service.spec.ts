import { ProbingDetectorService } from '../probing-detector/probing-detector.service';
import { BadGatewayException, BadRequestException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const topics: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedTopic(t: any) { topics.push({ id: t.id ?? nextId(), firstDetectedAt: new Date(), lastDetectedAt: new Date(), ...t }); },
    _getTopics() { return topics; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    probingTopic: {
      findMany: async ({ where }: any) => topics.filter((t) => t.projectId === where.projectId).sort((a, b) => b.lastDetectedAt - a.lastDetectedAt),
      create: async ({ data }: any) => {
        const t = { id: nextId(), firstDetectedAt: new Date(), lastDetectedAt: new Date(), ...data };
        topics.push(t);
        return t;
      },
      update: async ({ where, data }: any) => {
        const idx = topics.findIndex((t) => t.id === where.id);
        topics[idx] = { ...topics[idx], ...data };
        return topics[idx];
      },
    },
    promptVersion: {
      findFirst: async () => null,
    },
  };
}

class FakeAIRouterService {
  responseText = '[]';
  lastRequest: any = null;

  async execute(request: any) {
    this.lastRequest = request;
    if (request.validateOutput && !request.validateOutput(this.responseText)) {
      throw new Error('validation failed in fake router');
    }
    return { aiInferenceId: 'inference-1', jobId: 'job-1', text: this.responseText };
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
    const svc = new ProbingDetectorService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.analyze(USER_ID, PROJECT_ID, '   '), BadRequestException, 'analyze() с пустым транскриптом');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: analyze() НЕ возвращает предупреждение при первом упоминании темы — только заводит запись', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '[{"topicDescription":"бюджет на переезд"}]';
    const svc = new ProbingDetectorService(prisma as any, fakeRouter as any);

    const warnings = await svc.analyze(USER_ID, PROJECT_ID, 'x');
    assertEqual(warnings.length, 0, '"дважды, трижды" — первое упоминание честно НЕ считается прощупыванием');
    assertEqual(prisma._getTopics().length, 1, 'но запись для отслеживания создана');
    assertEqual(prisma._getTopics()[0].repeatCount, 1, 'repeatCount стартует с 1');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: analyze() возвращает предупреждение при втором совпадении темы (repeatCount достиг порога)', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedTopic({ projectId: PROJECT_ID, topicDescription: 'бюджет на переезд', repeatCount: 1, confidence: 0.3 });
    const existingId = prisma._getTopics()[0].id;
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = `[{"matchedTopicId":"${existingId}","topicDescription":"бюджет на переезд"}]`;
    const svc = new ProbingDetectorService(prisma as any, fakeRouter as any);

    const warnings = await svc.analyze(USER_ID, PROJECT_ID, 'x');
    assertEqual(warnings.length, 1, 'второе совпадение пересекло порог — предупреждение показано');
    assertEqual(warnings[0].repeatCount, 2, 'repeatCount корректно увеличен');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: confidence растёт с числом повторов, но никогда не достигает 1.0', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedTopic({ projectId: PROJECT_ID, topicDescription: 'x', repeatCount: 10, confidence: 0.9 }); // уже много повторов
    const existingId = prisma._getTopics()[0].id;
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = `[{"matchedTopicId":"${existingId}","topicDescription":"x"}]`;
    const svc = new ProbingDetectorService(prisma as any, fakeRouter as any);

    const warnings = await svc.analyze(USER_ID, PROJECT_ID, 'x');
    assertEqual(warnings[0].confidence < 1.0, true, 'даже при очень большом числе повторов confidence строго меньше 1.0 — buкально ТЗ, "никогда не 100%"');
    assertEqual(warnings[0].confidence, 0.9, 'потолок соблюдён точно');
  });

  test('analyze() подмешивает уже отслеживаемые темы (с repeatCount) в промпт для сопоставления по смыслу', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedTopic({ projectId: PROJECT_ID, topicDescription: 'зарплата на новой работе', repeatCount: 1, confidence: 0.3 });
    const fakeRouter = new FakeAIRouterService();
    const svc = new ProbingDetectorService(prisma as any, fakeRouter as any);

    await svc.analyze(USER_ID, PROJECT_ID, 'x');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('зарплата на новой работе'), true, 'уже отслеживаемая тема передана AI для сопоставления');
  });

  test('analyze() честно трактует matchedTopicId, которого нет в отслеживаемых, как новую тему', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '[{"matchedTopicId":"nonexistent-id","topicDescription":"новая тема"}]';
    const svc = new ProbingDetectorService(prisma as any, fakeRouter as any);

    await svc.analyze(USER_ID, PROJECT_ID, 'x');
    assertEqual(prisma._getTopics().length, 1, 'создана новая запись, сигнал не отброшен целиком из-за некорректного id от AI');
    assertEqual(prisma._getTopics()[0].repeatCount, 1, 'корректно стартует с 1, не с ошибкой');
  });

  test('analyze() возвращает пустой массив, если AI не нашёл настойчивых тем', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '[]';
    const svc = new ProbingDetectorService(prisma as any, fakeRouter as any);

    const warnings = await svc.analyze(USER_ID, PROJECT_ID, 'обычный нейтральный разговор');
    assertEqual(warnings, [], 'честный пустой массив, не выдуманное прощупывание');
  });

  test('analyze() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new ProbingDetectorService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.analyze(USER_ID, PROJECT_ID, 'x'), BadGatewayException, 'analyze() при недоступности провайдера');
  });

  test('list() возвращает отслеживаемые темы проекта, самые недавние первыми', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedTopic({ projectId: PROJECT_ID, topicDescription: 'a', repeatCount: 1, confidence: 0.3, lastDetectedAt: new Date('2026-01-01') });
    prisma._seedTopic({ projectId: PROJECT_ID, topicDescription: 'b', repeatCount: 1, confidence: 0.3, lastDetectedAt: new Date('2026-06-01') });
    const svc = new ProbingDetectorService(prisma as any, new FakeAIRouterService() as any);

    const list = await svc.list(USER_ID, PROJECT_ID);
    assertEqual(list[0].topicDescription, 'b', 'более недавняя тема первой');
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
  console.log(`\nProbingDetectorService: ${results.length - failed.length}/${results.length} passed\n`);
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

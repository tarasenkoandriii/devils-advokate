// Пункт 32 (расширенный аудит тестов) — ArgumentGenerationService
// (MVP-фича 1, самая первая и основополагающая фича проекта) не имела
// ВООБЩЕ никакого выделенного тестового файла. Единственное покрытие —
// buildUserPrompt.spec.ts (только чистая функция) и feature1-e2e.spec.ts
// (только happy path + ownership) — ни одна из ТРЁХ веток catch()
// внутри generate() не была протестирована ни разу: ForbiddenException
// passthrough, AIRouterContentBlockedError → BadRequestException,
// любая другая ошибка → BadGatewayException. Найдено систематической
// сверкой всех throw new в сервисах против упоминаний типа исключения
// в соответствующем *.spec.ts файле.

import { ArgumentGenerationService } from '../arguments/argument-generation.service';
import { AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const arguments_: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _getArguments() { return arguments_; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    decisionObjective: {
      findUnique: async () => null,
    },
    promptVersion: {
      findFirst: async () => null,
    },
    $transaction: async (ops: Promise<any>[]) => Promise.all(ops),
    argument: {
      create: async ({ data }: any) => {
        const a = { id: nextId(), createdAt: new Date(), ...data };
        arguments_.push(a);
        return a;
      },
    },
  };
}

class FakeAIRouterService {
  shouldThrow: Error | null = null;
  responseText = '[]';
  aiInferenceId = 'inference-1';
  lastRequest: any = null;

  async execute(request: any) {
    this.lastRequest = request;
    if (this.shouldThrow) throw this.shouldThrow;
    if (request.validateOutput && !request.validateOutput(this.responseText)) {
      throw new Error('validation failed in fake router');
    }
    return { aiInferenceId: this.aiInferenceId, jobId: 'job-1', text: this.responseText };
  }
}

// Реальный AIRouterContentBlockedError импортирован выше и используется
// напрямую — instanceof-проверка в generate() обязана сработать именно
// на нём, не на суррогате.

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

  test('generate() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new ArgumentGenerationService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.generate(PROJECT_ID, USER_ID),
      NotFoundException,
      'generate() на чужой проект',
    );
  });

  test('generate() пробрасывает ForbiddenException как есть (нет согласия на внешний AI)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.shouldThrow = new ForbiddenException('no consent');
    const svc = new ArgumentGenerationService(prisma as any, fakeRouter as any);
    await assertThrowsAsync(
      () => svc.generate(PROJECT_ID, USER_ID),
      ForbiddenException,
      'generate() без согласия — ForbiddenException пробрасывается как есть, не оборачивается в 502',
    );
  });

  test('generate() превращает AIRouterContentBlockedError в BadRequestException (400, не 502)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.shouldThrow = new AIRouterContentBlockedError('blocked');
    const svc = new ArgumentGenerationService(prisma as any, fakeRouter as any);
    await assertThrowsAsync(
      () => svc.generate(PROJECT_ID, USER_ID),
      BadRequestException,
      'generate() при блокировке контента — BadRequestException (400), не BadGatewayException',
    );
  });

  test('generate() превращает любую другую ошибку AI-роутера в BadGatewayException (502)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.shouldThrow = new Error('provider timeout, exhausted retries');
    const svc = new ArgumentGenerationService(prisma as any, fakeRouter as any);
    await assertThrowsAsync(
      () => svc.generate(PROJECT_ID, USER_ID),
      BadGatewayException,
      'generate() при недоступности провайдера — BadGatewayException (502), не 500 общего вида',
    );
  });

  test('generate() успешно создаёт аргументы с derivedFromInferenceId', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Просить о повышении?', goal: null });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { text: 'У вас хорошие результаты за квартал', stance: 'pro', weight: 0.8 },
      { text: 'Бюджет команды урезан', stance: 'con', weight: 0.6 },
    ]);
    const svc = new ArgumentGenerationService(prisma as any, fakeRouter as any);

    const created = await svc.generate(PROJECT_ID, USER_ID);
    assertEqual(created.length, 2, 'оба аргумента созданы');
    assertEqual(created[0].stance, 'PRO', 'stance "pro" превращается в PRO');
    assertEqual(created[1].stance, 'CON', 'stance "con" превращается в CON');
    assertEqual(created[0].derivedFromInferenceId, 'inference-1', 'provenance проставлен на обоих аргументах');
    assertEqual(created[1].derivedFromInferenceId, 'inference-1', 'provenance проставлен на обоих аргументах');
  });

  test('generate() передаёт engineId как preferredModelVersionId в AIRouterService', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'x', goal: null });
    const fakeRouter = new FakeAIRouterService();
    const svc = new ArgumentGenerationService(prisma as any, fakeRouter as any);

    await svc.generate(PROJECT_ID, USER_ID, 'mv-anthropic');
    assertEqual(fakeRouter.lastRequest.preferredModelVersionId, 'mv-anthropic', 'явный выбор движка передан роутеру');
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
  console.log(`\nArgumentGenerationService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

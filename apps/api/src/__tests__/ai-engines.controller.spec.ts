// Пункт 33 (дозакрытие мелких пробелов) — AIEnginesController содержит
// реальную логику (Prisma-запрос + маппинг результата в
// AvailableEngine), не просто делегирует в сервис — таких контроллеров
// в проекте меньшинство (большинство только пробрасывают вызов в
// сервис под @UseGuards, тестировать "функция передаёт x дальше" почти
// не имеет смысла). Найдено ручным просмотром всех *.controller.ts на
// предмет прямых обращений к PrismaService в обход сервисного слоя.

import { AIEnginesController } from '../ai-engines/ai-engines.controller';

function createFakePrisma() {
  const capabilities: any[] = [];
  return {
    _seedCapability(c: any) { capabilities.push(c); },
    aIModelCapability: {
      // Пункт [router-simplify] 2026-09-01: capability — одна строка на
      // модель, taskType в фильтре больше нет.
      findMany: async ({ where }: any) => capabilities.filter((c) => c.availability === where.availability),
    },
  };
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('list() маппит capability в AvailableEngine с правильными полями', async () => {
    const prisma = createFakePrisma();
    prisma._seedCapability({
      taskType: 'argument-generation',
      availability: 'active',
      latencyClass: 'fast',
      costClass: 'low',
      modelVersion: {
        id: 'mv-1',
        version: 'gpt-4.1',
        model: { name: 'gpt-4.1', provider: { name: 'openai' } },
      },
    });
    const controller = new AIEnginesController(prisma as any);

    const result = await controller.list('argument-generation');
    assertEqual(result.length, 1, 'одна доступная модель найдена');
    assertEqual(result[0].modelVersionId, 'mv-1', 'modelVersionId взят из вложенного modelVersion.id');
    assertEqual(result[0].providerName, 'openai', 'providerName взят из глубоко вложенного provider.name');
    assertEqual(result[0].modelName, 'gpt-4.1', 'modelName');
    assertEqual(result[0].version, 'gpt-4.1', 'version');
  });

  test('list() использует taskType по умолчанию "argument-generation", если не передан', async () => {
    const prisma = createFakePrisma();
    prisma._seedCapability({
      taskType: 'argument-generation',
      availability: 'active',
      latencyClass: null,
      costClass: null,
      modelVersion: { id: 'mv-1', version: 'v1', model: { name: 'm', provider: { name: 'p' } } },
    });
    const controller = new AIEnginesController(prisma as any);

    // Дефолт объявлен прямо в сигнатуре метода (taskType = 'argument-generation') —
    // проверяем именно это, не полагаясь на то, что NestJS сам подставит его из URL.
    const result = await (controller.list as any)();
    assertEqual(result.length, 1, 'дефолтный taskType находит capability без явной передачи параметра');
  });

  test('list() возвращает пустой список, если для taskType нет активных моделей', async () => {
    const prisma = createFakePrisma();
    prisma._seedCapability({
      taskType: 'argument-generation',
      availability: 'deprecated', // не active — не должна попасть в список
      latencyClass: null,
      costClass: null,
      modelVersion: { id: 'mv-1', version: 'v1', model: { name: 'm', provider: { name: 'p' } } },
    });
    const controller = new AIEnginesController(prisma as any);

    const result = await controller.list('argument-generation');
    assertEqual(result, [], 'неактивная capability не попадает в список доступных движков');
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
  console.log(`\nAIEnginesController: ${results.length - failed.length}/${results.length} passed\n`);
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

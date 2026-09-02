// Пункт 33 (дозакрытие мелких пробелов) — ConsentController.list()
// содержит прямой Prisma-запрос с фильтрацией по revokedAt: null, не
// делегирует в ConsentService — единственный метод этого контроллера
// с реальной логикой (grant()/revoke() — чистая делегация, не
// тестируется отдельно, покрыто через ConsentService.spec.ts).

import { ConsentController } from '../consent/consent.controller';

function createFakePrisma() {
  const records: any[] = [];
  return {
    _seedRecord(r: any) { records.push(r); },
    consentRecord: {
      findMany: async ({ where }: any) =>
        records
          .filter((r) => r.userId === where.userId && r.revokedAt === where.revokedAt)
          .sort((a, b) => b.createdAt - a.createdAt),
    },
  };
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

const USER_ID = 'user-1';

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('list() исключает отозванные согласия (revokedAt !== null)', async () => {
    const prisma = createFakePrisma();
    prisma._seedRecord({ id: 'c1', userId: USER_ID, consentType: 'EXTERNAL_AI', revokedAt: null, createdAt: new Date() });
    prisma._seedRecord({ id: 'c2', userId: USER_ID, consentType: 'RECORDING', revokedAt: new Date(), createdAt: new Date() });
    const controller = new ConsentController({} as any, prisma as any);

    const result = await controller.list(USER_ID);
    assertEqual(result.length, 1, 'только активное согласие возвращено, отозванное исключено');
    assertEqual((result[0] as any).id, 'c1', 'именно активная запись');
  });

  test('list() не показывает согласия других пользователей', async () => {
    const prisma = createFakePrisma();
    prisma._seedRecord({ id: 'c1', userId: USER_ID, consentType: 'EXTERNAL_AI', revokedAt: null, createdAt: new Date() });
    prisma._seedRecord({ id: 'c2', userId: 'other-user', consentType: 'EXTERNAL_AI', revokedAt: null, createdAt: new Date() });
    const controller = new ConsentController({} as any, prisma as any);

    const result = await controller.list(USER_ID);
    assertEqual(result.length, 1, 'только согласия текущего пользователя');
  });

  test('list() возвращает пустой массив, если согласий вообще нет', async () => {
    const prisma = createFakePrisma();
    const controller = new ConsentController({} as any, prisma as any);

    const result = await controller.list(USER_ID);
    assertEqual(result, [], 'пустой массив, не падение');
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
  console.log(`\nConsentController: ${results.length - failed.length}/${results.length} passed\n`);
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

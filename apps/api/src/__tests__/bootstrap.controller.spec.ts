// Пункт 33 (дозакрытие мелких пробелов) — BootstrapController содержит
// две реальные бизнес-правила прямо в контроллере, не в сервисе:
// isNewUser (эвристика по времени создания записи) и
// disclaimerAcknowledged (совпадение версии дисклеймера).
//
// Пункт 34: изначально disclaimerAcknowledged дублировал логику
// LaunchDisclaimerService.getStatus() инлайн — исправлено: вынесена в
// computeDisclaimerStatus(), экспортированную из launch-disclaimer.service.ts,
// теперь переиспользуется в обоих местах. Тесты ниже не изменились ни
// строкой — рефакторинг реализации не должен менять наблюдаемое
// поведение, что они и подтверждают, пройдя без правок.

import { BootstrapController } from '../bootstrap/bootstrap.controller';
import { CURRENT_DISCLAIMER_VERSION } from '../launch-disclaimer/launch-disclaimer.service';

function createFakePrisma() {
  const users = new Map<string, any>();
  return {
    _seedUser(u: any) { users.set(u.id, u); },
    user: {
      findUniqueOrThrow: async ({ where }: any) => {
        const u = users.get(where.id);
        if (!u) throw new Error('user not found');
        return u;
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

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('bootstrap() isNewUser=true для только что созданного пользователя', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({
      id: USER_ID,
      createdAt: new Date(), // прямо сейчас
      privacyProcessingMode: 'BALANCED',
      launchDisclaimerAcknowledgedAt: null,
      launchDisclaimerVersion: null,
    });
    const controller = new BootstrapController(prisma as any);

    const result = await controller.bootstrap(USER_ID);
    assertEqual(result.isNewUser, true, 'пользователь, созданный только что, — новый');
  });

  test('bootstrap() isNewUser=false для пользователя, созданного давно', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({
      id: USER_ID,
      createdAt: new Date(Date.now() - 60_000), // минуту назад — сильно за пределами 5-секундного окна
      privacyProcessingMode: 'BALANCED',
      launchDisclaimerAcknowledgedAt: null,
      launchDisclaimerVersion: null,
    });
    const controller = new BootstrapController(prisma as any);

    const result = await controller.bootstrap(USER_ID);
    assertEqual(result.isNewUser, false, 'пользователь, созданный минуту назад, — не новый');
  });

  test('bootstrap() disclaimerAcknowledged=true, если подтверждена ТЕКУЩАЯ версия', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({
      id: USER_ID,
      createdAt: new Date(Date.now() - 60_000),
      privacyProcessingMode: 'BALANCED',
      launchDisclaimerAcknowledgedAt: new Date(),
      launchDisclaimerVersion: CURRENT_DISCLAIMER_VERSION,
    });
    const controller = new BootstrapController(prisma as any);

    const result = await controller.bootstrap(USER_ID);
    assertEqual(result.disclaimerAcknowledged, true, 'текущая версия подтверждена — disclaimerAcknowledged=true');
  });

  test('bootstrap() disclaimerAcknowledged=false, если подтверждена СТАРАЯ версия (ключевая логика версионирования)', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({
      id: USER_ID,
      createdAt: new Date(Date.now() - 60_000),
      privacyProcessingMode: 'BALANCED',
      launchDisclaimerAcknowledgedAt: new Date(),
      launchDisclaimerVersion: 'v0-старая-версия',
    });
    const controller = new BootstrapController(prisma as any);

    const result = await controller.bootstrap(USER_ID);
    assertEqual(
      result.disclaimerAcknowledged,
      false,
      'подтверждение старой версии не засчитывается для текущей — та же логика, что уже проверена в LaunchDisclaimerService, теперь переиспользуется через computeDisclaimerStatus(), а не дублируется',
    );
  });

  test('bootstrap() disclaimerAcknowledged=false для нового пользователя, ничего не подтверждавшего', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({
      id: USER_ID,
      createdAt: new Date(),
      privacyProcessingMode: 'MAXIMUM_PRIVACY',
      launchDisclaimerAcknowledgedAt: null,
      launchDisclaimerVersion: null,
    });
    const controller = new BootstrapController(prisma as any);

    const result = await controller.bootstrap(USER_ID);
    assertEqual(result.disclaimerAcknowledged, false, 'ничего не подтверждено — false, не падение на null');
    assertEqual(result.privacyProcessingMode, 'MAXIMUM_PRIVACY', 'privacyProcessingMode проброшен как есть');
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
  console.log(`\nBootstrapController: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

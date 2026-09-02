import { ReligiousReminderService } from '../religious-reminder/religious-reminder.service';

function createFakePrisma() {
  const users = new Map<string, any>();

  return {
    _seedUser(u: any) {
      users.set(u.id, {
        religion: null,
        religiousReminderFrequency: 'ONCE_PER_DAY',
        religiousReminderLastShownAt: null,
        ...u,
      });
    },
    _getUser(id: string) { return users.get(id); },

    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
      update: async ({ where, data }: any) => {
        const u = { ...users.get(where.id), ...data };
        users.set(where.id, u);
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

  test('getReminderIfDue() возвращает shouldShow=false для не указавших вероисповедание', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null });
    const svc = new ReligiousReminderService(prisma as any);

    const result = await svc.getReminderIfDue(USER_ID);
    assertEqual(result.shouldShow, false, 'не показывается без указанного вероисповедания');
    assertEqual(result.principles, null, 'нет содержимого без предположений');
  });

  test('getReminderIfDue() возвращает shouldShow=false для "Другое" — нет справочника для конкретной традиции', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: 'Другое' });
    const svc = new ReligiousReminderService(prisma as any);

    const result = await svc.getReminderIfDue(USER_ID);
    assertEqual(result.shouldShow, false, '"Другое" честно не в справочнике, не выдумывается контент');
  });

  test('getReminderIfDue() возвращает shouldShow=false при частоте OFF', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: 'Христианство', religiousReminderFrequency: 'OFF' });
    const svc = new ReligiousReminderService(prisma as any);

    const result = await svc.getReminderIfDue(USER_ID);
    assertEqual(result.shouldShow, false, 'выключено пользователем — не показывается');
  });

  test('getReminderIfDue() показывает напоминание для указавших Христианство, впервые', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: 'Христианство', religiousReminderLastShownAt: null });
    const svc = new ReligiousReminderService(prisma as any);

    const result = await svc.getReminderIfDue(USER_ID);
    assertEqual(result.shouldShow, true, 'показывается впервые');
    assertEqual(result.principles!.length, 10, 'десять заповедей — все десять пунктов');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: getReminderIfDue() с частотой ONCE_PER_DAY не показывает повторно в тот же день', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: 'Ислам', religiousReminderFrequency: 'ONCE_PER_DAY', religiousReminderLastShownAt: null });
    const svc = new ReligiousReminderService(prisma as any);

    const first = await svc.getReminderIfDue(USER_ID);
    assertEqual(first.shouldShow, true, 'первый вызов сегодня — показывается');

    const second = await svc.getReminderIfDue(USER_ID);
    assertEqual(second.shouldShow, false, 'второй вызов в тот же день — не показывается повторно');
  });

  test('getReminderIfDue() с частотой ONCE_PER_DAY показывает снова на следующий день', async () => {
    const prisma = createFakePrisma();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    prisma._seedUser({ id: USER_ID, religion: 'Иудаизм', religiousReminderFrequency: 'ONCE_PER_DAY', religiousReminderLastShownAt: yesterday });
    const svc = new ReligiousReminderService(prisma as any);

    const result = await svc.getReminderIfDue(USER_ID);
    assertEqual(result.shouldShow, true, 'новый день — показывается снова');
  });

  test('getReminderIfDue() с частотой EVERY_LAUNCH показывает при каждом вызове, даже в один день', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: 'Буддизм', religiousReminderFrequency: 'EVERY_LAUNCH' });
    const svc = new ReligiousReminderService(prisma as any);

    const first = await svc.getReminderIfDue(USER_ID);
    const second = await svc.getReminderIfDue(USER_ID);
    assertEqual(first.shouldShow, true, 'первый вызов показывается');
    assertEqual(second.shouldShow, true, 'второй вызов в тот же день ТОЖЕ показывается — EVERY_LAUNCH игнорирует "уже сегодня"');
  });

  test('getReminderIfDue() отмечает момент показа', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: 'Христианство' });
    const svc = new ReligiousReminderService(prisma as any);

    await svc.getReminderIfDue(USER_ID);
    const user = prisma._getUser(USER_ID);
    assertEqual(user.religiousReminderLastShownAt !== null, true, 'момент показа зафиксирован');
  });

  test('updateFrequency() сохраняет новую частоту', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID });
    const svc = new ReligiousReminderService(prisma as any);

    const updated = await svc.updateFrequency(USER_ID, 'EVERY_LAUNCH' as any);
    assertEqual(updated.religiousReminderFrequency, 'EVERY_LAUNCH', 'частота обновлена');
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
  console.log(`\nReligiousReminderService: ${results.length - failed.length}/${results.length} passed\n`);
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

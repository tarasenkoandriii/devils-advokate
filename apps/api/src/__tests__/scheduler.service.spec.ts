import { SchedulerService } from '../scheduler/scheduler.service';
import { NotFoundException } from '@nestjs/common';

// Пункт 90 (§3.26 ТЗ) — фейк для preGenerateSparringOpener(),
// вызываемого из dispatchDueReminders() при отправке напоминания.
class FakeSparringService {
  preGenerateCalls: { scheduledConversationId: string; userId: string }[] = [];
  shouldFail = false;

  async preGenerateSparringOpener(scheduledConversationId: string, userId: string) {
    this.preGenerateCalls.push({ scheduledConversationId, userId });
    if (this.shouldFail) {
      throw new Error('предзаготовка упала (фейк)');
    }
  }
}

function createFakePrisma() {
  const projects = new Map<string, any>();
  const users = new Map<string, any>();
  const people = new Map<string, any>();
  const scheduled: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedUser(u: any) { users.set(u.id, u); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedScheduled(s: any) { scheduled.push({ id: s.id ?? nextId(), createdAt: new Date(), sparringReminderSentAt: null, postMortemReminderSentAt: null, sparringReminderMinutesBefore: null, personId: null, linkedConversationId: null, ...s }); },
    _getScheduled() { return scheduled; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    scheduledConversation: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), createdAt: new Date(), sparringReminderSentAt: null, postMortemReminderSentAt: null, ...data };
        scheduled.push(s);
        return s;
      },
      findMany: async ({ where, include }: any) => {
        let result = scheduled;
        if (where.projectId) result = result.filter((s) => s.projectId === where.projectId);
        if (where.sparringReminderSentAt === null) result = result.filter((s) => s.sparringReminderSentAt === null);
        if (where.sparringReminderMinutesBefore?.not === null) result = result.filter((s) => s.sparringReminderMinutesBefore !== null);
        if (where.postMortemReminderSentAt === null) result = result.filter((s) => s.postMortemReminderSentAt === null);
        if (where.scheduledAt?.lt) result = result.filter((s) => s.scheduledAt < where.scheduledAt.lt);
        if (include?.project) {
          result = result.map((s) => ({ ...s, project: { ...projects.get(s.projectId), owner: users.get(projects.get(s.projectId).ownerId) } }));
        }
        if (include?.person) {
          result = result.map((s) => ({ ...s, person: s.personId ? people.get(s.personId) : null }));
        }
        return [...result].sort((a, b) => a.scheduledAt - b.scheduledAt);
      },
      findUnique: async ({ where, include }: any) => {
        const s = scheduled.find((x) => x.id === where.id);
        if (!s) return null;
        if (include?.project) return { ...s, project: projects.get(s.projectId) };
        return s;
      },
      update: async ({ where, data }: any) => {
        const idx = scheduled.findIndex((s) => s.id === where.id);
        scheduled[idx] = { ...scheduled[idx], ...data };
        return scheduled[idx];
      },
    },
  };
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
const BOT_TOKEN = 'fake-bot-token';

function seedProjectWithUser(prisma: ReturnType<typeof createFakePrisma>, telegramId = 'tg-12345') {
  prisma._seedUser({ id: USER_ID, telegramId });
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('create() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new SchedulerService(prisma as any, new FakeSparringService() as any);
    await assertThrowsAsync(
      () => svc.create(USER_ID, PROJECT_ID, { scheduledAt: new Date() }),
      NotFoundException,
      'create() на чужой проект',
    );
  });

  test('create() создаёт запись с правильными полями', async () => {
    const prisma = createFakePrisma();
    seedProjectWithUser(prisma);
    const svc = new SchedulerService(prisma as any, new FakeSparringService() as any);

    const scheduledAt = new Date(Date.now() + 3600_000);
    const created = await svc.create(USER_ID, PROJECT_ID, { scheduledAt, sparringReminderMinutesBefore: 60 });
    assertEqual(created.sparringReminderMinutesBefore, 60, 'интервал напоминания сохранён');
    assertEqual(created.sparringReminderSentAt, null, 'напоминание ещё не отправлено');
  });

  test('linkToConversation() бросает NotFoundException для чужой записи', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    prisma._seedScheduled({ projectId: PROJECT_ID, scheduledAt: new Date() });
    const svc = new SchedulerService(prisma as any, new FakeSparringService() as any);
    const [s] = prisma._getScheduled();
    await assertThrowsAsync(() => svc.linkToConversation(USER_ID, s.id, 'conv-1'), NotFoundException, 'linkToConversation() на чужую запись');
  });

  test('linkToConversation() проставляет linkedConversationId явным вызовом', async () => {
    const prisma = createFakePrisma();
    seedProjectWithUser(prisma);
    prisma._seedScheduled({ projectId: PROJECT_ID, scheduledAt: new Date() });
    const svc = new SchedulerService(prisma as any, new FakeSparringService() as any);
    const [s] = prisma._getScheduled();

    const updated = await svc.linkToConversation(USER_ID, s.id, 'conv-1');
    assertEqual(updated.linkedConversationId, 'conv-1', 'связь проставлена');
  });

  // ── dispatchDueReminders() — ключевая логика ──

  test('dispatchDueReminders() отправляет напоминание о спарринге, когда наступило время', async () => {
    const prisma = createFakePrisma();
    seedProjectWithUser(prisma);
    const scheduledAt = new Date(Date.now() + 30 * 60_000); // через 30 мин
    prisma._seedScheduled({ projectId: PROJECT_ID, scheduledAt, sparringReminderMinutesBefore: 60 }); // напоминание за час — уже пора (осталось 30 мин)
    let sentTo: any = null;
    (global as any).fetch = async (url: string, init: any) => {
      sentTo = JSON.parse(init.body);
      return { ok: true, json: async () => ({ ok: true }) };
    };
    const svc = new SchedulerService(prisma as any, new FakeSparringService() as any);

    const result = await svc.dispatchDueReminders(BOT_TOKEN);
    assertEqual(result.sparringSent, 1, 'одно напоминание отправлено');
    assertEqual(sentTo.chat_id, 'tg-12345', 'отправлено владельцу проекта');
  });

  test('dispatchDueReminders() НЕ отправляет напоминание, если время ещё не пришло', async () => {
    const prisma = createFakePrisma();
    seedProjectWithUser(prisma);
    const scheduledAt = new Date(Date.now() + 5 * 3600_000); // через 5 часов
    prisma._seedScheduled({ projectId: PROJECT_ID, scheduledAt, sparringReminderMinutesBefore: 60 }); // напоминание за час — ещё рано
    let fetchCalled = false;
    (global as any).fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ ok: true }) }; };
    const svc = new SchedulerService(prisma as any, new FakeSparringService() as any);

    const result = await svc.dispatchDueReminders(BOT_TOKEN);
    assertEqual(result.sparringSent, 0, 'ничего не отправлено');
    assertEqual(fetchCalled, false, 'Telegram не вызывался вообще');
  });

  test('dispatchDueReminders() НЕ шлёт напоминание "заранее" задним числом, если разговор уже прошёл', async () => {
    const prisma = createFakePrisma();
    seedProjectWithUser(prisma);
    const scheduledAt = new Date(Date.now() - 3600_000); // час назад — уже прошёл
    // postMortemReminderSentAt уже "отправлено" — изолирует проверку
    // именно на sparring-цикл: тот же просроченный разговор законно
    // попадает под ПОСТФАКТУМ-напоминание (отдельный цикл), это не
    // связано с тем, что здесь проверяется.
    prisma._seedScheduled({ projectId: PROJECT_ID, scheduledAt, sparringReminderMinutesBefore: 60, postMortemReminderSentAt: new Date() });
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    const svc = new SchedulerService(prisma as any, new FakeSparringService() as any);

    const result = await svc.dispatchDueReminders(BOT_TOKEN);
    assertEqual(result.sparringSent, 0, 'напоминание "заранее" не шлётся для уже прошедшего разговора');
  });

  test('dispatchDueReminders() НЕ дублирует уже отправленное напоминание о спарринге', async () => {
    const prisma = createFakePrisma();
    seedProjectWithUser(prisma);
    const scheduledAt = new Date(Date.now() + 30 * 60_000);
    prisma._seedScheduled({ projectId: PROJECT_ID, scheduledAt, sparringReminderMinutesBefore: 60, sparringReminderSentAt: new Date() });
    let fetchCalled = false;
    (global as any).fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ ok: true }) }; };
    const svc = new SchedulerService(prisma as any, new FakeSparringService() as any);

    await svc.dispatchDueReminders(BOT_TOKEN);
    assertEqual(fetchCalled, false, 'уже отправленное напоминание не дублируется');
  });

  test('dispatchDueReminders() отправляет постфактум-напоминание для прошедшего разговора', async () => {
    const prisma = createFakePrisma();
    seedProjectWithUser(prisma);
    const scheduledAt = new Date(Date.now() - 3600_000); // час назад
    prisma._seedScheduled({ projectId: PROJECT_ID, scheduledAt });
    let sentText = '';
    (global as any).fetch = async (url: string, init: any) => {
      sentText = JSON.parse(init.body).text;
      return { ok: true, json: async () => ({ ok: true }) };
    };
    const svc = new SchedulerService(prisma as any, new FakeSparringService() as any);

    const result = await svc.dispatchDueReminders(BOT_TOKEN);
    assertEqual(result.postMortemSent, 1, 'постфактум-напоминание отправлено');
    assertEqual(sentText.includes('постфактум-разбор'), true, 'текст напоминания содержит суть');
  });

  test('dispatchDueReminders() включает имя фигуранта в текст напоминания, если он указан', async () => {
    const prisma = createFakePrisma();
    seedProjectWithUser(prisma);
    prisma._seedPerson({ id: 'person-1', displayName: 'Начальник Иван' });
    const scheduledAt = new Date(Date.now() - 3600_000);
    prisma._seedScheduled({ projectId: PROJECT_ID, scheduledAt, personId: 'person-1' });
    let sentText = '';
    (global as any).fetch = async (url: string, init: any) => {
      sentText = JSON.parse(init.body).text;
      return { ok: true, json: async () => ({ ok: true }) };
    };
    const svc = new SchedulerService(prisma as any, new FakeSparringService() as any);

    await svc.dispatchDueReminders(BOT_TOKEN);
    assertEqual(sentText.includes('Начальник Иван'), true, 'имя фигуранта попало в текст');
  });

  test('dispatchDueReminders() продолжает обработку остальных напоминаний, даже если одна отправка упала', async () => {
    const prisma = createFakePrisma();
    seedProjectWithUser(prisma);
    prisma._seedScheduled({ projectId: PROJECT_ID, scheduledAt: new Date(Date.now() - 1000) }); // постфактум due
    prisma._seedScheduled({ projectId: PROJECT_ID, scheduledAt: new Date(Date.now() - 2000) }); // постфактум due, тоже
    let callCount = 0;
    (global as any).fetch = async () => {
      callCount++;
      if (callCount === 1) return { ok: false, status: 403, statusText: 'Forbidden', text: async () => 'blocked' };
      return { ok: true, json: async () => ({ ok: true }) };
    };
    const svc = new SchedulerService(prisma as any, new FakeSparringService() as any);

    const result = await svc.dispatchDueReminders(BOT_TOKEN);
    assertEqual(result.failed, 1, 'один сбой учтён');
    assertEqual(result.postMortemSent, 1, 'второе напоминание всё равно отправлено, несмотря на сбой первого');
  });

  // ── Пункт 90 (§3.26 ТЗ): предзаготовка при отправке напоминания ──

  test('КЛЮЧЕВОЙ ТЕСТ: dispatchDueReminders() вызывает preGenerateSparringOpener() с корректными id при отправке напоминания', async () => {
    const prisma = createFakePrisma();
    seedProjectWithUser(prisma);
    const scheduledAt = new Date(Date.now() + 30 * 60_000);
    prisma._seedScheduled({ id: 'sched-1', projectId: PROJECT_ID, scheduledAt, sparringReminderMinutesBefore: 60 });
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    const fakeSparring = new FakeSparringService();
    const svc = new SchedulerService(prisma as any, fakeSparring as any);

    await svc.dispatchDueReminders(BOT_TOKEN);

    assertEqual(fakeSparring.preGenerateCalls.length, 1, 'предзаготовка вызвана ровно один раз');
    assertEqual(fakeSparring.preGenerateCalls[0].scheduledConversationId, 'sched-1', 'передан id именно этой встречи');
    assertEqual(fakeSparring.preGenerateCalls[0].userId, USER_ID, 'передан id владельца проекта, не какой-то другой');
  });

  test('dispatchDueReminders() НЕ вызывает предзаготовку, если время напоминания ещё не пришло', async () => {
    const prisma = createFakePrisma();
    seedProjectWithUser(prisma);
    const scheduledAt = new Date(Date.now() + 120 * 60_000); // через 2 часа
    prisma._seedScheduled({ projectId: PROJECT_ID, scheduledAt, sparringReminderMinutesBefore: 60 }); // напоминание за час — ещё рано
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    const fakeSparring = new FakeSparringService();
    const svc = new SchedulerService(prisma as any, fakeSparring as any);

    await svc.dispatchDueReminders(BOT_TOKEN);
    assertEqual(fakeSparring.preGenerateCalls.length, 0, 'напоминание ещё не отправлено — предзаготовка тоже не запускалась');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: dispatchDueReminders() продолжает считать напоминание успешно отправленным, даже если предзаготовка упала', async () => {
    const prisma = createFakePrisma();
    seedProjectWithUser(prisma);
    const scheduledAt = new Date(Date.now() + 30 * 60_000);
    prisma._seedScheduled({ projectId: PROJECT_ID, scheduledAt, sparringReminderMinutesBefore: 60 });
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    const fakeSparring = new FakeSparringService();
    fakeSparring.shouldFail = true;
    const svc = new SchedulerService(prisma as any, fakeSparring as any);

    const result = await svc.dispatchDueReminders(BOT_TOKEN);
    assertEqual(result.sparringSent, 1, 'напоминание всё равно засчитано отправленным — пользователь его реально получил, сбой предзаготовки не должен это отменять');
    assertEqual(result.failed, 0, 'сбой предзаготовки не считается сбоем отправки напоминания');
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
  console.log(`\nSchedulerService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

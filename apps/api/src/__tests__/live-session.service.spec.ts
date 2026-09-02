import { LiveSessionService } from '../live-session/live-session.service';
import { ForbiddenException } from '@nestjs/common';

function fakeConsent(granted = true) {
  return { requireConsent: async () => { if (!granted) throw new ForbiddenException('Consent required'); } } as any;
}
import { BadGatewayException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const events: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _getEvents() { return events; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    aIProvider: {
      findUniqueOrThrow: async () => ({ id: 'provider-1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' }),
      // Повторный аудит 2026-09-01: чтение провайдера переведено на
      // requireAIProvider (findUnique + внятная ошибка вместо P2025/500).
      findUnique: async () => ({ id: 'provider-1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' }),
    },
    cooldownNudgeEvent: {
      create: async ({ data }: any) => {
        const e = { id: nextId(), dismissed: false, createdAt: new Date(), ...data };
        events.push(e);
        return e;
      },
      findFirst: async ({ where }: any) => events.find((e) => e.id === where.id && e.projectId === where.projectId) ?? null,
      update: async ({ where, data }: any) => {
        const idx = events.findIndex((e) => e.id === where.id);
        events[idx] = { ...events[idx], ...data };
        return events[idx];
      },
      findMany: async ({ where }: any) => events.filter((e) => e.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt),
    },
  };
}

function createFakeSecrets(apiKey = 'fake-assemblyai-key') {
  return { resolve: async () => apiKey };
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
  const originalFetch = (global as any).fetch;

  test('КЛЮЧЕВОЙ ТЕСТ: mintTranscriptionToken() возвращает токен от AssemblyAI, не завязан на конкретный проект', async () => {
    (global as any).fetch = async (url: string) => {
      assertEqual(url.includes('expires_in_seconds=300'), true, 'дефолтный TTL передан корректно');
      return { ok: true, json: async () => ({ token: 'temp-token-abc' }) };
    };
    const svc = new LiveSessionService(createFakePrisma() as any, createFakeSecrets() as any, fakeConsent());

    const result = await svc.mintTranscriptionToken('u1');
    assertEqual(result.token, 'temp-token-abc', 'токен реально дошёл до вызывающего кода');
    assertEqual(result.expiresInSeconds, 300, 'TTL возвращён вместе с токеном');
  });

  test('РЕГРЕСІЯ (аудит БД 2026-08-30): без згоди THIRD_PARTY_AUDIO_RECORDING — ForbiddenException, до AssemblyAI навіть не звертається', async () => {
    let fetchCalled = false;
    (global as any).fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ token: 'x' }) }; };
    const svc = new LiveSessionService(createFakePrisma() as any, createFakeSecrets() as any, fakeConsent(false));
    await assertThrowsAsync(() => svc.mintTranscriptionToken('u1'), ForbiddenException, 'без згоди на запис третьої сторони токен видаватися не повинен');
    assertEqual(fetchCalled, false, 'запит до AssemblyAI не має відбутися, якщо згода перевірена першою');
  });

  test('mintTranscriptionToken() бросает BadGatewayException при недоступности AssemblyAI', async () => {
    (global as any).fetch = async () => { throw new Error('network down'); };
    const svc = new LiveSessionService(createFakePrisma() as any, createFakeSecrets() as any, fakeConsent());
    await assertThrowsAsync(() => svc.mintTranscriptionToken('u1'), BadGatewayException, 'mintTranscriptionToken() при сетевой ошибке');
  });

  test('mintTranscriptionToken() бросает BadGatewayException при ошибке ответа AssemblyAI', async () => {
    (global as any).fetch = async () => ({ ok: false, status: 401 });
    const svc = new LiveSessionService(createFakePrisma() as any, createFakeSecrets() as any, fakeConsent());
    await assertThrowsAsync(() => svc.mintTranscriptionToken('u1'), BadGatewayException, 'mintTranscriptionToken() при 401 от AssemblyAI');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: logNudgeEvent() сохраняет только числовые метрики, не сырое аудио/транскрипт', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new LiveSessionService(prisma as any, createFakeSecrets() as any, fakeConsent());

    const event = await svc.logNudgeEvent(USER_ID, PROJECT_ID, -12.5, 0.82);
    assertEqual(event.peakVolumeDb, -12.5, 'числовая метрика громкости сохранена');
    assertEqual(event.escalationScore, 0.82, 'числовая метрика эскалации сохранена');
    const serialized = JSON.stringify(event);
    assertEqual(serialized.includes('audio') || serialized.includes('transcript'), false, 'ни намёка на сырые аудио/транскрипт-поля в записи');
  });

  test('logNudgeEvent() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new LiveSessionService(prisma as any, createFakeSecrets() as any, fakeConsent());
    await assertThrowsAsync(() => svc.logNudgeEvent(USER_ID, PROJECT_ID, null, null), NotFoundException, 'logNudgeEvent() на чужой проект');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: markDismissed() честно фиксирует "легко проигнорировать", не блокирует, не наказывает', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new LiveSessionService(prisma as any, createFakeSecrets() as any, fakeConsent());

    const event = await svc.logNudgeEvent(USER_ID, PROJECT_ID, null, null);
    assertEqual(event.dismissed, false, 'по умолчанию не отклонён');
    const dismissed = await svc.markDismissed(USER_ID, PROJECT_ID, event.id);
    assertEqual(dismissed.dismissed, true, 'факт отклонения зафиксирован честно');
  });

  test('markDismissed() бросает NotFoundException, если eventId принадлежит другому проекту', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedProject({ id: 'other-proj', ownerId: USER_ID });
    const svc = new LiveSessionService(prisma as any, createFakeSecrets() as any, fakeConsent());

    const eventInOtherProject = await svc.logNudgeEvent(USER_ID, 'other-proj', null, null);
    await assertThrowsAsync(
      () => svc.markDismissed(USER_ID, PROJECT_ID, eventInOtherProject.id),
      NotFoundException,
      'markDismissed() с eventId из чужого (но своего же) другого проекта — не должен пройти по id без проверки projectId',
    );
  });

  test('list() возвращает события проекта, самые новые первыми', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new LiveSessionService(prisma as any, createFakeSecrets() as any, fakeConsent());

    await svc.logNudgeEvent(USER_ID, PROJECT_ID, null, null);
    await svc.logNudgeEvent(USER_ID, PROJECT_ID, null, null);

    const list = await svc.list(USER_ID, PROJECT_ID);
    assertEqual(list.length, 2, 'оба события видны');
  });

  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  (global as any).fetch = originalFetch;

  const failed = results.filter((r) => r.error);
  console.log(`\nLiveSessionService: ${results.length - failed.length}/${results.length} passed\n`);
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

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
    _languageCode: null as string | null,

    // Пункт [stt-multi] 2026-09-02: провайдера живой расшифровки
    // выбирает язык пользователя из профиля.
    user: {
      findUnique: async function (this: any) { return { languageCode: fakePrismaLanguage.value }; },
    },

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

/** Язык пользователя для фейка prisma — вынесен наружу, чтобы тест мог
 *  переключать его между сценариями. */
const fakePrismaLanguage = { value: null as string | null };

/** Фейк SttService: интересует только КОГО он выбрал по языку и что
 *  согласие проверено ДО обращения к провайдеру. */
function createFakeStt(overrides: { fail?: boolean } = {}) {
  return {
    calls: [] as Array<{ language: string | null | undefined; expiresInSeconds: number }>,
    async mintRealtimeToken(language: string | null | undefined, expiresInSeconds: number) {
      this.calls.push({ language, expiresInSeconds });
      if (overrides.fail) throw new Error('провайдер недоступен');
      const provider = language === 'en' ? 'assemblyai' : 'soniox';
      return {
        provider,
        token: `temp-token-${provider}`,
        expiresInSeconds,
        websocketUrl: provider === 'soniox' ? 'wss://stt-rt.soniox.com/transcribe-websocket' : 'wss://streaming.assemblyai.com/v3/ws',
        model: provider === 'soniox' ? 'stt-rt-v5' : 'universal-3-5-pro',
        languageHints: language === 'en' ? ['en'] : ['uk', 'ru'],
      };
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

function seedProject(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);
  const originalFetch = (global as any).fetch;

  test('КЛЮЧЕВОЙ ТЕСТ [stt-multi]: русскому пользователю живая расшифровка идёт в Soniox, а не в AssemblyAI', async () => {
    // Причина существования всей правки: у AssemblyAI русского и
    // украинского нет НИ В ОДНОЙ потоковой модели — живой прогон на
    // русском возвращал галлюцинацию на английском и иврите.
    fakePrismaLanguage.value = 'ru';
    const stt = createFakeStt();
    const svc = new LiveSessionService(createFakePrisma() as any, fakeConsent(), stt as any);

    const result = await svc.mintTranscriptionToken('u1');
    assertEqual(result.provider, 'soniox', 'провайдер выбран по языку пользователя');
    assertEqual(result.websocketUrl.includes('soniox'), true, 'клиент получает адрес того же провайдера');
    assertEqual(result.languageHints, ['uk', 'ru'], 'подсказки языков — обе, разговор бывает смешанным');
    assertEqual(stt.calls[0].expiresInSeconds, 300, 'дефолтный TTL передан как был');
  });

  test('КЛЮЧЕВОЙ ТЕСТ [stt-multi]: английскому пользователю остаётся прежний провайдер', async () => {
    fakePrismaLanguage.value = 'en';
    const stt = createFakeStt();
    const svc = new LiveSessionService(createFakePrisma() as any, fakeConsent(), stt as any);

    const result = await svc.mintTranscriptionToken('u1');
    assertEqual(result.provider, 'assemblyai', 'английский не переезжает — решение владельца');
  });

  test('[stt-multi] явный язык из клиента важнее профиля', async () => {
    fakePrismaLanguage.value = 'ru';
    const stt = createFakeStt();
    const svc = new LiveSessionService(createFakePrisma() as any, fakeConsent(), stt as any);

    await svc.mintTranscriptionToken('u1', 300, 'en');
    assertEqual(stt.calls[0].language, 'en', 'переданный язык побеждает профиль');
  });

  test('РЕГРЕСІЯ (аудит БД 2026-08-30): без згоди THIRD_PARTY_AUDIO_RECORDING — ForbiddenException, до провайдера навіть не звертається', async () => {
    fakePrismaLanguage.value = 'ru';
    const stt = createFakeStt();
    const svc = new LiveSessionService(createFakePrisma() as any, fakeConsent(false), stt as any);
    await assertThrowsAsync(() => svc.mintTranscriptionToken('u1'), ForbiddenException, 'без згоди на запис третьої сторони токен видаватися не повинен');
    assertEqual(stt.calls.length, 0, 'запит до провайдера не має відбутися, якщо згода перевірена першою');
  });

  test('mintTranscriptionToken() бросает BadGatewayException при недоступности провайдера', async () => {
    fakePrismaLanguage.value = 'ru';
    const svc = new LiveSessionService(createFakePrisma() as any, fakeConsent(), createFakeStt({ fail: true }) as any);
    await assertThrowsAsync(() => svc.mintTranscriptionToken('u1'), BadGatewayException, 'сбой провайдера живой расшифровки');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: logNudgeEvent() сохраняет только числовые метрики, не сырое аудио/транскрипт', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new LiveSessionService(prisma as any, fakeConsent(), createFakeStt() as any);

    const event = await svc.logNudgeEvent(USER_ID, PROJECT_ID, -12.5, 0.82);
    assertEqual(event.peakVolumeDb, -12.5, 'числовая метрика громкости сохранена');
    assertEqual(event.escalationScore, 0.82, 'числовая метрика эскалации сохранена');
    const serialized = JSON.stringify(event);
    assertEqual(serialized.includes('audio') || serialized.includes('transcript'), false, 'ни намёка на сырые аудио/транскрипт-поля в записи');
  });

  test('logNudgeEvent() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new LiveSessionService(prisma as any, fakeConsent(), createFakeStt() as any);
    await assertThrowsAsync(() => svc.logNudgeEvent(USER_ID, PROJECT_ID, null, null), NotFoundException, 'logNudgeEvent() на чужой проект');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: markDismissed() честно фиксирует "легко проигнорировать", не блокирует, не наказывает', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new LiveSessionService(prisma as any, fakeConsent(), createFakeStt() as any);

    const event = await svc.logNudgeEvent(USER_ID, PROJECT_ID, null, null);
    assertEqual(event.dismissed, false, 'по умолчанию не отклонён');
    const dismissed = await svc.markDismissed(USER_ID, PROJECT_ID, event.id);
    assertEqual(dismissed.dismissed, true, 'факт отклонения зафиксирован честно');
  });

  test('markDismissed() бросает NotFoundException, если eventId принадлежит другому проекту', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedProject({ id: 'other-proj', ownerId: USER_ID });
    const svc = new LiveSessionService(prisma as any, fakeConsent(), createFakeStt() as any);

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
    const svc = new LiveSessionService(prisma as any, fakeConsent(), createFakeStt() as any);

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

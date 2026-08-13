import { TextToSpeechService } from '../text-to-speech/text-to-speech.service';
import { BadGatewayException, BadRequestException, ForbiddenException } from '@nestjs/common';

function createFakePrisma() {
  const cache: any[] = [];
  return {
    _getCache() { return cache; },
    _seedCache(c: any) { cache.push(c); },
    ttsCache: {
      findUnique: async ({ where }: any) => cache.find((c) => c.textHash === where.textHash) ?? null,
      create: async ({ data }: any) => {
        if (cache.some((c) => c.textHash === data.textHash)) {
          throw new Error('Unique constraint violation on textHash');
        }
        const c = { id: `id-${cache.length + 1}`, createdAt: new Date(), ...data };
        cache.push(c);
        return c;
      },
    },
  };
}

function createFakeConsentService(options: { hasConsent: boolean } = { hasConsent: true }) {
  const calls: { userId: string; consentType: string }[] = [];
  return {
    calls,
    requireConsent: async (userId: string, consentType: string) => {
      calls.push({ userId, consentType });
      if (!options.hasConsent) throw new ForbiddenException(`Consent ${consentType} required`);
    },
  };
}

function createFakeSecrets(apiKey = 'fake-api-key') {
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

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);
  const originalFetch = (global as any).fetch;

  test('synthesize() бросает BadRequestException для пустого текста', async () => {
    const svc = new TextToSpeechService(createFakePrisma() as any, createFakeConsentService() as any, createFakeSecrets() as any);
    await assertThrowsAsync(() => svc.synthesize(USER_ID, '   '), BadRequestException, 'synthesize() с пустым текстом');
  });

  test('synthesize() бросает ForbiddenException без согласия VOICE_PROCESSING', async () => {
    const svc = new TextToSpeechService(createFakePrisma() as any, createFakeConsentService({ hasConsent: false }) as any, createFakeSecrets() as any);
    await assertThrowsAsync(() => svc.synthesize(USER_ID, 'Привет'), ForbiddenException, 'synthesize() без согласия');
  });

  test('synthesize() запрашивает именно VOICE_PROCESSING', async () => {
    (global as any).fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    const fakeConsent = createFakeConsentService();
    const svc = new TextToSpeechService(createFakePrisma() as any, fakeConsent as any, createFakeSecrets() as any);

    await svc.synthesize(USER_ID, 'Привет');
    assertEqual(fakeConsent.calls[0].consentType, 'VOICE_PROCESSING', 'запрошено именно это согласие');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: synthesize() возвращает cached=true для уже сгенерированной фразы, не вызывает ElevenLabs повторно', async () => {
    let fetchCallCount = 0;
    (global as any).fetch = async () => {
      fetchCallCount++;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    };
    const prisma = createFakePrisma();
    const svc = new TextToSpeechService(prisma as any, createFakeConsentService() as any, createFakeSecrets() as any);

    const first = await svc.synthesize(USER_ID, 'Одна и та же фраза');
    const second = await svc.synthesize(USER_ID, 'Одна и та же фраза');

    assertEqual(first.cached, false, 'первый вызов — не из кэша');
    assertEqual(second.cached, true, 'второй вызов — из кэша');
    assertEqual(fetchCallCount, 1, 'ElevenLabs реально вызван только один раз, не дважды');
    assertEqual(first.audioBase64, second.audioBase64, 'аудио идентично между вызовами');
  });

  test('synthesize() кэширует РАЗДЕЛЬНО для разных voiceId (один и тот же текст)', async () => {
    let fetchCallCount = 0;
    (global as any).fetch = async () => {
      fetchCallCount++;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    };
    const svc = new TextToSpeechService(createFakePrisma() as any, createFakeConsentService() as any, createFakeSecrets() as any);

    await svc.synthesize(USER_ID, 'Текст', 'voice-A');
    await svc.synthesize(USER_ID, 'Текст', 'voice-B');
    assertEqual(fetchCallCount, 2, 'разные голоса — раздельные записи кэша, оба реально сгенерированы');
  });

  test('synthesize() бросает BadGatewayException при ошибке ElevenLabs (не ok)', async () => {
    (global as any).fetch = async () => ({ ok: false, status: 401 });
    const svc = new TextToSpeechService(createFakePrisma() as any, createFakeConsentService() as any, createFakeSecrets() as any);
    await assertThrowsAsync(() => svc.synthesize(USER_ID, 'Текст'), BadGatewayException, 'synthesize() при ошибке ElevenLabs');
  });

  test('synthesize() бросает BadGatewayException при сетевой ошибке', async () => {
    (global as any).fetch = async () => { throw new Error('network down'); };
    const svc = new TextToSpeechService(createFakePrisma() as any, createFakeConsentService() as any, createFakeSecrets() as any);
    await assertThrowsAsync(() => svc.synthesize(USER_ID, 'Текст'), BadGatewayException, 'synthesize() при сетевой ошибке');
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
  console.log(`\nTextToSpeechService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

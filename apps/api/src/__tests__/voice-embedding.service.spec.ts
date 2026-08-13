import { VoiceEmbeddingService, cosineSimilarity, isMatch } from '../voice-embedding/voice-embedding.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

function createFakePrisma() {
  const embeddings = new Map<string, any>();

  return {
    _seedEmbedding(e: any) { embeddings.set(e.userId, { createdAt: new Date(), updatedAt: new Date(), ...e }); },
    _getEmbeddings() { return embeddings; },

    voiceEmbedding: {
      upsert: async ({ where, create, update }: any) => {
        const existing = embeddings.get(where.userId);
        const record = existing ? { ...existing, ...update, updatedAt: new Date() } : { createdAt: new Date(), updatedAt: new Date(), ...create };
        embeddings.set(where.userId, record);
        return record;
      },
      findUnique: async ({ where }: any) => embeddings.get(where.userId) ?? null,
      deleteMany: async ({ where }: any) => {
        const existed = embeddings.has(where.userId);
        embeddings.delete(where.userId);
        return { count: existed ? 1 : 0 };
      },
    },
  };
}

function createFakeConsentService(hasConsent = true) {
  return {
    calls: [] as { userId: string; consentType: string }[],
    revokeCalls: [] as { userId: string; consentType: string }[],
    async requireConsent(userId: string, consentType: string) {
      this.calls.push({ userId, consentType });
      if (!hasConsent) throw new ForbiddenException(`Consent ${consentType} required`);
    },
    async revoke(userId: string, consentType: string) {
      this.revokeCalls.push({ userId, consentType });
    },
  };
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

function assertClose(actual: number, expected: number, tolerance: number, message: string) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`FAIL: ${message}\n  expected ≈${expected} (±${tolerance})\n  actual:   ${actual}`);
  }
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

  // ── Чистая математика — тот же класс числовых тестов, что computeRmsDb() (Пункт 81) ──

  test('КЛЮЧЕВОЙ ТЕСТ: cosineSimilarity() идентичных векторов равен ровно 1.0', () => {
    const v = [0.5, -0.3, 0.8, 0.1];
    assertClose(cosineSimilarity(v, v), 1.0, 0.0001, 'вектор с самим собой — максимальное сходство');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: cosineSimilarity() противоположных векторов равен ровно -1.0', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    assertClose(cosineSimilarity(a, b), -1.0, 0.0001, 'противоположно направленные векторы — минимальное сходство');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: cosineSimilarity() ортогональных векторов равен ровно 0', () => {
    const a = [1, 0];
    const b = [0, 1];
    assertClose(cosineSimilarity(a, b), 0, 0.0001, 'перпендикулярные векторы — нулевое сходство, известное математическое свойство');
  });

  test('cosineSimilarity() инвариантен к масштабу вектора (только направление имеет значение)', () => {
    const a = [1, 2, 3];
    const bScaled = [10, 20, 30]; // тот же вектор, умноженный на 10
    assertClose(cosineSimilarity(a, bScaled), 1.0, 0.0001, 'масштабирование не меняет косинусное сходство — фундаментальное свойство, не приближение реализации');
  });

  test('cosineSimilarity() бросает исключение для векторов разной размерности', () => {
    try {
      cosineSimilarity([1, 2], [1, 2, 3]);
      throw new Error('FAIL: должно было бросить исключение');
    } catch (err: any) {
      if (!err.message.includes('размерности')) throw err;
    }
  });

  test('cosineSimilarity() возвращает честный 0 для нулевого вектора, не делит на 0', () => {
    const zero = [0, 0, 0];
    const v = [1, 2, 3];
    assertEqual(cosineSimilarity(zero, v), 0, 'нулевой вектор — честное "нет сходства", не NaN/Infinity');
  });

  test('isMatch() применяет порог корректно в обе стороны', () => {
    const a = [1, 0];
    const b = [1, 0]; // sim = 1.0
    const c = [0, 1]; // sim = 0.0
    assertEqual(isMatch(a, b, 0.5), true, 'сходство 1.0 выше порога 0.5 — совпадение');
    assertEqual(isMatch(a, c, 0.5), false, 'сходство 0.0 ниже порога 0.5 — не совпадение');
  });

  // ── Сервис ──

  test('enroll() бросает BadRequestException для пустого embedding', async () => {
    const prisma = createFakePrisma();
    const svc = new VoiceEmbeddingService(prisma as any, createFakeConsentService() as any);
    await assertThrowsAsync(() => svc.enroll(USER_ID, []), BadRequestException, 'enroll() с пустым вектором');
  });

  test('enroll() бросает ForbiddenException без согласия VOICE_BIOMETRIC', async () => {
    const prisma = createFakePrisma();
    const svc = new VoiceEmbeddingService(prisma as any, createFakeConsentService(false) as any);
    await assertThrowsAsync(() => svc.enroll(USER_ID, [1, 2, 3]), ForbiddenException, 'enroll() без согласия');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: enroll() запрашивает именно VOICE_BIOMETRIC, не VOICE_PROCESSING', async () => {
    const prisma = createFakePrisma();
    const fakeConsent = createFakeConsentService();
    const svc = new VoiceEmbeddingService(prisma as any, fakeConsent as any);

    await svc.enroll(USER_ID, [1, 2, 3]);
    assertEqual(fakeConsent.calls[0].consentType, 'VOICE_BIOMETRIC', 'запрошено именно отдельное биометрическое согласие, не переиспользован VOICE_PROCESSING');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: повторный enroll() обновляет существующую запись, не создаёт вторую', async () => {
    const prisma = createFakePrisma();
    const svc = new VoiceEmbeddingService(prisma as any, createFakeConsentService() as any);

    await svc.enroll(USER_ID, [1, 2, 3]);
    await svc.enroll(USER_ID, [4, 5, 6]);
    assertEqual(prisma._getEmbeddings().size, 1, 'одна запись на пользователя, не две');
    assertEqual(prisma._getEmbeddings().get(USER_ID).embedding, [4, 5, 6], 'запись реально обновлена новым вектором');
  });

  test('getReference() возвращает null, если эмбеддинга ещё нет', async () => {
    const prisma = createFakePrisma();
    const svc = new VoiceEmbeddingService(prisma as any, createFakeConsentService() as any);
    assertEqual(await svc.getReference(USER_ID), null, 'честный null, не выдуманный вектор');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: verify() возвращает null, если эталона ещё нет — не гадает', async () => {
    const prisma = createFakePrisma();
    const svc = new VoiceEmbeddingService(prisma as any, createFakeConsentService() as any);
    const result = await svc.verify(USER_ID, [1, 2, 3]);
    assertEqual(result, null, 'без эталона — честный null, не false (это разные состояния: "не проверено" vs "не совпало")');
  });

  test('verify() корректно определяет совпадение с эталоном', async () => {
    const prisma = createFakePrisma();
    prisma._seedEmbedding({ userId: USER_ID, embedding: [1, 0, 0], dimension: 3 });
    const svc = new VoiceEmbeddingService(prisma as any, createFakeConsentService() as any);

    const match = await svc.verify(USER_ID, [1, 0, 0]);
    assertEqual(match, true, 'идентичный вектор — совпадение');

    const noMatch = await svc.verify(USER_ID, [0, 1, 0]);
    assertEqual(noMatch, false, 'ортогональный вектор — не совпадение');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: verify() честно возвращает null при несовпадении размерности (смена модели)', async () => {
    const prisma = createFakePrisma();
    prisma._seedEmbedding({ userId: USER_ID, embedding: [1, 0, 0], dimension: 3 });
    const svc = new VoiceEmbeddingService(prisma as any, createFakeConsentService() as any);

    const result = await svc.verify(USER_ID, [1, 0, 0, 0]); // другая размерность
    assertEqual(result, null, 'несовместимая размерность — честный null, не ошибочное сравнение и не исключение');
  });

  test('hasEnrollment() корректно отражает наличие/отсутствие эмбеддинга', async () => {
    const prisma = createFakePrisma();
    const svc = new VoiceEmbeddingService(prisma as any, createFakeConsentService() as any);

    assertEqual(await svc.hasEnrollment(USER_ID), false, 'изначально нет регистрации');
    await svc.enroll(USER_ID, [1, 2, 3]);
    assertEqual(await svc.hasEnrollment(USER_ID), true, 'после enroll() регистрация есть');
  });

  test('revoke() удаляет эмбеддинг и отзывает согласие', async () => {
    const prisma = createFakePrisma();
    const fakeConsent = createFakeConsentService();
    const svc = new VoiceEmbeddingService(prisma as any, fakeConsent as any);

    await svc.enroll(USER_ID, [1, 2, 3]);
    await svc.revoke(USER_ID);

    assertEqual(await svc.hasEnrollment(USER_ID), false, 'эмбеддинг реально удалён, не просто помечен');
    assertEqual(fakeConsent.revokeCalls[0].consentType, 'VOICE_BIOMETRIC', 'согласие отозвано тем же типом, что было выдано');
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
  console.log(`\nVoiceEmbeddingService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

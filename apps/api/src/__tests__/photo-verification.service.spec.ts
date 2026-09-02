import { PhotoVerificationService } from '../photo-verification/photo-verification.service';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const facts = new Map<string, any>();
  const people = new Map<string, any>();
  const verifications: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedFact(f: any) { facts.set(f.id, f); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedVerification(v: any) { verifications.push({ id: v.id ?? nextId(), createdAt: new Date(), ...v }); },
    _getVerifications() { return verifications; },

    personFact: {
      findUnique: async ({ where, include }: any) => {
        const f = facts.get(where.id);
        if (!f) return null;
        if (include?.person) return { ...f, person: people.get(f.personId) };
        return f;
      },
    },
    photoVerification: {
      count: async ({ where }: any) => verifications.filter((v) => v.createdByUserId === where.createdByUserId && v.createdAt >= where.createdAt.gte).length,
      create: async ({ data }: any) => {
        const v = { id: nextId(), createdAt: new Date(), ...data };
        verifications.push(v);
        return v;
      },
      findMany: async ({ where }: any) => verifications.filter((v) => v.personFactId === where.personFactId).sort((a, b) => b.createdAt - a.createdAt),
    },
    $transaction: async (ops: Promise<any>[]) => Promise.all(ops),
  };
}

class FakeSecretsService {
  async resolve(ref: string) {
    return `resolved-${ref}`;
  }
}

class FakeConsentService {
  granted = true;
  lastCall: any = null;
  async requireConsent(userId: string, consentType: string, projectId?: string) {
    this.lastCall = { userId, consentType, projectId };
    if (!this.granted) {
      throw new ForbiddenException(`Consent required: ${consentType}`);
    }
  }
}

function makeStreamFromBuffer(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        controller.enqueue(bytes);
        sent = true;
      } else {
        controller.close();
      }
    },
  });
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
const PERSON_ID = 'person-1';
const FACT_ID = 'fact-1';

function seedOwnedFact(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
  prisma._seedFact({ id: FACT_ID, personId: PERSON_ID, projectId: 'proj-1' });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('verifyPhoto() бросает NotFoundException для факта не владельца', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: 'other-user' });
    prisma._seedFact({ id: FACT_ID, personId: PERSON_ID, projectId: null });
    const svc = new PhotoVerificationService(prisma as any, new FakeSecretsService() as any, new FakeConsentService() as any);
    await assertThrowsAsync(
      () => svc.verifyPhoto(USER_ID, FACT_ID, makeStreamFromBuffer(new Uint8Array([1, 2, 3])), 'image/jpeg'),
      NotFoundException,
      'verifyPhoto() на чужой факт',
    );
  });

  test('verifyPhoto() бросает ForbiddenException без согласия PUBLIC_IMAGE_SEARCH, не трогает сеть вообще', async () => {
    const prisma = createFakePrisma();
    seedOwnedFact(prisma);
    let fetchCalled = false;
    (global as any).fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
    const fakeConsent = new FakeConsentService();
    fakeConsent.granted = false;
    const svc = new PhotoVerificationService(prisma as any, new FakeSecretsService() as any, fakeConsent as any);

    await assertThrowsAsync(
      () => svc.verifyPhoto(USER_ID, FACT_ID, makeStreamFromBuffer(new Uint8Array([1, 2, 3])), 'image/jpeg'),
      ForbiddenException,
      'verifyPhoto() без согласия',
    );
    assertEqual(fetchCalled, false, 'сеть не вызывается вообще без согласия — проверка идёт раньше всего остального');
  });

  test('verifyPhoto() проверяет rate limit — отказывает при достижении дневного лимита', async () => {
    const prisma = createFakePrisma();
    seedOwnedFact(prisma);
    for (let i = 0; i < 5; i++) {
      prisma._seedVerification({ personFactId: FACT_ID, createdByUserId: USER_ID, verificationStatus: 'NO_SIMILAR_IMAGES_FOUND' });
    }
    const svc = new PhotoVerificationService(prisma as any, new FakeSecretsService() as any, new FakeConsentService() as any);
    await assertThrowsAsync(
      () => svc.verifyPhoto(USER_ID, FACT_ID, makeStreamFromBuffer(new Uint8Array([1, 2, 3])), 'image/jpeg'),
      ForbiddenException,
      'verifyPhoto() при достижении дневного лимита',
    );
  });

  test('verifyPhoto() бросает BadRequestException для слишком большого файла', async () => {
    const prisma = createFakePrisma();
    seedOwnedFact(prisma);
    const hugeChunk = new Uint8Array(9_000_000); // больше MAX_IMAGE_BYTES (8MB)
    const svc = new PhotoVerificationService(prisma as any, new FakeSecretsService() as any, new FakeConsentService() as any);
    await assertThrowsAsync(
      () => svc.verifyPhoto(USER_ID, FACT_ID, makeStreamFromBuffer(hugeChunk), 'image/jpeg'),
      BadRequestException,
      'verifyPhoto() при превышении лимита размера',
    );
  });

  test('verifyPhoto() удаляет blob СРАЗУ ПОСЛЕ УСПЕШНОГО поиска (не оставляет висеть)', async () => {
    const prisma = createFakePrisma();
    seedOwnedFact(prisma);
    let deleteCalled = false;
    (global as any).fetch = async (url: string, init: any) => {
      if (init?.method === 'PUT') return { ok: true, json: async () => ({ url: 'https://store.public.blob.vercel-storage.com/x.jpg', pathname: 'x.jpg', contentType: 'image/jpeg' }) };
      if (url.includes('serpapi.com')) return { ok: true, json: async () => ({ search_metadata: { status: 'Success' }, visual_matches: [] }) };
      if (url.endsWith('/delete')) { deleteCalled = true; return { ok: true }; }
      return { ok: true, json: async () => ({}) };
    };
    const svc = new PhotoVerificationService(prisma as any, new FakeSecretsService() as any, new FakeConsentService() as any);

    await svc.verifyPhoto(USER_ID, FACT_ID, makeStreamFromBuffer(new Uint8Array([1, 2, 3])), 'image/jpeg');
    assertEqual(deleteCalled, true, 'удаление blob вызвано после успешного поиска');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: verifyPhoto() удаляет blob ДАЖЕ ЕСЛИ ПОИСК УПАЛ С ОШИБКОЙ (finally, не только happy path)', async () => {
    const prisma = createFakePrisma();
    seedOwnedFact(prisma);
    let deleteCalled = false;
    (global as any).fetch = async (url: string, init: any) => {
      if (init?.method === 'PUT') return { ok: true, json: async () => ({ url: 'https://store.public.blob.vercel-storage.com/x.jpg', pathname: 'x.jpg', contentType: 'image/jpeg' }) };
      if (url.includes('serpapi.com')) throw new Error('SerpApi недоступен');
      if (url.endsWith('/delete')) { deleteCalled = true; return { ok: true }; }
      return { ok: true, json: async () => ({}) };
    };
    const svc = new PhotoVerificationService(prisma as any, new FakeSecretsService() as any, new FakeConsentService() as any);

    await assertThrowsAsync(
      () => svc.verifyPhoto(USER_ID, FACT_ID, makeStreamFromBuffer(new Uint8Array([1, 2, 3])), 'image/jpeg'),
      BadRequestException,
      'verifyPhoto() пробрасывает ошибку поиска как BadRequestException',
    );
    assertEqual(deleteCalled, true, 'blob всё равно удалён, несмотря на сбой поиска — окно публичной доступности не остаётся открытым при ошибке');
  });

  test('verifyPhoto() создаёт ровно одну запись NO_SIMILAR_IMAGES_FOUND, если совпадений нет', async () => {
    const prisma = createFakePrisma();
    seedOwnedFact(prisma);
    (global as any).fetch = async (url: string, init: any) => {
      if (init?.method === 'PUT') return { ok: true, json: async () => ({ url: 'https://store.public.blob.vercel-storage.com/x.jpg', pathname: 'x.jpg', contentType: 'image/jpeg' }) };
      if (url.includes('serpapi.com')) return { ok: true, json: async () => ({ search_metadata: { status: 'Success' }, visual_matches: [] }) };
      return { ok: true, json: async () => ({}) };
    };
    const svc = new PhotoVerificationService(prisma as any, new FakeSecretsService() as any, new FakeConsentService() as any);

    const created = await svc.verifyPhoto(USER_ID, FACT_ID, makeStreamFromBuffer(new Uint8Array([1, 2, 3])), 'image/jpeg');
    assertEqual(created.length, 1, 'ровно одна запись');
    assertEqual(created[0].verificationStatus, 'NO_SIMILAR_IMAGES_FOUND', 'статус — нет совпадений, не вердикт о подлинности');
  });

  test('verifyPhoto() создаёт по записи на каждое найденное совпадение, статус SIMILAR_IMAGES_FOUND (нейтральный, не вердикт)', async () => {
    const prisma = createFakePrisma();
    seedOwnedFact(prisma);
    (global as any).fetch = async (url: string, init: any) => {
      if (init?.method === 'PUT') return { ok: true, json: async () => ({ url: 'https://store.public.blob.vercel-storage.com/x.jpg', pathname: 'x.jpg', contentType: 'image/jpeg' }) };
      if (url.includes('serpapi.com')) {
        return {
          ok: true,
          json: async () => ({
            search_metadata: { status: 'Success' },
            // Полный аудит периметров 2026-08-30: visual_matches — реальная
            // форма ответа рабочего движка (google_lens); image_results был
            // от google_reverse_image, который больше не функционирует.
            visual_matches: [
              { title: 'Похожая статья', link: 'https://example.com/a' },
              { title: 'Ещё одна страница', link: 'https://example.com/b' },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    };
    const svc = new PhotoVerificationService(prisma as any, new FakeSecretsService() as any, new FakeConsentService() as any);

    const created = await svc.verifyPhoto(USER_ID, FACT_ID, makeStreamFromBuffer(new Uint8Array([1, 2, 3])), 'image/jpeg');
    assertEqual(created.length, 2, 'две записи, по одной на совпадение');
    assertEqual(created.every((c: any) => c.verificationStatus === 'SIMILAR_IMAGES_FOUND'), true, 'обе — нейтральный статус найденного совпадения');
    assertEqual(created[0].sourceUrl, 'https://example.com/a', 'sourceUrl сохранён');
  });

  test('list() возвращает записи владельца факта', async () => {
    const prisma = createFakePrisma();
    seedOwnedFact(prisma);
    prisma._seedVerification({ personFactId: FACT_ID, createdByUserId: USER_ID, verificationStatus: 'NO_SIMILAR_IMAGES_FOUND' });
    const svc = new PhotoVerificationService(prisma as any, new FakeSecretsService() as any, new FakeConsentService() as any);
    const list = await svc.list(USER_ID, FACT_ID);
    assertEqual(list.length, 1, 'запись видна владельцу');
  });

  test('list() бросает NotFoundException для факта не владельца', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: 'other-user' });
    prisma._seedFact({ id: FACT_ID, personId: PERSON_ID, projectId: null });
    const svc = new PhotoVerificationService(prisma as any, new FakeSecretsService() as any, new FakeConsentService() as any);
    await assertThrowsAsync(() => svc.list(USER_ID, FACT_ID), NotFoundException, 'list() на чужой факт');
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
  console.log(`\nPhotoVerificationService: ${results.length - failed.length}/${results.length} passed\n`);
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

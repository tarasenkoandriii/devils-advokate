import { VenueRecommendationService } from '../venue-recommendation/venue-recommendation.service';
import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const scheduledConversations = new Map<string, any>();
  const venues: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedScheduled(s: any) { scheduledConversations.set(s.id, s); },
    _getVenues() { return venues; },

    scheduledConversation: {
      findFirst: async ({ where }: any) => {
        const s = scheduledConversations.get(where.id);
        if (!s || s.project.ownerId !== where.project.ownerId) return null;
        return s;
      },
    },
    promptVersion: {
      findFirst: async () => null,
    },
    venueRecommendation: {
      create: async ({ data }: any) => {
        const v = { id: nextId(), createdAt: new Date(), ...data };
        venues.push(v);
        return v;
      },
      findMany: async ({ where }: any) => venues.filter((v) => v.scheduledConversationId === where.scheduledConversationId).sort((a, b) => b.createdAt - a.createdAt),
    },
  };
}

class FakeAIRouterService {
  responseText = '{"suitabilityReason":"Тихое место, подходит для приватного разговора","reviewSummary":"В целом посетители довольны атмосферой"}';
  aiInferenceId = 'inference-1';
  callCount = 0;

  async execute(request: any) {
    this.callCount++;
    if (request.validateOutput && !request.validateOutput(this.responseText)) {
      throw new Error('validation failed in fake router');
    }
    return { aiInferenceId: this.aiInferenceId, jobId: 'job-1', text: this.responseText };
  }
}

function createFakeSecrets(apiKey = 'fake-places-key') {
  return { resolve: async () => apiKey };
}

// Пункт 77 (§3.32 ТЗ) — единый геозапрос. По умолчанию разрешает.
function createFakeConsentService(hasConsent = true) {
  return {
    calls: [] as { userId: string; consentType: string }[],
    async requireConsent(userId: string, consentType: string) {
      this.calls.push({ userId, consentType });
      if (!hasConsent) throw new ForbiddenException(`Consent ${consentType} required`);
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
const SCHEDULED_ID = 'sched-1';

function seedScheduled(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedScheduled({ id: SCHEDULED_ID, projectId: 'proj-1', project: { ownerId: USER_ID } });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);
  const originalFetch = (global as any).fetch;

  test('generate() бросает NotFoundException для чужой запланированной встречи', async () => {
    const prisma = createFakePrisma();
    prisma._seedScheduled({ id: SCHEDULED_ID, projectId: 'proj-1', project: { ownerId: 'other-user' } });
    const svc = new VenueRecommendationService(prisma as any, new FakeAIRouterService() as any, createFakeSecrets() as any, createFakeConsentService() as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, SCHEDULED_ID, 55.7, 37.6), NotFoundException, 'generate() на чужую встречу');
  });

  test('generate() бросает BadRequestException, если рядом ничего не найдено', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ status: 'ZERO_RESULTS', results: [] }) });
    const svc = new VenueRecommendationService(prisma as any, new FakeAIRouterService() as any, createFakeSecrets() as any, createFakeConsentService() as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, SCHEDULED_ID, 55.7, 37.6), BadRequestException, 'generate() без найденных заведений');
  });

  test('generate() бросает BadGatewayException при ошибке Google Places', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    (global as any).fetch = async () => ({ ok: false, status: 403 });
    const svc = new VenueRecommendationService(prisma as any, new FakeAIRouterService() as any, createFakeSecrets() as any, createFakeConsentService() as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, SCHEDULED_ID, 55.7, 37.6), BadGatewayException, 'generate() при ошибке Google Places');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: generate() создаёт VenueRecommendation с рейтингом (🔵) и AI-парафразом (🟡) отдельными полями', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    let callIndex = 0;
    (global as any).fetch = async (url: string) => {
      callIndex++;
      if (url.includes('nearbysearch')) {
        return {
          ok: true,
          json: async () => ({ status: 'OK', results: [{ place_id: 'place-1', name: 'Кафе Тихое', rating: 4.5 }] }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          status: 'OK',
          result: {
            name: 'Кафе Тихое',
            formatted_address: 'ул. Примерная, 1',
            formatted_phone_number: '+7 000 000-00-00',
            rating: 4.5,
            reviews: [{ text: 'Очень уютное место, тихо и спокойно' }, { text: 'Хороший кофе, вежливый персонал' }],
          },
        }),
      };
    };
    const svc = new VenueRecommendationService(prisma as any, new FakeAIRouterService() as any, createFakeSecrets() as any, createFakeConsentService() as any);

    const created = await svc.generate(USER_ID, SCHEDULED_ID, 55.7, 37.6);
    assertEqual(created.length, 1, 'одно заведение создано');
    assertEqual(created[0].rating, 4.5, 'рейтинг (🔵 публичный факт) сохранён как есть из Google');
    assertEqual(created[0].reviewSummary, 'В целом посетители довольны атмосферой', 'парафраз (🟡) сохранён отдельно');
    assertEqual(created[0].suitabilityReason, 'Тихое место, подходит для приватного разговора', 'оценка пригодности (🟡) сохранена отдельно');
    assertEqual(created[0].address, 'ул. Примерная, 1', 'адрес для самостоятельного бронирования сохранён');
    assertEqual(created[0].phone, '+7 000 000-00-00', 'телефон для самостоятельного бронирования сохранён');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: generate() не персистит сырой текст отзывов нигде в созданной записи', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    (global as any).fetch = async (url: string) => {
      if (url.includes('nearbysearch')) {
        return { ok: true, json: async () => ({ status: 'OK', results: [{ place_id: 'place-1', name: 'Кафе', rating: 4.0 }] }) };
      }
      return {
        ok: true,
        json: async () => ({
          status: 'OK',
          result: {
            name: 'Кафе',
            formatted_address: 'x',
            formatted_phone_number: null,
            rating: 4.0,
            reviews: [{ text: 'ДОСЛОВНЫЙ_ТЕКСТ_ОТЗЫВА_НЕ_ДОЛЖЕН_ПОПАСТЬ_В_ЗАПИСЬ' }],
          },
        }),
      };
    };
    const svc = new VenueRecommendationService(prisma as any, new FakeAIRouterService() as any, createFakeSecrets() as any, createFakeConsentService() as any);

    const created = await svc.generate(USER_ID, SCHEDULED_ID, 55.7, 37.6);
    const serialized = JSON.stringify(created[0]);
    assertEqual(serialized.includes('ДОСЛОВНЫЙ_ТЕКСТ_ОТЗЫВА_НЕ_ДОЛЖЕН_ПОПАСТЬ_В_ЗАПИСЬ'), false, 'сырой текст отзыва не просочился в персистентную запись');
  });

  test('generate() пропускает заведение, если для него не удалось получить детали, не роняет всю генерацию', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    (global as any).fetch = async (url: string) => {
      if (url.includes('nearbysearch')) {
        return {
          ok: true,
          json: async () => ({
            status: 'OK',
            results: [
              { place_id: 'place-broken', name: 'Сломанное', rating: 3.0 },
              { place_id: 'place-ok', name: 'Рабочее', rating: 4.0 },
            ],
          }),
        };
      }
      if (url.includes('place-broken')) {
        return { ok: false, status: 500 };
      }
      return {
        ok: true,
        json: async () => ({ status: 'OK', result: { name: 'Рабочее', formatted_address: 'x', formatted_phone_number: null, rating: 4.0, reviews: [] } }),
      };
    };
    const svc = new VenueRecommendationService(prisma as any, new FakeAIRouterService() as any, createFakeSecrets() as any, createFakeConsentService() as any);

    const created = await svc.generate(USER_ID, SCHEDULED_ID, 55.7, 37.6);
    assertEqual(created.length, 1, 'одно рабочее заведение создано, сломанное пропущено, генерация не упала целиком');
  });

  test('list() бросает NotFoundException для чужой запланированной встречи', async () => {
    const prisma = createFakePrisma();
    prisma._seedScheduled({ id: SCHEDULED_ID, projectId: 'proj-1', project: { ownerId: 'other-user' } });
    const svc = new VenueRecommendationService(prisma as any, new FakeAIRouterService() as any, createFakeSecrets() as any, createFakeConsentService() as any);
    await assertThrowsAsync(() => svc.list(USER_ID, SCHEDULED_ID), NotFoundException, 'list() на чужую встречу');
  });

  // ── Пункт 77: единый геозапрос (§3.32 ТЗ) ──

  test('generate() бросает ForbiddenException без согласия LOCATION', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    const fakeConsent = createFakeConsentService(false);
    const svc = new VenueRecommendationService(prisma as any, new FakeAIRouterService() as any, createFakeSecrets() as any, fakeConsent as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, SCHEDULED_ID, 55.7, 37.6), ForbiddenException, 'generate() без согласия LOCATION');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: generate() запрашивает именно ConsentType.LOCATION, тот же тип, что WeatherForecastService/OnboardingService', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    (global as any).fetch = async (url: string) => {
      if (url.includes('nearbysearch')) return { ok: true, json: async () => ({ status: 'ZERO_RESULTS', results: [] }) };
      return { ok: true, json: async () => ({ status: 'OK', result: {} }) };
    };
    const fakeConsent = createFakeConsentService();
    const svc = new VenueRecommendationService(prisma as any, new FakeAIRouterService() as any, createFakeSecrets() as any, fakeConsent as any);
    await svc.generate(USER_ID, SCHEDULED_ID, 55.7, 37.6).catch(() => {}); // ZERO_RESULTS бросит BadRequestException — интересна только сама проверка согласия до этого
    assertEqual(fakeConsent.calls[0].consentType, 'LOCATION', 'запрошено именно это согласие, до похода в Google Places');
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
  console.log(`\nVenueRecommendationService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

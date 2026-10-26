import { VenueRecommendationService } from '../venue-recommendation/venue-recommendation.service';
import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const spendLog: any[] = [];
  const scheduledConversations = new Map<string, any>();
  const venues: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  const fake: any = {
    // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05: счётчики
    // расходов работают ОДНОЙ транзакцией под advisory-замком, и
    // заглушка обязана знать ту же форму, что production. Прежняя не
    // знала `$transaction` вовсе — то есть описывала базу, которой не
    // бывает. Тело выполняется немедленно на том же объекте: порядок и
    // атомарность проверяет спека пункта, здесь нужна только форма.
    $transaction: async (body: any) => (typeof body === 'function' ? body(fake) : Promise.all(body)),
    $executeRaw: async () => 1,
    // Пункт [the-meter-was-on-one-door] / [the-priciest-door-had-no-lock]
    // 2026-09-30: расход платных вызовов считается по журналу — фейк
    // обязан уметь его читать и писать, иначе потолок не выполнится.
    auditLogEntry: {
      count: async ({ where }: any) => spendLog.filter((r: any) => r.action === where.action).length,
      findMany: async ({ where }: any) => spendLog.filter((r: any) => r.action === where.action),
      create: async ({ data }: any) => { spendLog.push(data); return data; },
      // Пункт [the-day-was-the-servers] 2026-10-26: путь ОТКАЗА читает
      // самую старую отметку окна, чтобы назвать срок. Без этого фейк
      // описывал базу, в которой путь отказа падает с TypeError.
      findFirst: async () => (spendLog.length > 0 ? { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } : null),
    },
    _spendLog() { return spendLog; },
    /** Чужой одновременный расход ТОГО ЖЕ человека: потолок
     *  на пользователя, и проверка перед циклом от этого не спасает. */
    _bumpSpend(n: number, action = 'places.request') {
      for (let i = 0; i < n; i++) spendLog.push({ action });
    },
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
  return fake;
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
    (global as any).fetch = async (url: string) => {
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

    const result = await svc.generate(USER_ID, SCHEDULED_ID, 55.7, 37.6);
    const created = result.items;
    assertEqual(created.length, 1, 'одно заведение создано');
    assertEqual(result.consideredCount, 1, 'рассмотрено одно — сколько их было, следует из ответа');
    assertEqual(result.skippedCount, 0, 'ничего не пропущено — и это тоже сказано, а не подразумевается');
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

    const created = (await svc.generate(USER_ID, SCHEDULED_ID, 55.7, 37.6)).items;
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

    const result = await svc.generate(USER_ID, SCHEDULED_ID, 55.7, 37.6);
    assertEqual(result.items.length, 1, 'одно рабочее заведение создано, сломанное пропущено, генерация не упала целиком');
    // Пункт [the-refusal-was-swallowed-midway] 2026-10-26: деградация
    // по заведению осталась верной, но молчаливой быть перестала:
    // срез называется срезом в том же ответе.
    assertEqual(result.consideredCount, 2, 'рассмотрено два заведения');
    assertEqual(result.skippedCount, 1, 'одно пропущено — и человек узнаёт об этом из ответа, а не из длины списка');
  });

  // ── Пункт [the-refusal-was-swallowed-midway] 2026-10-26 ──

  test('КЛЮЧЕВОЙ ТЕСТ [the-refusal-was-swallowed-midway]: потолок, упёршийся НА СЕРЕДИНЕ цикла, уходит человеку, а не коротит список', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    // Два кандидата; проверка перед циклом ПРОХОДИТ (остаток 99
    // при потолке 100), а квота выбирается ЧУЖИМ одновременным
    // запросом того же человека между проверкой и вторым витком.
    (global as any).fetch = async (url: string) => {
      if (url.includes('nearbysearch')) {
        return {
          ok: true,
          json: async () => ({
            status: 'OK',
            results: [
              { place_id: 'place-1', name: 'Первое', rating: 4.0 },
              { place_id: 'place-2', name: 'Второе', rating: 4.2 },
            ],
          }),
        };
      }
      if (url.includes('place-1')) prisma._bumpSpend(100);
      return {
        ok: true,
        json: async () => ({ status: 'OK', result: { name: 'Заведение', formatted_address: 'x', formatted_phone_number: null, rating: 4.0, reviews: [] } }),
      };
    };
    const svc = new VenueRecommendationService(prisma as any, new FakeAIRouterService() as any, createFakeSecrets() as any, createFakeConsentService() as any);

    let caught: any = null;
    try {
      await svc.generate(USER_ID, SCHEDULED_ID, 55.7, 37.6);
    } catch (err) {
      caught = err;
    }

    // ДО правки здесь возвращался список из ОДНОГО заведения без
    // единого слова о причине — то есть ровно «пробел, который
    // выглядит как полнота», недопустимость которого объявлена в
    // шапке самого этого метода.
    assertEqual(caught !== null, true, 'отказ потолка не проглочен');
    assertEqual(typeof caught?.getStatus === 'function' ? caught.getStatus() : null, 429, 'именно отказ потолка, а не какой-нибудь 502');
    assertEqual(/суточный лимит/.test(String(caught?.message ?? '')), true, 'текст отказа дошёл до человека целиком');
    // Честная граница правки, записанная тестом, а не замазанная:
    // первое заведение УЖЕ создано и в базе остаётся — обращение за ним
    // оплачено, выбрасывать его было бы расточительно. Человек
    // увидит его при следующем открытии раздела через list().
    assertEqual(prisma._getVenues().length, 1, 'уже созданное не теряется');
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

run().catch((err) => {
  // Падение вне тела теста (в фейке, в модульном коде) — это
  // провал файла, а не тихий unhandled rejection.
  console.error(err);
  process.exit(1);
});

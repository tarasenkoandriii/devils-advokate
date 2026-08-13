import { OnboardingService } from '../onboarding/onboarding.service';

// Пункт 77 (§3.32 ТЗ) — единый геозапрос. По умолчанию разрешает —
// существующие сценарии не про эту проверку, им не нужно её явно
// настраивать. hasConsent=false используется отдельным тестом ниже.
function createFakeConsentService(hasConsent = true) {
  return {
    calls: [] as { userId: string; consentType: string }[],
    async requireConsent(userId: string, consentType: string) {
      this.calls.push({ userId, consentType });
      if (!hasConsent) {
        const { ForbiddenException } = require('@nestjs/common');
        throw new ForbiddenException(`Consent ${consentType} required`);
      }
    },
  };
}

class FakeAIRouterService {
  responseText = '{}';
  aiInferenceId = 'inference-1';
  lastRequest: any = null;
  shouldFail = false;

  async execute(request: any) {
    this.lastRequest = request;
    if (this.shouldFail) throw new Error('provider down');
    if (request.validateOutput && !request.validateOutput(this.responseText)) {
      throw new Error('validation failed in fake router');
    }
    return { aiInferenceId: this.aiInferenceId, jobId: 'job-1', text: this.responseText };
  }
}

function createFakePrisma() {
  const users = new Map<string, any>();
  const consents: any[] = [];
  let idCounter = 0;

  return {
    _seedUser(u: any) { users.set(u.id, u); },
    _getConsents(userId: string) { return consents.filter((c) => c.userId === userId); },

    user: {
      findUniqueOrThrow: async ({ where }: any) => {
        const u = users.get(where.id);
        if (!u) throw new Error('not found');
        return u;
      },
      update: async ({ where, data }: any) => {
        const merged = { ...users.get(where.id), ...data };
        users.set(where.id, merged);
        return merged;
      },
    },
    consentRecord: {
      findFirst: async ({ where }: any) =>
        consents.find(
          (c) => c.userId === where.userId && c.consentType === where.consentType && c.granted === true && c.revokedAt === null,
        ) ?? null,
      create: async ({ data }: any) => {
        const c = { id: `consent-${++idCounter}`, revokedAt: null, ...data };
        consents.push(c);
        return c;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const c of consents) {
          if (c.userId === where.userId && c.consentType === where.consentType && c.revokedAt === null) {
            Object.assign(c, data);
            count++;
          }
        }
        return { count };
      },
    },
  };
}

const USER_ID = 'user-1';

describe('OnboardingService', () => {
  it('get() возвращает religion=null/city=null для нового пользователя (default "не указывать")', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null, city: null });
    const service = new OnboardingService(prisma as any, new FakeAIRouterService() as any, createFakeConsentService() as any);

    const result = await service.get(USER_ID);
    expect(result.religion).toBe(null);
    expect(result.city).toBe(null);
  });

  it('save() с religion создаёт ConsentRecord(RELIGIOUS_CONTENT) автоматически', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null, city: null });
    const service = new OnboardingService(prisma as any, new FakeAIRouterService() as any, createFakeConsentService() as any);

    await service.save(USER_ID, { religion: 'Христианство' });

    const consents = prisma._getConsents(USER_ID);
    expect(consents.length).toBe(1);
    expect(consents[0].consentType).toBe('RELIGIOUS_CONTENT');
    expect(consents[0].granted).toBe(true);
  });

  it('save() без religion (только city) НЕ создаёт согласие', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null, city: null });
    const service = new OnboardingService(prisma as any, new FakeAIRouterService() as any, createFakeConsentService() as any);

    await service.save(USER_ID, { city: 'Киев' });

    expect(prisma._getConsents(USER_ID).length).toBe(0);
  });

  it('save() с religion="" (пустая строка) не создаёт согласие — трактуется как "не указывать"', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null, city: null });
    const service = new OnboardingService(prisma as any, new FakeAIRouterService() as any, createFakeConsentService() as any);

    const result = await service.save(USER_ID, { religion: '' });

    expect(result.religion).toBe(null);
    expect(prisma._getConsents(USER_ID).length).toBe(0);
  });

  it('повторный save() с religion не создаёт дубликат согласия', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null, city: null });
    const service = new OnboardingService(prisma as any, new FakeAIRouterService() as any, createFakeConsentService() as any);

    await service.save(USER_ID, { religion: 'Христианство' });
    await service.save(USER_ID, { religion: 'Ислам' });

    expect(prisma._getConsents(USER_ID).length).toBe(1);
  });

  it('возврат к "не указывать" (religion: null) отзывает согласие симметрично', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null, city: null });
    const service = new OnboardingService(prisma as any, new FakeAIRouterService() as any, createFakeConsentService() as any);

    await service.save(USER_ID, { religion: 'Христианство' });
    expect(prisma._getConsents(USER_ID)[0].revokedAt).toBe(null);

    await service.save(USER_ID, { religion: null });
    expect(prisma._getConsents(USER_ID)[0].revokedAt).not.toBe(null);
  });

  // ── Пункт 49: country + suggestFromLocation() — по прямому запросу,
  // осознанно отменяющему более раннее P0-решение против гео-
  // автоподсказки (см. onboarding.service.ts, шапка файла) ──

  it('save() сохраняет country наравне с religion/city', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null, city: null, country: null });
    const service = new OnboardingService(prisma as any, new FakeAIRouterService() as any, createFakeConsentService() as any);

    const result = await service.save(USER_ID, { country: 'Украина' });
    expect(result.country).toBe('Украина');
  });

  it('save() с country="" трактуется как "не указывать", тот же принцип, что religion', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null, city: null, country: null });
    const service = new OnboardingService(prisma as any, new FakeAIRouterService() as any, createFakeConsentService() as any);

    const result = await service.save(USER_ID, { country: '' });
    expect(result.country).toBe(null);
  });

  it('suggestFromLocation() НЕ персистит ничего в user — только возвращает подсказку', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null, city: null, country: null });
    (global as any).fetch = async (url: string) => {
      if (url.includes('nominatim')) return { ok: true, json: async () => ({ address: { country: 'Ukraine', city: 'Kyiv' } }) };
      return { ok: true, json: async () => ({ suggestedReligion: 'Христианство (православие)', reasoning: 'Наиболее распространённая конфессия по статистике' }) };
    };
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ suggestedReligion: 'Христианство (православие)', reasoning: 'x' });
    const service = new OnboardingService(prisma as any, fakeRouter as any, createFakeConsentService() as any);

    await service.suggestFromLocation(USER_ID, 50.45, 30.52);

    const userAfter = await service.get(USER_ID);
    expect(userAfter.religion).toBe(null);
    expect(userAfter.country).toBe(null);
  });

  it('suggestFromLocation() возвращает country/city от Nominatim + suggestedReligion от AI', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null, city: null, country: null });
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ address: { country: 'Ukraine', city: 'Kyiv' } }) });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ suggestedReligion: 'Христианство (православие)', reasoning: 'Наиболее распространённая конфессия по статистике' });
    const service = new OnboardingService(prisma as any, fakeRouter as any, createFakeConsentService() as any);

    const result = await service.suggestFromLocation(USER_ID, 50.45, 30.52);
    expect(result.country).toBe('Ukraine');
    expect(result.city).toBe('Kyiv');
    expect(result.suggestedReligion).toBe('Христианство (православие)');
    expect(result.reasoning).toBe('Наиболее распространённая конфессия по статистике');
  });

  it('suggestFromLocation() НЕ предполагает религию, если страна не определена (координаты вне покрытия)', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null, city: null, country: null });
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ error: 'Unable to geocode' }) });
    const fakeRouter = new FakeAIRouterService();
    const service = new OnboardingService(prisma as any, fakeRouter as any, createFakeConsentService() as any);

    const result = await service.suggestFromLocation(USER_ID, 0, 0);
    expect(result.country).toBe(null);
    expect(result.suggestedReligion).toBe(null);
    expect(fakeRouter.lastRequest).toBe(null); // AI не вызывался вообще — нечего предполагать без страны
  });

  it('suggestFromLocation() возвращает country/city даже если AI-подсказка недоступна (необязательная часть, не роняет весь ответ)', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null, city: null, country: null });
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ address: { country: 'Ukraine', city: 'Kyiv' } }) });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.shouldFail = true;
    const service = new OnboardingService(prisma as any, fakeRouter as any, createFakeConsentService() as any);

    const result = await service.suggestFromLocation(USER_ID, 50.45, 30.52);
    expect(result.country).toBe('Ukraine');
    expect(result.city).toBe('Kyiv');
    expect(result.suggestedReligion).toBe(null);
  });

  // Пункт 77 (§3.32 ТЗ) — единый геозапрос.
  it('suggestFromLocation() бросает ForbiddenException без согласия LOCATION', async () => {
    const { ForbiddenException } = require('@nestjs/common');
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null, city: null, country: null });
    const fakeConsent = createFakeConsentService(false);
    const service = new OnboardingService(prisma as any, new FakeAIRouterService() as any, fakeConsent as any);

    await expect(service.suggestFromLocation(USER_ID, 50.45, 30.52)).rejects.toThrow(ForbiddenException);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: suggestFromLocation() запрашивает именно ConsentType.LOCATION, тот же тип, что WeatherForecastService/VenueRecommendationService', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, religion: null, city: null, country: null });
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ address: { country: 'Ukraine', city: 'Kyiv' } }) });
    const fakeConsent = createFakeConsentService();
    const service = new OnboardingService(prisma as any, new FakeAIRouterService() as any, fakeConsent as any);

    await service.suggestFromLocation(USER_ID, 50.45, 30.52);
    expect(fakeConsent.calls[0].consentType).toBe('LOCATION');
  });
});

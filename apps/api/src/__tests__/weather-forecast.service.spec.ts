import { WeatherForecastService } from '../weather-forecast/weather-forecast.service';
import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const scheduled = new Map<string, any>();
  const forecasts: any[] = [];
  const users = new Map<string, any>();
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedScheduled(s: any) { scheduled.set(s.id, s); },
    _seedUser(u: any) { users.set(u.id, { city: null, ...u }); },
    _getForecasts() { return forecasts; },

    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
    },

    scheduledConversation: {
      findFirst: async ({ where }: any) => {
        const s = scheduled.get(where.id);
        if (!s) return null;
        const project = projects.get(s.projectId);
        if (!project || project.ownerId !== where.project.ownerId) return null;
        return s;
      },
    },
    promptVersion: {
      findFirst: async () => null,
    },
    weatherForecast: {
      create: async ({ data }: any) => {
        const f = { id: nextId(), createdAt: new Date(), ...data };
        forecasts.push(f);
        return f;
      },
      findMany: async ({ where }: any) => forecasts.filter((f) => f.scheduledConversationId === where.scheduledConversationId).sort((a, b) => b.createdAt - a.createdAt),
    },
  };
}

class FakeAIRouterService {
  responseText = '{"recommendation":"PROCEED","reason":"Обычная погода без осадков"}';
  aiInferenceId = 'inference-1';
  lastRequest: any = null;

  async execute(request: any) {
    this.lastRequest = request;
    if (request.validateOutput && !request.validateOutput(this.responseText)) {
      throw new Error('validation failed in fake router');
    }
    return { aiInferenceId: this.aiInferenceId, jobId: 'job-1', text: this.responseText };
  }
}

/** Расширение на будущее (2026-08-30) — WINDY_API_KEY не настроен по
 * умолчанию: тесты ниже проверяют существующее поведение (Open-Meteo),
 * не Windy — соответствует реальному fail-closed поведению
 * getForecastWithFallback(), когда ключ отсутствует (resolve() падает,
 * как и настоящий SecretsService для ненастроенной переменной). */
class FakeSecretsService {
  async resolve(_ref: string): Promise<string> {
    throw new Error('not configured');
  }
}

class FakeConsentService {
  calls: { userId: string; consentType: string }[] = [];
  hasConsent = true;
  async requireConsent(userId: string, consentType: string) {
    this.calls.push({ userId, consentType });
    if (!this.hasConsent) throw new ForbiddenException(`Consent ${consentType} required`);
  }
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
const SCHEDULED_ID = 'sched-1';

function seedScheduled(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
  prisma._seedScheduled({ id: SCHEDULED_ID, projectId: PROJECT_ID, scheduledAt: new Date('2026-06-15T14:00:00Z') });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);
  const originalFetch = (global as any).fetch;

  test('generateByCity() бросает BadRequestException для пустого названия города', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, new FakeConsentService() as any, new FakeSecretsService() as any);
    await assertThrowsAsync(() => svc.generateByCity(USER_ID, SCHEDULED_ID, '   '), BadRequestException, 'generateByCity() с пустым городом');
  });

  test('generateByCity() бросает NotFoundException для чужой встречи', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    prisma._seedScheduled({ id: SCHEDULED_ID, projectId: PROJECT_ID, scheduledAt: new Date() });
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, new FakeConsentService() as any, new FakeSecretsService() as any);
    await assertThrowsAsync(() => svc.generateByCity(USER_ID, SCHEDULED_ID, 'Москва'), NotFoundException, 'generateByCity() на чужую встречу');
  });

  test('generateByCity() бросает BadRequestException, если город не найден геокодированием', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ results: [] }) });
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, new FakeConsentService() as any, new FakeSecretsService() as any);
    await assertThrowsAsync(() => svc.generateByCity(USER_ID, SCHEDULED_ID, 'Несуществующийгород'), BadRequestException, 'generateByCity() с ненайденным городом');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: generateByCity() сохраняет cityLabel как введённый пользователем текст', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    (global as any).fetch = async (url: string) => {
      if (url.includes('geocoding-api')) {
        return { ok: true, json: async () => ({ results: [{ latitude: 55.75, longitude: 37.6 }] }) };
      }
      return { ok: true, json: async () => ({ hourly: { time: ['2026-06-15T14:00'], temperature_2m: [22], weathercode: [0] } }) };
    };
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, new FakeConsentService() as any, new FakeSecretsService() as any);

    const forecast = await svc.generateByCity(USER_ID, SCHEDULED_ID, 'Москва');
    assertEqual(forecast.cityLabel, 'Москва', 'ручной ввод города сохранён как есть, не требует согласия');
    assertEqual(forecast.condition, 'ясно', 'погодный код корректно преобразован в человекочитаемое описание');
    assertEqual(forecast.temperatureCelsius, 22, 'температура сохранена');
  });

  test('generateByGeolocation() требует ConsentType.LOCATION', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    const fakeConsent = new FakeConsentService();
    fakeConsent.hasConsent = false;
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, fakeConsent as any, new FakeSecretsService() as any);
    await assertThrowsAsync(() => svc.generateByGeolocation(USER_ID, SCHEDULED_ID, 55.75, 37.6), ForbiddenException, 'generateByGeolocation() без согласия LOCATION');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: generateByGeolocation() честно НЕ сохраняет cityLabel — нет обратного геокодирования, нет иной геопривязки', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ hourly: { time: ['2026-06-15T14:00'], temperature_2m: [30], weathercode: [95] } }) });
    const fakeConsent = new FakeConsentService();
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, fakeConsent as any, new FakeSecretsService() as any);

    const forecast = await svc.generateByGeolocation(USER_ID, SCHEDULED_ID, 55.75, 37.6);
    assertEqual(forecast.cityLabel, null, 'cityLabel честно null для geo-пути — координаты не превращены в постоянную метку иначе');
    assertEqual(fakeConsent.calls[0].consentType, 'LOCATION', 'запрошено именно согласие LOCATION');
  });

  test('generateByGeolocation() честно НЕ сохраняет координаты нигде в записи', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ hourly: { time: ['2026-06-15T14:00'], temperature_2m: [20], weathercode: [0] } }) });
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, new FakeConsentService() as any, new FakeSecretsService() as any);

    const forecast = await svc.generateByGeolocation(USER_ID, SCHEDULED_ID, 55.751244, 37.618423);
    const serialized = JSON.stringify(forecast);
    assertEqual(serialized.includes('55.751244'), false, 'широта не просочилась в персистентную запись');
    assertEqual(serialized.includes('37.618423'), false, 'долгота не просочилась в персистентную запись');
  });

  test('generateByCity() бросает BadGatewayException при недоступности провайдера', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    (global as any).fetch = async () => { throw new Error('network down'); };
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, new FakeConsentService() as any, new FakeSecretsService() as any);
    await assertThrowsAsync(() => svc.generateByCity(USER_ID, SCHEDULED_ID, 'Москва'), BadGatewayException, 'generateByCity() при недоступности Open-Meteo');
  });

  test('generateByCity() подмешивает выбранный ближайший час прогноза в промпт', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    (global as any).fetch = async (url: string) => {
      if (url.includes('geocoding-api')) {
        return { ok: true, json: async () => ({ results: [{ latitude: 1, longitude: 1 }] }) };
      }
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: ['2026-06-15T13:00', '2026-06-15T14:00', '2026-06-15T15:00'],
            temperature_2m: [18, 22, 25],
            weathercode: [1, 95, 3],
          },
        }),
      };
    };
    const fakeRouter = new FakeAIRouterService();
    const svc = new WeatherForecastService(prisma as any, fakeRouter as any, new FakeConsentService() as any, new FakeSecretsService() as any);

    const forecast = await svc.generateByCity(USER_ID, SCHEDULED_ID, 'Москва');
    assertEqual(forecast.condition, 'гроза', 'выбран именно ближайший к запрошенному времени час (14:00), не первый в списке');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('гроза'), true, 'погода конкретного часа попала в промпт');
  });

  // ── Пункт 78: предпросмотр в форме создания (§3.20 ТЗ) ──

  test('КЛЮЧЕВОЙ ТЕСТ: previewForScheduling() честно возвращает null без сохранённого профильного города — не гадает', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, city: null });
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, new FakeConsentService() as any, new FakeSecretsService() as any);

    const result = await svc.previewForScheduling(USER_ID, PROJECT_ID, new Date('2026-06-15T14:00:00Z'));
    assertEqual(result, null, 'без сохранённого города — честно null, не запрашивает город заново');
  });

  test('previewForScheduling() НЕ требует согласия LOCATION — использует уже сохранённый город, не разовую геолокацию', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, city: 'Москва' });
    (global as any).fetch = async (url: string) => {
      if (url.includes('geocoding-api')) return { ok: true, json: async () => ({ results: [{ latitude: 55.75, longitude: 37.6 }] }) };
      return { ok: true, json: async () => ({ hourly: { time: ['2026-06-15T14:00'], temperature_2m: [22], weathercode: [0] } }) };
    };
    const fakeConsent = new FakeConsentService();
    fakeConsent.hasConsent = false; // намеренно нет согласия на геолокацию — предпросмотр должен работать всё равно
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, fakeConsent as any, new FakeSecretsService() as any);

    const result = await svc.previewForScheduling(USER_ID, PROJECT_ID, new Date('2026-06-15T14:00:00Z'));
    assertEqual(result?.cityLabel, 'Москва', 'предпросмотр сработал без ConsentType.LOCATION — путь через уже сохранённый город, не геолокацию');
  });

  test('previewForScheduling() честно возвращает null, если внешний провайдер недоступен — не бросает, не ломает форму', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, city: 'Москва' });
    (global as any).fetch = async () => { throw new Error('network down'); };
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, new FakeConsentService() as any, new FakeSecretsService() as any);

    const result = await svc.previewForScheduling(USER_ID, PROJECT_ID, new Date('2026-06-15T14:00:00Z'));
    assertEqual(result, null, '"мягкое предупреждение" — при ошибке провайдера тихий null, не исключение, форма не блокируется');
  });

  test('previewForScheduling() честно возвращает null, если AI-провайдер недоступен', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, city: 'Москва' });
    (global as any).fetch = async (url: string) => {
      if (url.includes('geocoding-api')) return { ok: true, json: async () => ({ results: [{ latitude: 55.75, longitude: 37.6 }] }) };
      return { ok: true, json: async () => ({ hourly: { time: ['2026-06-15T14:00'], temperature_2m: [22], weathercode: [0] } }) };
    };
    const failingRouter = { execute: async () => { throw new Error('AI down'); } };
    const svc = new WeatherForecastService(prisma as any, failingRouter as any, new FakeConsentService() as any, new FakeSecretsService() as any);

    const result = await svc.previewForScheduling(USER_ID, PROJECT_ID, new Date('2026-06-15T14:00:00Z'));
    assertEqual(result, null, 'AI недоступен — тоже тихий null, не исключение');
  });

  test('previewForScheduling() НЕ создаёт запись WeatherForecast — чистый предпросмотр, ничего не персистируется', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, city: 'Москва' });
    (global as any).fetch = async (url: string) => {
      if (url.includes('geocoding-api')) return { ok: true, json: async () => ({ results: [{ latitude: 55.75, longitude: 37.6 }] }) };
      return { ok: true, json: async () => ({ hourly: { time: ['2026-06-15T14:00'], temperature_2m: [22], weathercode: [0] } }) };
    };
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, new FakeConsentService() as any, new FakeSecretsService() as any);

    await svc.previewForScheduling(USER_ID, PROJECT_ID, new Date('2026-06-15T14:00:00Z'));
    assertEqual(prisma._getForecasts().length, 0, 'ни одна запись WeatherForecast не создана — чистый предпросмотр');
  });

  test('previewForScheduling() корректно передаёт рекомендацию AI дальше в результат предпросмотра', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID, city: 'Москва' });
    (global as any).fetch = async (url: string) => {
      if (url.includes('geocoding-api')) return { ok: true, json: async () => ({ results: [{ latitude: 55.75, longitude: 37.6 }] }) };
      return { ok: true, json: async () => ({ hourly: { time: ['2026-06-15T14:00'], temperature_2m: [35], weathercode: [95] } }) };
    };
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '{"recommendation":"RECONSIDER","reason":"Ожидается гроза, высокая температура"}';
    const svc = new WeatherForecastService(prisma as any, fakeRouter as any, new FakeConsentService() as any, new FakeSecretsService() as any);

    const result = await svc.previewForScheduling(USER_ID, PROJECT_ID, new Date('2026-06-15T14:00:00Z'));
    assertEqual(result?.recommendation, 'RECONSIDER', 'неблагоприятная рекомендация дошла до формы создания');
    assertEqual(result?.condition, 'гроза', 'состояние погоды передано');
  });

  // ── Расширение на будущее (2026-08-30, по прямому запросу) — Windy
  // ── как первичный источник, Open-Meteo как fallback.

  class FakeSecretsServiceWithWindy {
    async resolve(ref: string): Promise<string> {
      if (ref === 'WINDY_API_KEY') return 'windy-test-key';
      throw new Error(`not configured: ${ref}`);
    }
  }

  test('РЕГРЕСІЯ: при налаштованому WINDY_API_KEY спочатку пробує Windy, Open-Meteo forecast НЕ викликається при успіху', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    let openMeteoForecastCalled = false;
    (global as any).fetch = async (url: string) => {
      if (url.includes('geocoding-api')) return { ok: true, json: async () => ({ results: [{ latitude: 55.75, longitude: 37.6 }] }) };
      if (url.includes('api.windy.com')) {
        return {
          ok: true,
          json: async () => ({
            ts: [new Date('2026-06-15T14:00:00Z').getTime()],
            units: { 'temp-surface': 'K' },
            'temp-surface': [295.15], // 22°C
            'weatherwarnings-surface': [0],
            'lclouds-surface': [0], 'mclouds-surface': [0], 'hclouds-surface': [0],
          }),
        };
      }
      // api.open-meteo.com (не geocoding) — если сюда дійшло, fallback спрацював помилково
      openMeteoForecastCalled = true;
      return { ok: true, json: async () => ({ hourly: { time: ['2026-06-15T14:00'], temperature_2m: [999], weathercode: [99] } }) };
    };
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, new FakeConsentService() as any, new FakeSecretsServiceWithWindy() as any);

    const forecast = await svc.generateByCity(USER_ID, SCHEDULED_ID, 'Москва');
    assertEqual(openMeteoForecastCalled, false, 'Open-Meteo forecast НЕ викликається — Windy відповів успішно');
    assertEqual(forecast.temperatureCelsius, 22, 'температура взята з Windy (295.15K), не з fallback-заглушки (999)');
    assertEqual(forecast.condition, 'ясно', 'умова визначена через хмарність Windy, weatherWarnings=0');
  });

  test('РЕГРЕСІЯ: якщо Windy налаштований, але падає (мережа/4xx/несподівана форма) — чесно падає на Open-Meteo, користувач не бачить помилку', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    (global as any).fetch = async (url: string) => {
      if (url.includes('geocoding-api')) return { ok: true, json: async () => ({ results: [{ latitude: 55.75, longitude: 37.6 }] }) };
      if (url.includes('api.windy.com')) return { ok: false, status: 500, text: async () => 'internal error' };
      return { ok: true, json: async () => ({ hourly: { time: ['2026-06-15T14:00'], temperature_2m: [22], weathercode: [0] } }) };
    };
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, new FakeConsentService() as any, new FakeSecretsServiceWithWindy() as any);

    const forecast = await svc.generateByCity(USER_ID, SCHEDULED_ID, 'Москва');
    assertEqual(forecast.temperatureCelsius, 22, 'значення реально прийшло з Open-Meteo fallback, не з провалившого Windy');
    assertEqual(forecast.condition, 'ясно', 'умова теж з Open-Meteo fallback');
  });

  test('без WINDY_API_KEY Windy взагалі не запитується — жодного зайвого мережевого виклику на ненастроєний сервіс', async () => {
    const prisma = createFakePrisma();
    seedScheduled(prisma);
    let windyCalled = false;
    (global as any).fetch = async (url: string) => {
      if (url.includes('api.windy.com')) { windyCalled = true; return { ok: false, status: 401, text: async () => '' }; }
      if (url.includes('geocoding-api')) return { ok: true, json: async () => ({ results: [{ latitude: 55.75, longitude: 37.6 }] }) };
      return { ok: true, json: async () => ({ hourly: { time: ['2026-06-15T14:00'], temperature_2m: [22], weathercode: [0] } }) };
    };
    const svc = new WeatherForecastService(prisma as any, new FakeAIRouterService() as any, new FakeConsentService() as any, new FakeSecretsService() as any);

    await svc.generateByCity(USER_ID, SCHEDULED_ID, 'Москва');
    assertEqual(windyCalled, false, 'без ключа Windy навіть не намагається — не зайва мережева спроба на явно ненастроєний сервіс');
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
  console.log(`\nWeatherForecastService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

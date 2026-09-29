// Сверка 2026-09-05 — согласие спросили одними словами, а проверяют
// другими.
//
// НАЙДЕННОЕ. У `ConsentRecord` есть поле `purposes[]`, заведённое ровно
// для геолокации и ровно затем, чтобы «разрешил на погоду» не значило
// «разрешил на всё». Обе двери продукта его аккуратно ЗАПОЛНЯЮТ.
// Не читает его никто: `hasActiveConsent()` искал запись по типу
// согласия и в `purposes` не заглядывал.
//
// Цена — не в аккуратности учёта. Экран согласия говорил буквально:
// «Координаты никогда не сохраняются — только разовое использование для
// каждого запроса». Для трёх применений, ради которых он написан, это
// правда. Та же запись открывала ещё два, где координаты остаются
// НАВСЕГДА: гео-привязка варианта покупки и геометка на доказательстве
// ДТП — в материале, который человек собирается кому-то предъявлять.
// Человек разрешил погоду; продукт получил право записать, где он был.
//
// И ЕЩЁ ОДНО ОБЕЩАНИЕ. Экран согласия на AI говорил: «Сам вопрос не
// сохраняется на нашей стороне дольше, чем нужно для одного запроса».
// Вопрос — это и есть проект (`Project.question`): он в базе, вокруг
// него аргументы, разборы и история, он виден в списке проектов.
// Обещание противоречило не детали реализации, а устройству продукта.
//
// ПУСТОЙ СПИСОК ПРИМЕНЕНИЙ НЕ ПОКРЫВАЕТ НИЧЕГО. Толковать пустоту как
// «разрешено всё» значило бы вернуть ту же дыру через дверь «старая
// запись» — тихо и с видом совместимости.

import { readFileSync } from 'fs';
import { join } from 'path';
import { ConsentService } from '../consent/consent.service';
import {
  LOCATION_PURPOSES,
  LOCATION_PURPOSE_SPECS,
  coversPurpose,
  locationPurposeSpec,
  storesCoordinates,
} from '../consent/location-purposes';

const API_SRC = join(__dirname, '..');
const TMA_SRC = join(API_SRC, '../../tma/src');

function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function fakePrisma() {
  const records: any[] = [];
  let n = 0;
  return {
    _records: records,
    user: { findUniqueOrThrow: async ({ where }: any) => ({ id: where.id, privacyProcessingMode: 'BALANCED' }) },
    consentRecord: {
      create: async ({ data }: any) => {
        // Фейк беднее продакшена — знакомая ловушка этой сессии: Prisma
        // кладёт в колонку NULL, а `...data` с `projectId: undefined`
        // оставлял бы undefined, и сравнение с null не сходилось бы.
        // Чинится фейк, не правило.
        const r = { id: `c${++n}`, revokedAt: null, purposes: [], createdAt: new Date(), ...data, projectId: data.projectId ?? null };
        records.push(r);
        return r;
      },
      findFirst: async ({ where }: any) => {
        const match = records.filter((r) =>
          r.userId === where.userId && r.consentType === where.consentType &&
          r.granted === where.granted && r.revokedAt === where.revokedAt &&
          (where.OR ? where.OR.some((o: any) => r.projectId === (o.projectId ?? null)) : r.projectId === (where.projectId ?? null)),
        );
        return match[match.length - 1] ?? null;
      },
      updateMany: async () => ({ count: 0 }),
      findMany: async () => records,
    },
  };
}

function service() {
  const prisma = fakePrisma();
  return { prisma, svc: new ConsentService(prisma as any) };
}

async function grant(svc: ConsentService, purposes: string[]) {
  await svc.grant({ userId: 'u1', consentType: 'LOCATION' as any, version: 'v1', source: 'test', purposes });
}

describe('[consent-purpose] проверяется то, под чем человек подписался', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: согласие на погоду НЕ открывает запись координат', async () => {
    // Это и есть весь пункт. До сверки обе проверки возвращали true.
    const { svc } = service();
    await grant(svc, [LOCATION_PURPOSES.WEATHER, LOCATION_PURPOSES.VENUE_SEARCH, LOCATION_PURPOSES.ONBOARDING_CITY]);

    expect(await svc.hasActiveConsent('u1', 'LOCATION' as any, undefined, LOCATION_PURPOSES.WEATHER)).toBe(true);
    expect(await svc.hasActiveConsent('u1', 'LOCATION' as any, undefined, LOCATION_PURPOSES.MAJOR_PURCHASE)).toBe(false);
    expect(await svc.hasActiveConsent('u1', 'LOCATION' as any, undefined, LOCATION_PURPOSES.DTP_EVIDENCE)).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: в отказе названо ИМЕННО то применение, которого не хватило', async () => {
    // Иначе экран не знает, какую дверь открыть, и человек читает
    // общее «нужно согласие» там, где речь о геометке на доказательстве.
    const { svc } = service();
    await grant(svc, [LOCATION_PURPOSES.WEATHER]);
    await expect(svc.requireConsent('u1', 'LOCATION' as any, undefined, LOCATION_PURPOSES.DTP_EVIDENCE))
      .rejects.toMatchObject({ response: { code: 'CONSENT_REQUIRED', purpose: LOCATION_PURPOSES.DTP_EVIDENCE } });
    const err: any = await svc.requireConsent('u1', 'LOCATION' as any, undefined, LOCATION_PURPOSES.DTP_EVIDENCE).catch((e) => e);
    expect(err.response.message).toMatch(/геометка/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: пустой список применений не покрывает ничего', async () => {
    // Совместимость «старых записей» — самый тихий способ вернуть дыру.
    const { svc } = service();
    await grant(svc, []);
    expect(await svc.hasActiveConsent('u1', 'LOCATION' as any)).toBe(true); // без применения — как раньше
    for (const p of Object.values(LOCATION_PURPOSES)) {
      expect(await svc.hasActiveConsent('u1', 'LOCATION' as any, undefined, p)).toBe(false);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: неизвестное применение не покрывается ничем', async () => {
    // Опечатка в имени применения не должна читаться как «разрешено».
    const { svc } = service();
    await grant(svc, ['weather-forecas', 'что-угодно']);
    expect(await svc.hasActiveConsent('u1', 'LOCATION' as any, undefined, 'weather-forecas')).toBe(false);
    expect(locationPurposeSpec('weather-forecas')).toBeNull();
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у каждого применения записано, остаются ли координаты', () => {
    // Именно эта разница и была скрыта одной фразой на все случаи.
    expect(storesCoordinates(LOCATION_PURPOSES.WEATHER)).toBe(false);
    expect(storesCoordinates(LOCATION_PURPOSES.VENUE_SEARCH)).toBe(false);
    expect(storesCoordinates(LOCATION_PURPOSES.ONBOARDING_CITY)).toBe(false);
    expect(storesCoordinates(LOCATION_PURPOSES.MAJOR_PURCHASE)).toBe(true);
    expect(storesCoordinates(LOCATION_PURPOSES.DTP_EVIDENCE)).toBe(true);
    expect(coversPurpose(null, LOCATION_PURPOSES.WEATHER)).toBe(false);
  });

  it('ИЗМЕРЕНИЕ: все пять проверок LOCATION называют своё применение', () => {
    // Правило по дереву: шестое место, требующее LOCATION без
    // применения, должно уронить проверку — иначе дыра вернётся ровно
    // тем же путём, каким появилась.
    const sites = [
      'weather-forecast/weather-forecast.service.ts',
      'venue-recommendation/venue-recommendation.service.ts',
      'onboarding/onboarding.service.ts',
      'major-purchase/major-purchase.service.ts',
      'dtp/dtp.service.ts',
    ];
    const found: string[] = [];
    for (const rel of sites) {
      const src = code(join(API_SRC, rel));
      for (const m of src.matchAll(/requireConsent\([^)]*ConsentType\.LOCATION[^)]*\)/g)) {
        found.push(`${rel}: ${m[0]}`);
        expect(m[0]).toMatch(/LOCATION_PURPOSES\./);
      }
    }
    expect(found).toHaveLength(5);
  });

  it('ИЗМЕРЕНИЕ: словарь применений в API и в TMA совпадает строка в строку', () => {
    // Копия существует потому, что общего пакета нет. Расхождение копий
    // — это ровно тот изъян, который пункт закрывает: экран показал бы
    // одни слова, сервер проверил бы другое применение.
    const tma = readFileSync(join(TMA_SRC, 'lib/location-purposes.ts'), 'utf8');
    for (const spec of LOCATION_PURPOSE_SPECS) {
      expect(tma).toContain(`'${spec.purpose}'`);
      expect(tma).toContain(spec.label);
      // На экранной стороне применение в списке записано КОНСТАНТОЙ, а
      // не строкой, поэтому сверяется имя константы рядом с пометкой.
      const constName = Object.entries(LOCATION_PURPOSES).find(([, v]) => v === spec.purpose)![0];
      expect(tma).toMatch(new RegExp(`LOCATION_PURPOSES\\.${constName},[^\\n]*storesCoordinates: ${spec.storesCoordinates}`));
    }
    // И ни одного лишнего применения на экранной стороне.
    const tmaPurposes = [...tma.matchAll(/purpose: LOCATION_PURPOSES\.(\w+)/g)].map((m) => m[1]);
    expect(tmaPurposes).toHaveLength(LOCATION_PURPOSE_SPECS.length);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: экран согласия на AI больше не обещает, что вопрос не сохраняется', () => {
    // Вопрос — это и есть проект. Обещание противоречило устройству
    // продукта, а не детали реализации.
    const gate = code(join(TMA_SRC, 'components/ConsentGate.tsx'));
    expect(gate).not.toMatch(/не\s+сохраняется на нашей стороне/);
    expect(gate).toMatch(/Вопрос сохраняется у нас/);
    // И сказано, что с этим можно сделать — иначе честность становится
    // просто плохой новостью.
    expect(gate).toMatch(/Удалить его можно вместе с проектом/);
  });
});

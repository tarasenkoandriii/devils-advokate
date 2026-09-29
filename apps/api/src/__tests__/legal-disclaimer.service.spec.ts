import { NotFoundException } from '@nestjs/common';
import { LegalDisclaimerService } from '../legal-disclaimer/legal-disclaimer.service';

function createFakePrisma() {
  const users = new Map<string, any>();
  return {
    _seedUser(u: any) {
      users.set(u.id, { country: null, ...u });
    },
    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
    },
  };
}

function makeService(prisma: any) {
  return new LegalDisclaimerService(prisma as any);
}

describe('LegalDisclaimerService', () => {
  it('country="DE", mode=INVESTMENT — bucket=EU, references містить MiFID II, відповідь не null', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', country: 'DE' });
    const service = makeService(prisma);

    const result = await service.getDisclaimer('u1', 'INVESTMENT' as any);

    expect(result).not.toBeNull();
    expect(result!.bucket).toBe('EU');
    expect(result!.references.some((r) => r.actName.includes('MiFID'))).toBe(true);
  });

  // Пункт [silent-jurisdiction] 2026-09-06. Здесь стояло
  // `expect(result).toBeNull()` с пометкой «за прямим запитом
  // користувача: дисклеймер структурно приховано». Решение изменено
  // ТЕМ ЖЕ ВЛАДЕЛЬЦЕМ после измерения: из 36 пар «режим × юрисдикция»
  // были собраны шесть, то есть блок о законе исчезал почти всегда —
  // включая ДТП и семейное право в Украине. Тест переписан вслед за
  // решением, а не код подогнан под старый тест.
  // Второй заход [silent-jurisdiction]: UA/INVESTMENT собран, поэтому
  // случай «пробел назван» проверяется на бакете OTHER — он не собран
  // намеренно (честной ссылки «на все прочие страны» не существует).
  it('bucket=OTHER, mode=INVESTMENT — пробел НАЗВАН, а не спрятан (прежнее поведение: null)', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', country: 'BR' });
    const service = makeService(prisma);

    const result = await service.getDisclaimer('u1', 'INVESTMENT' as any);

    expect(result).not.toBeNull();
    expect(result.coverage).toBe('not-researched');
    expect(result.bucket).toBe('OTHER');
    expect(result.references).toEqual([]);
  });

  it('country=null, mode=INTERVIEW_POOL (бакет OTHER) — пробел назван, запит НЕ падає з помилкою', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', country: null });
    const service = makeService(prisma);

    const result = await service.getDisclaimer('u1', 'INTERVIEW_POOL' as any);

    expect(result.coverage).toBe('not-researched');
    expect(result.bucket).toBe('OTHER');
  });

  it('регресійний тест (аудит юрисдикції 2026-08-30): country=НАЗВА (не код) без countryCode — той самий баг, що зробив дисклеймер завжди null для ВСІХ користувачів до фіксу', async () => {
    const prisma = createFakePrisma();
    // Саме так виглядав реальний User.country до фіксу — повна назва, не ISO-код
    // (на відміну від сусіднього тесту вище з country="DE", який випадково
    // проходив і раніше, бо "DE" сам по собі виглядає як код).
    prisma._seedUser({ id: 'u1', country: 'Німеччина', countryCode: null, ipCountryCode: null });
    const service = makeService(prisma);

    const result = await service.getDisclaimer('u1', 'INVESTMENT' as any);

    expect(result).not.toBeNull();
    expect(result!.bucket).toBe('EU');
    expect(result!.references.some((r) => r.actName.includes('MiFID'))).toBe(true);
  });

  it('countryCode (явно вказаний) пріоритетніший за ipCountryCode (по IP)', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', country: 'Deutschland', countryCode: 'DE', ipCountryCode: 'US' });
    const service = makeService(prisma);

    const result = await service.getDisclaimer('u1', 'INVESTMENT' as any);

    expect(result!.bucket).toBe('EU');
  });

  it('немає ні country, ні countryCode — фолбек на ipCountryCode (заголовок Vercel)', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', country: null, countryCode: null, ipCountryCode: 'US' });
    const service = makeService(prisma);

    const result = await service.getDisclaimer('u1', 'INTERVIEW_POOL' as any);

    expect(result).not.toBeNull();
    expect(result!.bucket).toBe('US');
  });

  it('нічого немає взагалі (ні country, ні countryCode, ні ipCountryCode) — OTHER, пробел назван, без падіння', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', country: null, countryCode: null, ipCountryCode: null });
    const service = makeService(prisma);

    await expect(service.getDisclaimer('u1', 'INVESTMENT' as any)).resolves.toMatchObject({ bucket: 'OTHER', coverage: 'not-researched' });
  });

  it('mode=MAJOR_PURCHASE — US/EU/UA зібрано, OTHER чесно названий несобранным', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', country: 'US' });
    prisma._seedUser({ id: 'u2', country: 'DE' });
    prisma._seedUser({ id: 'u3', country: 'UA' });
    prisma._seedUser({ id: 'u4', country: null });
    const service = makeService(prisma);

    const results = await Promise.all([
      service.getDisclaimer('u1', 'MAJOR_PURCHASE' as any),
      service.getDisclaimer('u2', 'MAJOR_PURCHASE' as any),
      service.getDisclaimer('u3', 'MAJOR_PURCHASE' as any),
      service.getDisclaimer('u4', 'MAJOR_PURCHASE' as any),
    ]);

    // Пункт [silent-jurisdiction] 2026-09-06: UA собран в этой сверке,
    // остальные три бакета честно названы несобранными — и это видно
    // на экране, а не только здесь.
    // US, EU и UA собраны во втором заходе; OTHER не собран намеренно.
    expect(results.map((r) => r.coverage)).toEqual(['seeded', 'seeded', 'seeded', 'not-researched']);
    expect(results[2].references.length).toBeGreaterThan(0);
  });

  it('country="US", mode=INTERVIEW_POOL — NYC LL144 присутній, з явним застереженням про лише резидентів NYC', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', country: 'US' });
    const service = makeService(prisma);

    const result = await service.getDisclaimer('u1', 'INTERVIEW_POOL' as any);

    expect(result).not.toBeNull();
    expect(result!.references.some((r) => r.actName.includes('NYC'))).toBe(true);
    expect(result!.references[0].summary).toContain('NYC');
  });

  it('невідомий userId — NotFoundException, не мовчазний дефолт', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma);

    await expect(service.getDisclaimer('nonexistent', 'INVESTMENT' as any)).rejects.toThrow(NotFoundException);
  });

  it('country у нижньому регістрі досі коректно резолвиться (кейс-нечутливість)', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', country: 'de' });
    const service = makeService(prisma);

    const result = await service.getDisclaimer('u1', 'INVESTMENT' as any);

    expect(result).not.toBeNull();
    expect(result!.bucket).toBe('EU');
  });
});

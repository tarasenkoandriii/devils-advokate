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

  it('регресійний тест (за прямим запитом користувача): country="UA", mode=INVESTMENT — null, дисклеймер структурно приховано, не показано порожній стан', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', country: 'UA' });
    const service = makeService(prisma);

    const result = await service.getDisclaimer('u1', 'INVESTMENT' as any);

    expect(result).toBeNull();
  });

  it('country=null, mode=INTERVIEW_POOL (бакет OTHER, для якого нічого не досліджено) — null, запит НЕ падає з помилкою', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', country: null });
    const service = makeService(prisma);

    const result = await service.getDisclaimer('u1', 'INTERVIEW_POOL' as any);

    expect(result).toBeNull();
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

  it('нічого немає взагалі (ні country, ні countryCode, ні ipCountryCode) — OTHER, null, без падіння', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', country: null, countryCode: null, ipCountryCode: null });
    const service = makeService(prisma);

    await expect(service.getDisclaimer('u1', 'INVESTMENT' as any)).resolves.toBeNull();
  });

  it('регресійний тест: mode=MAJOR_PURCHASE — null для КОЖНОГО бакета без винятку', async () => {
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

    expect(results.every((r) => r === null)).toBe(true);
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

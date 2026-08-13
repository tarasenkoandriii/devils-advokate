import { ConsentService } from '../consent/consent.service';

function createFakePrisma() {
  const records: any[] = [];
  let idCounter = 0;

  return {
    _records: records,
    consentRecord: {
      findFirst: async ({ where }: any) => {
        const matches = records.filter((r) => {
          if (r.userId !== where.userId) return false;
          if (r.consentType !== where.consentType) return false;
          if (where.granted !== undefined && r.granted !== where.granted) return false;
          if (where.revokedAt === null && r.revokedAt !== null) return false;
          if (where.OR) {
            const orMatch = where.OR.some(
              (cond: any) => (cond.projectId === null && r.projectId === null) || (cond.projectId && cond.projectId === r.projectId),
            );
            if (!orMatch) return false;
          }
          return true;
        });
        return matches[matches.length - 1] ?? null;
      },
      create: async ({ data }: any) => {
        // Эмулируем поведение Prisma: undefined-поля в data не должны
        // затирать дефолты (в реальном клиенте они просто не передаются
        // в SQL) — без этой фильтрации grant() без явного projectId
        // ломает последующий hasActiveConsent() (баг найден именно на
        // этом тесте при первом прогоне, см. Prisma README).
        const cleanData = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        const record = { id: `consent-${++idCounter}`, revokedAt: null, projectId: null, purposes: [], ...cleanData };
        records.push(record);
        return record;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const r of records) {
          if (r.userId === where.userId && r.consentType === where.consentType && r.revokedAt === null) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      },
    },
  };
}

describe('ConsentService', () => {
  it('hasActiveConsent — false, если согласия нет вообще', async () => {
    const prisma = createFakePrisma();
    const service = new ConsentService(prisma as any);
    expect(await service.hasActiveConsent('u1', 'EXTERNAL_AI' as any)).toBe(false);
  });

  it('grant() → hasActiveConsent становится true', async () => {
    const prisma = createFakePrisma();
    const service = new ConsentService(prisma as any);
    await service.grant({ userId: 'u1', consentType: 'EXTERNAL_AI' as any, version: 'v1', source: 'onboarding' });
    expect(await service.hasActiveConsent('u1', 'EXTERNAL_AI' as any)).toBe(true);
  });

  it('revoke() → hasActiveConsent снова false', async () => {
    const prisma = createFakePrisma();
    const service = new ConsentService(prisma as any);
    await service.grant({ userId: 'u1', consentType: 'LOCATION' as any, version: 'v1', source: 'onboarding', purposes: ['weather', 'venue_search'] });
    expect(await service.hasActiveConsent('u1', 'LOCATION' as any)).toBe(true);

    await service.revoke('u1', 'LOCATION' as any);
    expect(await service.hasActiveConsent('u1', 'LOCATION' as any)).toBe(false);
  });

  it('requireConsent() бросает ForbiddenException без согласия', async () => {
    const prisma = createFakePrisma();
    const service = new ConsentService(prisma as any);
    await expect(service.requireConsent('u1', 'EXTERNAL_AI' as any)).rejects.toThrow();
  });

  it('requireConsent() не бросает при наличии согласия', async () => {
    const prisma = createFakePrisma();
    const service = new ConsentService(prisma as any);
    await service.grant({ userId: 'u1', consentType: 'EXTERNAL_AI' as any, version: 'v1', source: 'onboarding' });
    await expect(service.requireConsent('u1', 'EXTERNAL_AI' as any)).resolves.toBeUndefined();
  });

  it('согласие для одного пользователя не действует для другого', async () => {
    const prisma = createFakePrisma();
    const service = new ConsentService(prisma as any);
    await service.grant({ userId: 'u1', consentType: 'EXTERNAL_AI' as any, version: 'v1', source: 'onboarding' });
    expect(await service.hasActiveConsent('u2', 'EXTERNAL_AI' as any)).toBe(false);
  });
});

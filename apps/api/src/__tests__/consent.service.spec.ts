import { ConsentService } from '../consent/consent.service';

// ПОВТОРНЫЙ АУДИТ 2026-08-30 — мок переписан. Прежняя версия
// воспроизводила ЗАДУМАННУЮ семантику Prisma, а не фактическую:
// условие `cond.projectId && cond.projectId === r.projectId` при
// projectId === undefined давало false, то есть мок вёл себя так, как
// автор хотел, чтобы вёл себя Prisma. Настоящий клиент вырезает
// undefined-поля, `{}` внутри OR подходит любой записи — и реальная
// дыра (точечное согласие работает как глобальное) была для этого
// теста невидима. Теперь мок повторяет поведение Prisma буквально,
// поэтому регрессия к прежнему коду его роняет.
function matchesCondition(record: any, cond: any): boolean {
  // Prisma отбрасывает undefined-поля: условие без единого
  // определённого поля не ограничивает ничего.
  const defined = Object.entries(cond).filter(([, v]) => v !== undefined);
  if (defined.length === 0) return true;
  return defined.every(([key, value]) => record[key] === value);
}

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
          if ('projectId' in where && where.projectId !== undefined && r.projectId !== where.projectId) return false;
          if ('projectId' in where && where.projectId === null && r.projectId !== null) return false;
          if (where.OR) {
            const orMatch = where.OR.some((cond: any) => matchesCondition(r, cond));
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
          if (r.userId !== where.userId) continue;
          if (r.consentType !== where.consentType) continue;
          if (where.revokedAt === null && r.revokedAt !== null) continue;
          // Тот же буквальный разбор OR, что и в findFirst — иначе
          // «отзыв по проекту» тестировался бы не на том фильтре.
          if (where.OR && !where.OR.some((cond: any) => matchesCondition(r, cond))) continue;
          Object.assign(r, data);
          count++;
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

  it('КЛЮЧЕВОЙ ТЕСТ (повторный аудит 2026-08-30): точечное согласие на ОДИН проект НЕ считается глобальным', async () => {
    const prisma = createFakePrisma();
    const service = new ConsentService(prisma as any);
    await service.grant({
      userId: 'u1',
      consentType: 'THIRD_PARTY_AUDIO_RECORDING' as any,
      version: 'v1',
      source: 'conversation-record-modal',
      projectId: 'p1',
    });

    // Проверка без projectId — это «глобальное ли согласие?». Раньше
    // возвращала true из-за вырожденного OR: живая транскрипция,
    // голосовая биометрия и HEALTH_DATA проверяются именно так.
    expect(await service.hasActiveConsent('u1', 'THIRD_PARTY_AUDIO_RECORDING' as any)).toBe(false);
    // В своём проекте согласие, разумеется, действует.
    expect(await service.hasActiveConsent('u1', 'THIRD_PARTY_AUDIO_RECORDING' as any, 'p1')).toBe(true);
    // В чужом проекте — нет.
    expect(await service.hasActiveConsent('u1', 'THIRD_PARTY_AUDIO_RECORDING' as any, 'p2')).toBe(false);
  });

  it('глобальное согласие (projectId=null) действует в любом проекте', async () => {
    const prisma = createFakePrisma();
    const service = new ConsentService(prisma as any);
    await service.grant({ userId: 'u1', consentType: 'EXTERNAL_AI' as any, version: 'v1', source: 'onboarding' });

    expect(await service.hasActiveConsent('u1', 'EXTERNAL_AI' as any)).toBe(true);
    expect(await service.hasActiveConsent('u1', 'EXTERNAL_AI' as any, 'p-любой')).toBe(true);
  });

  it('отзыв без projectId отзывает и точечные согласия — сомнение в пользу отзыва, не обработки', async () => {
    const prisma = createFakePrisma();
    const service = new ConsentService(prisma as any);
    await service.grant({ userId: 'u1', consentType: 'LOCATION' as any, version: 'v1', source: 'onboarding', projectId: 'p1' });
    await service.grant({ userId: 'u1', consentType: 'LOCATION' as any, version: 'v1', source: 'onboarding', projectId: 'p2' });

    await service.revoke('u1', 'LOCATION' as any);

    expect(await service.hasActiveConsent('u1', 'LOCATION' as any, 'p1')).toBe(false);
    expect(await service.hasActiveConsent('u1', 'LOCATION' as any, 'p2')).toBe(false);
  });

  it('согласие для одного пользователя не действует для другого', async () => {
    const prisma = createFakePrisma();
    const service = new ConsentService(prisma as any);
    await service.grant({ userId: 'u1', consentType: 'EXTERNAL_AI' as any, version: 'v1', source: 'onboarding' });
    expect(await service.hasActiveConsent('u2', 'EXTERNAL_AI' as any)).toBe(false);
  });
});

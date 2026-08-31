import { PrivacyCenterService } from '../privacy-center/privacy-center.service';
import { NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const consents: any[] = [];
  const projects: any[] = [];
  const people = new Map<string, any>();
  const personFacts: any[] = [];
  const projectPersonLinks: any[] = [];

  return {
    _seedConsent(c: any) { consents.push(c); },
    _seedProject(p: any) { projects.push(p); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedFact(f: any) { personFacts.push(f); },
    _seedProjectPersonLink(l: any) { projectPersonLinks.push(l); },
    _personExists(id: string) { return people.has(id); },
    _factsForPerson(personId: string) { return personFacts.filter((f) => f.personId === personId); },

    consentRecord: {
      findMany: async ({ where }: any) =>
        consents.filter((c) => c.userId === where.userId && (where.revokedAt === null ? c.revokedAt === null : true)),
    },
    project: {
      count: async ({ where }: any) => projects.filter((p) => p.ownerId === where.ownerId).length,
      findMany: async ({ where }: any) => projects.filter((p) => p.ownerId === where.ownerId),
    },
    person: {
      findMany: async ({ where }: any) => {
        return [...people.values()]
          .filter((p) => p.createdByUserId === where.createdByUserId)
          .map((p) => ({
            ...p,
            _count: {
              facts: personFacts.filter((f) => f.personId === p.id).length,
              projectLinks: projectPersonLinks.filter((l) => l.personId === p.id).length,
            },
            facts: personFacts.filter((f) => f.personId === p.id),
          }));
      },
      findFirst: async ({ where }: any) => {
        const p = people.get(where.id);
        if (!p || p.createdByUserId !== where.createdByUserId) return null;
        return p;
      },
      delete: async ({ where }: any) => {
        const p = people.get(where.id);
        people.delete(where.id);
        // Симулируем то же самое, что настоящий Postgres сделал бы
        // через onDelete: Cascade — но это ИМИТАЦИЯ, не проверка
        // реального каскада (тот подтверждён инспекцией schema.prisma,
        // не этим тестом).
        for (let i = personFacts.length - 1; i >= 0; i--) {
          if (personFacts[i].personId === where.id) personFacts.splice(i, 1);
        }
        for (let i = projectPersonLinks.length - 1; i >= 0; i--) {
          if (projectPersonLinks[i].personId === where.id) projectPersonLinks.splice(i, 1);
        }
        return p;
      },
    },
  };
}

const USER_ID = 'user-1';

describe('PrivacyCenterService', () => {
  it('getOverview() агрегирует согласия, число проектов и персон с их счётчиками', async () => {
    const prisma = createFakePrisma();
    prisma._seedConsent({ userId: USER_ID, consentType: 'EXTERNAL_AI', granted: true, revokedAt: null });
    prisma._seedProject({ id: 'proj-1', ownerId: USER_ID });
    prisma._seedProject({ id: 'proj-2', ownerId: USER_ID });
    prisma._seedPerson({ id: 'person-1', createdByUserId: USER_ID, displayName: 'Начальник Иван' });
    prisma._seedFact({ id: 'fact-1', personId: 'person-1' });
    prisma._seedFact({ id: 'fact-2', personId: 'person-1' });
    prisma._seedProjectPersonLink({ personId: 'person-1', projectId: 'proj-1' });

    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { resolve: async () => null } as any);
    const overview = await service.getOverview(USER_ID);

    expect(overview.projectsCount).toBe(2);
    expect(overview.people.length).toBe(1);
    expect(overview.people[0].factsCount).toBe(2);
    expect(overview.people[0].projectsCount).toBe(1);
    expect(overview.consents.length).toBe(1);
  });

  it('getOverview() не показывает персон/проекты других пользователей', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-1', ownerId: 'other-user' });
    prisma._seedPerson({ id: 'person-1', createdByUserId: 'other-user', displayName: 'Чужой' });

    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { resolve: async () => null } as any);
    const overview = await service.getOverview(USER_ID);

    expect(overview.projectsCount).toBe(0);
    expect(overview.people.length).toBe(0);
  });

  it('deletePerson() полностью удаляет персону и её факты (не просто отвязывает)', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: 'person-1', createdByUserId: USER_ID, displayName: 'Начальник Иван' });
    prisma._seedFact({ id: 'fact-1', personId: 'person-1' });
    prisma._seedFact({ id: 'fact-2', personId: 'person-1' });

    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { resolve: async () => null } as any);
    await service.deletePerson(USER_ID, 'person-1');

    expect(prisma._personExists('person-1')).toBe(false);
    expect(prisma._factsForPerson('person-1').length).toBe(0);
  });

  it('deletePerson() отклоняет удаление чужой персоны', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: 'person-1', createdByUserId: 'other-user', displayName: 'Чужой' });

    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { resolve: async () => null } as any);
    await expect(service.deletePerson(USER_ID, 'person-1')).rejects.toThrow(NotFoundException);
    expect(prisma._personExists('person-1')).toBe(true);
  });

  it('exportData() собирает проекты, персон с фактами и согласия одного пользователя', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-1', ownerId: USER_ID });
    prisma._seedPerson({ id: 'person-1', createdByUserId: USER_ID, displayName: 'Иван' });
    prisma._seedFact({ id: 'fact-1', personId: 'person-1', content: 'Факт' });
    prisma._seedConsent({ userId: USER_ID, consentType: 'EXTERNAL_AI', granted: true, revokedAt: null });

    const service = new PrivacyCenterService(prisma as any, { record: async () => undefined } as any, { resolve: async () => null } as any);
    const data = await service.exportData(USER_ID);

    expect(data.projects.length).toBe(1);
    expect(data.people.length).toBe(1);
    expect(data.people[0].facts.length).toBe(1);
    expect(data.consents.length).toBe(1);
    expect(typeof data.exportedAt).toBe('string');
  });
});

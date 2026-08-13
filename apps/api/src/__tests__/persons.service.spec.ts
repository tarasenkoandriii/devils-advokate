import { PersonsService } from '../persons/persons.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const people = new Map<string, any>();
  const links = new Map<string, any>();
  let idCounter = 0;

  const linkKey = (projectId: string, personId: string) => `${projectId}:${personId}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _getLink(projectId: string, personId: string) { return links.get(linkKey(projectId, personId)); },
    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    person: {
      create: async ({ data }: any) => {
        const p = { id: `person-${++idCounter}`, ...data };
        people.set(p.id, p);
        return p;
      },
      findFirst: async ({ where }: any) => {
        const p = people.get(where.id);
        if (!p || p.createdByUserId !== where.createdByUserId) return null;
        return p;
      },
    },
    projectPerson: {
      upsert: async ({ where, create }: any) => {
        const key = linkKey(where.projectId_personId.projectId, where.projectId_personId.personId);
        if (links.has(key)) return { ...links.get(key), person: people.get(where.projectId_personId.personId) };
        const link = { id: `link-${++idCounter}`, createdAt: new Date(), ...create };
        links.set(key, link);
        return { ...link, person: people.get(create.personId) };
      },
      findMany: async ({ where }: any) => {
        return [...links.values()]
          .filter((l) => l.projectId === where.projectId)
          .map((l) => ({ ...l, person: people.get(l.personId) }));
      },
      findUnique: async ({ where }: any) => {
        const key = linkKey(where.projectId_personId.projectId, where.projectId_personId.personId);
        return links.get(key) ?? null;
      },
      update: async ({ where, data }: any) => {
        const key = linkKey(where.projectId_personId.projectId, where.projectId_personId.personId);
        const merged = { ...links.get(key), ...data };
        links.set(key, merged);
        return { ...merged, person: people.get(merged.personId) };
      },
      delete: async ({ where }: any) => {
        const key = linkKey(where.projectId_personId.projectId, where.projectId_personId.personId);
        const link = links.get(key);
        links.delete(key);
        return link;
      },
    },
  };
}

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';

function seedOwnedProject(prisma: any) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
}

describe('PersonsService', () => {
  it('addPerson() создаёт новую персону со статусом PERSONA', async () => {
    const prisma = createFakePrisma();
    seedOwnedProject(prisma);
    const service = new PersonsService(prisma as any);

    const link = await service.addPerson(USER_ID, PROJECT_ID, {});
    expect(link.status).toBe('PERSONA');
    expect(link.statusConfirmedByUser).toBe(true);
  });

  it('addPerson() отклоняет чужой проект', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const service = new PersonsService(prisma as any);

    await expect(service.addPerson(USER_ID, PROJECT_ID, {})).rejects.toThrow(NotFoundException);
  });

  it('addPerson() с existingPersonId привязывает существующую персону', async () => {
    const prisma = createFakePrisma();
    seedOwnedProject(prisma);
    const service = new PersonsService(prisma as any);
    const person = await prisma.person.create({ data: { createdByUserId: USER_ID } });

    const link = await service.addPerson(USER_ID, PROJECT_ID, { existingPersonId: person.id });
    expect(link.personId).toBe(person.id);
  });

  it('addPerson() отклоняет чужую existingPersonId', async () => {
    const prisma = createFakePrisma();
    seedOwnedProject(prisma);
    const service = new PersonsService(prisma as any);
    const foreignPerson = await prisma.person.create({ data: { createdByUserId: 'other-user' } });

    await expect(
      service.addPerson(USER_ID, PROJECT_ID, { existingPersonId: foreignPerson.id }),
    ).rejects.toThrow(NotFoundException);
  });

  it('updateStatus() с trigger=MANUAL применяется сразу без confirmed', async () => {
    const prisma = createFakePrisma();
    seedOwnedProject(prisma);
    const service = new PersonsService(prisma as any);
    const link = await service.addPerson(USER_ID, PROJECT_ID, {});

    const updated = await service.updateStatus(USER_ID, PROJECT_ID, link.personId, {
      status: 'FIGURANT' as any,
      trigger: 'MANUAL' as any,
    });
    expect(updated.status).toBe('FIGURANT');
    expect(updated.statusConfirmedByUser).toBe(true);
  });

  it('updateStatus() с trigger=CONFLICT_DETECTOR_SUGGESTED без confirmed=true отклоняется (§3.7)', async () => {
    const prisma = createFakePrisma();
    seedOwnedProject(prisma);
    const service = new PersonsService(prisma as any);
    const link = await service.addPerson(USER_ID, PROJECT_ID, {});

    await expect(
      service.updateStatus(USER_ID, PROJECT_ID, link.personId, {
        status: 'FIGURANT' as any,
        trigger: 'CONFLICT_DETECTOR_SUGGESTED' as any,
      }),
    ).rejects.toThrow(BadRequestException);

    const stillPersona = await prisma.projectPerson.findUnique({
      where: { projectId_personId: { projectId: PROJECT_ID, personId: link.personId } },
    });
    expect(stillPersona.status).toBe('PERSONA');
  });

  it('updateStatus() с trigger=CONFLICT_DETECTOR_SUGGESTED и confirmed=true применяется', async () => {
    const prisma = createFakePrisma();
    seedOwnedProject(prisma);
    const service = new PersonsService(prisma as any);
    const link = await service.addPerson(USER_ID, PROJECT_ID, {});

    const updated = await service.updateStatus(USER_ID, PROJECT_ID, link.personId, {
      status: 'FIGURANT' as any,
      trigger: 'CONFLICT_DETECTOR_SUGGESTED' as any,
      confirmed: true,
    });
    expect(updated.status).toBe('FIGURANT');
    expect(updated.statusConfirmedByUser).toBe(true);
  });

  it('updateStatus() бросает NotFoundException для персоны не из этого проекта', async () => {
    const prisma = createFakePrisma();
    seedOwnedProject(prisma);
    const service = new PersonsService(prisma as any);

    await expect(
      service.updateStatus(USER_ID, PROJECT_ID, 'does-not-exist', {
        status: 'FIGURANT' as any,
        trigger: 'MANUAL' as any,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('removePerson() отвязывает персону от проекта', async () => {
    const prisma = createFakePrisma();
    seedOwnedProject(prisma);
    const service = new PersonsService(prisma as any);
    const link = await service.addPerson(USER_ID, PROJECT_ID, {});

    await service.removePerson(USER_ID, PROJECT_ID, link.personId);
    expect(prisma._getLink(PROJECT_ID, link.personId)).toBeUndefined();
  });

  it('listPeople() отклоняет чужой проект', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const service = new PersonsService(prisma as any);

    await expect(service.listPeople(USER_ID, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });
});

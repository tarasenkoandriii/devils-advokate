import { ForbiddenException } from '@nestjs/common';
import { AuditLogService } from '../audit-log/audit-log.service';

function createFakePrisma() {
  const users = new Map<string, any>();
  const entries: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedUser(u: any) {
      users.set(u.id, { isOperator: false, ...u });
    },
    _getEntries() {
      return entries;
    },

    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
    },
    auditLogEntry: {
      create: async ({ data }: any) => {
        const entry = { id: nextId(), createdAt: new Date(), ...data };
        entries.push(entry);
        return entry;
      },
      findMany: async ({ where }: any) => {
        return entries
          .filter((e) => {
            if (where.resource !== undefined && e.resource !== where.resource) return false;
            if (where.resourceId !== undefined && e.resourceId !== where.resourceId) return false;
            if (where.actorId !== undefined && e.actorId !== where.actorId) return false;
            return true;
          })
          .sort((a, b) => b.createdAt - a.createdAt);
      },
    },
  };
}

function makeService(prisma: any) {
  return new AuditLogService(prisma as any);
}

describe('AuditLogService', () => {
  it('record() створює запис з actorId/action/resource/resourceId/before/after', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma);

    const entry = await service.record({
      actorId: 'op1',
      action: 'user.restricted',
      resource: 'User',
      resourceId: 'target1',
      before: { isRestricted: false },
      after: { isRestricted: true },
    });

    expect(entry.actorId).toBe('op1');
    expect(entry.action).toBe('user.restricted');
    expect(prisma._getEntries().length).toBe(1);
  });

  it('record() приймає actorId=null для системних дій', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma);

    const entry = await service.record({ action: 'system.cleanup', resource: 'Blob', resourceId: 'x' });

    expect(entry.actorId).toBeNull();
  });

  it('list() доступний тільки оператору', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    prisma._seedUser({ id: 'regular', isOperator: false });
    const service = makeService(prisma);
    await service.record({ actorId: 'op1', action: 'user.restricted', resource: 'User', resourceId: 't1' });

    await expect(service.list('regular')).rejects.toThrow(ForbiddenException);
    const result = await service.list('op1');
    expect(result.length).toBe(1);
  });

  it('list() фільтрує за resource/resourceId', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const service = makeService(prisma);
    await service.record({ actorId: 'op1', action: 'user.restricted', resource: 'User', resourceId: 't1' });
    await service.record({ actorId: 'op1', action: 'library_entry.moderated', resource: 'LibraryEntry', resourceId: 'e1' });

    const userEvents = await service.list('op1', { resource: 'User' });

    expect(userEvents.length).toBe(1);
    expect(userEvents[0].resource).toBe('User');
  });
});

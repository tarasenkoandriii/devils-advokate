import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminUsersService } from '../admin-users/admin-users.service';

function createFakePrisma() {
  const users = new Map<string, any>();
  const projects: any[] = [];
  const conversations: any[] = [];
  const adminSessions: any[] = [];
  let idCounter = 0;

  return {
    _seedUser(u: any) {
      const user = {
        isOperator: false,
        isRestricted: false,
        restrictedAt: null,
        restrictedNote: null,
        isBlocked: false,
        blockedAt: null,
        blockedNote: null,
        isLibraryModerator: false,
        isVenueModerator: false,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        ...u,
      };
      users.set(user.id, user);
      return user;
    },
    _seedProject(p: any) {
      projects.push({ id: `p-${++idCounter}`, ...p });
    },
    _seedConversation(c: any) {
      conversations.push({ id: `c-${++idCounter}`, ...c });
    },
    _seedAdminSession(sess: any) {
      adminSessions.push({ id: `s-${++idCounter}`, ...sess });
    },
    _getAdminSessions() {
      return adminSessions;
    },

    // Повторный аудит 2026-08-30: блокировка теперь уничтожает активные
    // сессии админки — раньше заблокированный оператор сохранял доступ
    // к ней до истечения семидневной cookie.
    adminSession: {
      deleteMany: async ({ where }: any) => {
        const before = adminSessions.length;
        for (let i = adminSessions.length - 1; i >= 0; i--) {
          if (adminSessions[i].userId === where.userId) adminSessions.splice(i, 1);
        }
        return { count: before - adminSessions.length };
      },
    },
    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
      findMany: async ({ where }: any) => {
        let rows = [...users.values()];
        if (where?.telegramId?.contains) {
          rows = rows.filter((u) => u.telegramId.includes(where.telegramId.contains));
        }
        if (where?.isRestricted !== undefined) {
          rows = rows.filter((u) => u.isRestricted === where.isRestricted);
        }
        if (where?.isBlocked !== undefined) {
          rows = rows.filter((u) => u.isBlocked === where.isBlocked);
        }
        return rows;
      },
      update: async ({ where, data }: any) => {
        const u = users.get(where.id);
        Object.assign(u, data);
        return u;
      },
    },
    project: {
      count: async ({ where }: any) => projects.filter((p) => p.ownerId === where.ownerId).length,
      findFirst: async ({ where }: any) => {
        const rows = projects.filter((p) => p.ownerId === where.ownerId).sort((a, b) => b.createdAt - a.createdAt);
        return rows[0] ?? null;
      },
    },
    conversation: {
      count: async ({ where }: any) =>
        conversations.filter((c) => c.project?.ownerId === where.project.ownerId).length,
      findFirst: async ({ where }: any) => {
        const rows = conversations
          .filter((c) => c.project?.ownerId === where.project.ownerId)
          .sort((a, b) => b.createdAt - a.createdAt);
        return rows[0] ?? null;
      },
    },
  };
}

function makeService(prisma: any) {
  return new AdminUsersService(prisma as any, { record: async () => ({}) } as any);
}

describe('AdminUsersService', () => {
  it('отклоняет операции для пользователя без isOperator', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', telegramId: '111', isOperator: false });
    const service = makeService(prisma);

    await expect(service.listUsers('u1')).rejects.toThrow(ForbiddenException);
  });

  it('listUsers фильтрует по telegramId (search) и isRestricted', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
    prisma._seedUser({ id: 'u1', telegramId: '111222333', isRestricted: true });
    prisma._seedUser({ id: 'u2', telegramId: '111999888', isRestricted: false });
    const service = makeService(prisma);

    const bySearch = await service.listUsers('op1', '111222');
    expect(bySearch.map((u) => u.id)).toEqual(['u1']);

    const byRestricted = await service.listUsers('op1', undefined, true);
    expect(byRestricted.map((u) => u.id)).toEqual(['u1']);
  });

  it('getUserDetail считает projectCount/conversationCount и lastActivityAt по самой свежей метке', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
    prisma._seedUser({ id: 'target', telegramId: 'target', createdAt: new Date('2026-01-01T00:00:00Z') });
    prisma._seedProject({ ownerId: 'target', createdAt: new Date('2026-02-01T00:00:00Z') });
    prisma._seedProject({ ownerId: 'target', createdAt: new Date('2026-03-01T00:00:00Z') });
    prisma._seedConversation({ project: { ownerId: 'target' }, createdAt: new Date('2026-04-01T00:00:00Z') });
    const service = makeService(prisma);

    const detail = await service.getUserDetail('op1', 'target');

    expect(detail.projectCount).toBe(2);
    expect(detail.conversationCount).toBe(1);
    expect(detail.lastActivityAt).toEqual(new Date('2026-04-01T00:00:00Z'));
  });

  it('getUserDetail с несуществующим id даёт NotFoundException', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
    const service = makeService(prisma);

    await expect(service.getUserDetail('op1', 'nonexistent')).rejects.toThrow(NotFoundException);
  });

  it('acceptance-тест §5.3: restrictUser выставляет isRestricted/restrictedAt/restrictedNote при ограничении', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
    prisma._seedUser({ id: 'target', telegramId: 'target', isRestricted: false });
    const service = makeService(prisma);

    const updated = await service.restrictUser('op1', 'target', true, 'подозрительная активность');

    expect(updated.isRestricted).toBe(true);
    expect(updated.restrictedAt).toBeInstanceOf(Date);
    expect(updated.restrictedNote).toBe('подозрительная активность');
  });

  it('регресійний тест (Пункт [audit-log]): restrictUser РЕАЛЬНО викликає auditLog.record — раніше коментар обіцяв це, код не робив', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
    prisma._seedUser({ id: 'target', telegramId: 'target', isRestricted: false, restrictedNote: null });

    const recordedCalls: any[] = [];
    const auditLog = { record: async (input: any) => { recordedCalls.push(input); return {}; } };
    const service = new AdminUsersService(prisma as any, auditLog as any);

    await service.restrictUser('op1', 'target', true, 'причина');

    expect(recordedCalls.length).toBe(1);
    expect(recordedCalls[0].actorId).toBe('op1');
    expect(recordedCalls[0].action).toBe('user.restricted');
    expect(recordedCalls[0].resource).toBe('User');
    expect(recordedCalls[0].resourceId).toBe('target');
    expect(recordedCalls[0].after.isRestricted).toBe(true);
  });

  it('снятие ограничения честно очищает restrictedAt/restrictedNote, не оставляет устаревшую причину', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
    prisma._seedUser({
      id: 'target',
      telegramId: 'target',
      isRestricted: true,
      restrictedAt: new Date(),
      restrictedNote: 'old reason',
    });
    const service = makeService(prisma);

    const updated = await service.restrictUser('op1', 'target', false);

    expect(updated.isRestricted).toBe(false);
    expect(updated.restrictedAt).toBeNull();
    expect(updated.restrictedNote).toBeNull();
  });

  it('restrictUser с несуществующим target даёт NotFoundException', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
    const service = makeService(prisma);

    await expect(service.restrictUser('op1', 'nonexistent', true)).rejects.toThrow(NotFoundException);
  });

  it('acceptance-тест (НАЙВАЖЛИВІШИЙ, Пункт [full-block]): blockUser виставляє isBlocked/blockedAt/blockedNote', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
    prisma._seedUser({ id: 'target', telegramId: 'target', isBlocked: false });
    const service = makeService(prisma);

    const updated = await service.blockUser('op1', 'target', true, 'зловживання');

    expect(updated.isBlocked).toBe(true);
    expect(updated.blockedAt).toBeInstanceOf(Date);
    expect(updated.blockedNote).toBe('зловживання');
  });

  it('acceptance-тест (НАЙВАЖЛИВІШИЙ, Пункт [full-block]): isBlocked і isRestricted — незалежні прапорці, зміна одного не чіпає інший', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
    prisma._seedUser({ id: 'target', telegramId: 'target', isRestricted: true, isBlocked: false });
    const service = makeService(prisma);

    const updated = await service.blockUser('op1', 'target', true, 'зловживання');

    expect(updated.isBlocked).toBe(true);
    expect(updated.isRestricted).toBe(true); // не зачеплено — той самий принцип, що для isOperator/isLibraryModerator
  });

  it('зняття блокування чесно очищає blockedAt/blockedNote', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
    prisma._seedUser({
      id: 'target',
      telegramId: 'target',
      isBlocked: true,
      blockedAt: new Date(),
      blockedNote: 'old reason',
    });
    const service = makeService(prisma);

    const updated = await service.blockUser('op1', 'target', false);

    expect(updated.isBlocked).toBe(false);
    expect(updated.blockedAt).toBeNull();
    expect(updated.blockedNote).toBeNull();
  });

  it('регресійний тест (Пункт [full-block]): blockUser реально викликає auditLog.record', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
    prisma._seedUser({ id: 'target', telegramId: 'target', isBlocked: false });

    const recordedCalls: any[] = [];
    const auditLog = { record: async (input: any) => { recordedCalls.push(input); return {}; } };
    const service = new AdminUsersService(prisma as any, auditLog as any);

    await service.blockUser('op1', 'target', true, 'причина');

    expect(recordedCalls.length).toBe(1);
    expect(recordedCalls[0].action).toBe('user.blocked');
    expect(recordedCalls[0].after.isBlocked).toBe(true);
  });

  it('blockUser с несуществующим target даёт NotFoundException', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
    const service = makeService(prisma);

    await expect(service.blockUser('op1', 'nonexistent', true)).rejects.toThrow(NotFoundException);
  });

  it('регресійний тест (НАЙВАЖЛИВІШИЙ, аудит UI): blockUser відхиляє спробу заблокувати самого себе — захист від self-lockout', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true, isBlocked: false });
    const service = makeService(prisma);

    await expect(service.blockUser('op1', 'op1', true, 'помилка')).rejects.toThrow(ForbiddenException);

    const stillUnblocked = await service.getUserDetail('op1', 'op1');
    expect(stillUnblocked.isBlocked).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (повторный аудит 2026-08-30): блокировка уничтожает активные сессии админки заблокированного', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
    prisma._seedUser({ id: 'u2', telegramId: 'target' });
    prisma._seedAdminSession({ userId: 'u2', token: 't-target', expiresAt: new Date(Date.now() + 86400000) });
    prisma._seedAdminSession({ userId: 'op1', token: 't-operator', expiresAt: new Date(Date.now() + 86400000) });
    const service = makeService(prisma);

    await service.blockUser('op1', 'u2', true, 'спам');

    const remaining = prisma._getAdminSessions();
    expect(remaining.map((s: any) => s.token)).toEqual(['t-operator']);
  });

  it('снятие блокировки чужие сессии не трогает — удаление только при блокировке', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true });
    prisma._seedUser({ id: 'u2', telegramId: 'target', isBlocked: true });
    prisma._seedAdminSession({ userId: 'op1', token: 't-operator', expiresAt: new Date(Date.now() + 86400000) });
    const service = makeService(prisma);

    await service.blockUser('op1', 'u2', false);

    expect(prisma._getAdminSessions().length).toBe(1);
  });

  it('розблокувати самого себе дозволено — self-lockout захист стосується тільки блокування, не зняття', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', telegramId: 'op', isOperator: true, isBlocked: true });
    const service = makeService(prisma);

    const result = await service.blockUser('op1', 'op1', false);

    expect(result.isBlocked).toBe(false);
  });
});

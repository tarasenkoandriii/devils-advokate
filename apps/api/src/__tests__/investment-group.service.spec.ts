import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InvestmentGroupService } from '../investment/investment-group.service';

// Пункт [deep-links] 2026-09-02: ссылки-приглашения строятся из
// окружения. Раньше в них стоял литерал `t.me/<bot>` — ссылка в никуда
// при живом токене; теперь без переменной сервис честно отвечает 503,
// поэтому тестам нужна заданная переменная.
process.env.TELEGRAM_BOT_USERNAME = 'da_test_bot';

function createFakePrisma() {
  const groups = new Map<string, any>();
  const members: any[] = [];
  const invites: any[] = [];
  const projects = new Map<string, any>();
  const configs = new Map<string, any>();
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  const client: any = {
    _seedGroup(g: any) {
      const group = { id: nextId(), ...g };
      groups.set(group.id, group);
      return group;
    },
    _seedMember(m: any) {
      const member = { id: nextId(), joinedAt: new Date(), pledgedAmount: null, ...m };
      members.push(member);
      return member;
    },
    _seedProject(p: any) {
      const project = { id: nextId(), ...p };
      projects.set(project.id, project);
      return project;
    },
    _seedConfig(c: any) {
      const config = { id: nextId(), ...c };
      configs.set(config.id, config);
      return config;
    },
    _getMembers() {
      return members;
    },
    _getInvites() {
      return invites;
    },

    investmentGroup: {
      create: async ({ data }: any) => {
        const group = { id: nextId(), ...data };
        groups.set(group.id, group);
        return group;
      },
    },
    investmentGroupMember: {
      create: async ({ data }: any) => {
        const member = { id: nextId(), joinedAt: new Date(), pledgedAmount: null, ...data };
        members.push(member);
        return member;
      },
      findUnique: async ({ where }: any) => {
        const key = where.groupId_userId;
        return members.find((m) => m.groupId === key.groupId && m.userId === key.userId) ?? null;
      },
      findMany: async ({ where }: any) => members.filter((m) => m.groupId === where.groupId),
      update: async ({ where, data }: any) => {
        const m = members.find((mm) => mm.id === where.id);
        Object.assign(m, data);
        return m;
      },
    },
    investmentGroupInvite: {
      create: async ({ data }: any) => {
        const invite = { id: nextId(), ...data };
        invites.push(invite);
        return invite;
      },
      findUnique: async ({ where }: any) => invites.find((i) => i.token === where.token) ?? null,
    },
    project: {
      findUnique: async ({ where }: any) => projects.get(where.id) ?? null,
    },
    investmentConfig: {
      findUnique: async ({ where }: any) => [...configs.values()].find((c) => c.projectId === where.projectId) ?? null,
    },
  };
  client.$transaction = async (fn: (tx: any) => Promise<any>) => fn(client);
  return client;
}

function makeService(prisma: any) {
  return new InvestmentGroupService(prisma as any);
}

describe('InvestmentGroupService', () => {
  it('createGroup — творець стає OWNER', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma);

    const group = await service.createGroup('u1', 'Друзі-інвестори');

    const membership = prisma._getMembers().find((m: any) => m.groupId === group.id);
    expect(membership.role).toBe('OWNER');
  });

  it('createGroup відхиляє порожнє ім\'я', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma);
    await expect(service.createGroup('u1', '  ')).rejects.toThrow(BadRequestException);
  });

  it('acceptance-тест §7 ТЗ: createInviteLink доступний тільки OWNER, не MEMBER', async () => {
    const prisma = createFakePrisma();
    const group = prisma._seedGroup({ name: 'Група' });
    prisma._seedMember({ groupId: group.id, userId: 'owner', role: 'OWNER' });
    prisma._seedMember({ groupId: group.id, userId: 'regular', role: 'MEMBER' });
    const service = makeService(prisma);

    await expect(service.createInviteLink('regular', group.id)).rejects.toThrow(ForbiddenException);
    await expect(service.createInviteLink('owner', group.id)).resolves.toBeDefined();
  });

  it('acceptance-тест §7 ТЗ: joinGroup без валідного токена — BadRequestException, публічного приєднання не існує', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma);

    await expect(service.joinGroup('u1', 'invalid-token')).rejects.toThrow(BadRequestException);
  });

  it('joinGroup з простроченим токеном відхиляється', async () => {
    const prisma = createFakePrisma();
    const group = prisma._seedGroup({ name: 'Група' });
    prisma._seedMember({ groupId: group.id, userId: 'owner', role: 'OWNER' });
    const service = makeService(prisma);
    const { token } = await service.createInviteLink('owner', group.id);
    const invite = prisma._getInvites().find((i: any) => i.token === token);
    invite.expiresAt = new Date(Date.now() - 1000);

    await expect(service.joinGroup('newcomer', token)).rejects.toThrow(BadRequestException);
  });

  it('joinGroup з валідним токеном додає MEMBER', async () => {
    const prisma = createFakePrisma();
    const group = prisma._seedGroup({ name: 'Група' });
    prisma._seedMember({ groupId: group.id, userId: 'owner', role: 'OWNER' });
    const service = makeService(prisma);
    const { token } = await service.createInviteLink('owner', group.id);

    const membership = await service.joinGroup('newcomer', token);

    expect(membership.role).toBe('MEMBER');
  });

  it('setPledge встановлює лише ВЛАСНИЙ pledgedAmount, не член групи — NotFoundException', async () => {
    const prisma = createFakePrisma();
    const group = prisma._seedGroup({ name: 'Група' });
    prisma._seedMember({ groupId: group.id, userId: 'member1', role: 'MEMBER' });
    const service = makeService(prisma);

    const updated = await service.setPledge('member1', group.id, 30000);
    expect(updated.pledgedAmount).toBe(30000);

    await expect(service.setPledge('stranger', group.id, 1000)).rejects.toThrow(NotFoundException);
  });

  it('setPledge відхиляє від\'ємну суму', async () => {
    const prisma = createFakePrisma();
    const group = prisma._seedGroup({ name: 'Група' });
    prisma._seedMember({ groupId: group.id, userId: 'member1', role: 'MEMBER' });
    const service = makeService(prisma);

    await expect(service.setPledge('member1', group.id, -100)).rejects.toThrow(BadRequestException);
  });

  it('acceptance-тест §7 ТЗ: getProjectProgress рахує totalPledged арифметично, БЕЗ поля actuallyContributed', async () => {
    const prisma = createFakePrisma();
    const group = prisma._seedGroup({ name: 'Група' });
    const project = prisma._seedProject({ ownerId: 'owner', investmentGroupId: group.id });
    prisma._seedConfig({ projectId: project.id, targetBudget: 100000, currency: 'USD' });
    prisma._seedMember({ groupId: group.id, userId: 'u1', pledgedAmount: 30000 });
    prisma._seedMember({ groupId: group.id, userId: 'u2', pledgedAmount: 40000 });
    prisma._seedMember({ groupId: group.id, userId: 'u3', pledgedAmount: 20000 });
    const service = makeService(prisma);

    const progress = await service.getProjectProgress('u1', project.id);

    expect(progress.totalPledged).toBe(90000);
    expect(progress.targetBudget).toBe(100000);
    expect(Object.keys(progress)).not.toContain('actuallyContributed');
  });

  it('getProjectProgress для проєкту без групи — NotFoundException', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', investmentGroupId: null });
    const service = makeService(prisma);

    await expect(service.getProjectProgress('u1', project.id)).rejects.toThrow(NotFoundException);
  });
});

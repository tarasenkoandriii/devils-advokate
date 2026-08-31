import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FamilyLawV2Service } from '../family-law/family-law-v2.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const configs = new Map<string, any>();
  const criteria: any[] = [];
  const advisors = new Map<string, any>();
  const consultations = new Map<string, any>();
  const parties = new Map<string, any>();
  const assets: any[] = [];
  const statusDeterminations: any[] = [];
  const budgetLineItems: any[] = [];
  const goalRevisions: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) {
      const project = { id: nextId(), ...p };
      projects.set(project.id, project);
      return project;
    },
    _seedConfig(c: any) {
      const config = { id: nextId(), targetBudget: null, currency: null, ...c };
      configs.set(config.id, config);
      return config;
    },
    _seedCriterion(c: any) {
      const criterion = { id: nextId(), ...c };
      criteria.push(criterion);
      return criterion;
    },
    _seedAdvisor(a: any) {
      const advisor = { id: nextId(), ...a };
      advisors.set(advisor.id, advisor);
      return advisor;
    },
    _seedConsultation(c: any) {
      const consultation = { id: nextId(), criteriaBreakdown: null, estimatedCost: null, ...c };
      consultations.set(consultation.id, consultation);
      return consultation;
    },
    _seedParty(p: any) {
      const party = { id: nextId(), displayName: null, ...p };
      parties.set(party.id, party);
      return party;
    },
    _seedGoalRevision(g: any) {
      const rec = { id: nextId(), changedAt: new Date(), ...g };
      goalRevisions.push(rec);
      return rec;
    },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        return p && p.ownerId === where.ownerId ? p : null;
      },
    },
    familyLawConfig: {
      findUnique: async ({ where }: any) => configs.get(where.id) ?? null,
      update: async ({ where, data }: any) => {
        const c = configs.get(where.id);
        Object.assign(c, data);
        return c;
      },
    },
    familyLawCriterion: {
      findMany: async ({ where }: any) => criteria.filter((c) => c.configId === where.configId),
      findUnique: async ({ where, include }: any) => {
        const c = criteria.find((cc) => cc.id === where.id);
        if (!c) return null;
        if (include?.config) return { ...c, config: configs.get(c.configId) };
        return c;
      },
    },
    familyLawParty: {
      create: async ({ data }: any) => {
        const p = { id: nextId(), displayName: null, ...data };
        parties.set(p.id, p);
        return p;
      },
      findFirst: async ({ where }: any) =>
        [...parties.values()].find((p) => p.configId === where.configId && p.role === where.role) ?? null,
      findUnique: async ({ where }: any) => parties.get(where.id) ?? null,
      findMany: async ({ where }: any) => [...parties.values()].filter((p) => p.configId === where.configId),
    },
    familyLawAsset: {
      create: async ({ data }: any) => {
        const rec = { id: nextId(), ...data };
        assets.push(rec);
        return rec;
      },
      findMany: async ({ where }: any) => assets.filter((a) => a.configId === where.configId),
    },
    familyLawStatusDetermination: {
      create: async ({ data }: any) => {
        const rec = { id: nextId(), ...data };
        statusDeterminations.push(rec);
        return rec;
      },
      findMany: async ({ where, orderBy, take }: any) => {
        let rows = statusDeterminations.filter((s) => s.configId === where.configId);
        if (orderBy?.determinedAt === 'asc') rows = rows.sort((a, b) => a.determinedAt - b.determinedAt);
        if (orderBy?.determinedAt === 'desc') rows = rows.sort((a, b) => b.determinedAt - a.determinedAt);
        if (take) rows = rows.slice(0, take);
        return rows;
      },
    },
    familyLawBudgetLineItem: {
      create: async ({ data }: any) => {
        const rec = { id: nextId(), ...data };
        budgetLineItems.push(rec);
        return rec;
      },
      findMany: async ({ where }: any) => budgetLineItems.filter((b) => b.configId === where.configId),
    },
    familyLawGoalRevision: {
      create: async ({ data }: any) => {
        const rec = { id: nextId(), changedAt: new Date(), ...data };
        goalRevisions.push(rec);
        return rec;
      },
      findMany: async ({ where, orderBy }: any) => {
        let rows = goalRevisions.filter((g) => g.configId === where.configId);
        if (orderBy?.changedAt) rows = rows.sort((a, b) => a.changedAt - b.changedAt);
        return rows;
      },
    },
    familyLawConsultation: {
      findUnique: async ({ where, include }: any) => {
        const c = consultations.get(where.id);
        if (!c) return null;
        if (include?.advisor) return { ...c, advisor: advisors.get(c.advisorId) };
        return c;
      },
      findMany: async ({ where, select, include }: any) => {
        let rows = [...consultations.values()];
        if (where?.advisor?.configId) rows = rows.filter((c) => advisors.get(c.advisorId)?.configId === where.advisor.configId);
        if (where?.estimatedCost?.not === null) rows = rows.filter((c) => c.estimatedCost !== null);
        if (select) rows = rows.map((c) => ({ id: c.id }));
        if (include?.advisor) rows = rows.map((c) => ({ ...c, advisor: advisors.get(c.advisorId) }));
        return rows;
      },
    },
    $transaction: async (fn: any) =>
      fn({
        familyLawConfig: {
          update: async ({ where, data }: any) => {
            const c = configs.get(where.id);
            Object.assign(c, data);
            return c;
          },
        },
        familyLawGoalRevision: {
          create: async ({ data }: any) => {
            const rec = { id: nextId(), changedAt: new Date(), ...data };
            goalRevisions.push(rec);
            return rec;
          },
        },
      }),
  };
}

function makeService(prisma: any, comparison: any = { compare: async () => ({ status: 'NO_DISCREPANCY_FOUND', statements: [] }) }) {
  return new FamilyLawV2Service(prisma as any, comparison as any);
}

describe('FamilyLawV2Service', () => {
  it('acceptance-тест: не більше однієї сторони з role=SELF на конфіг', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    await service.createParty('u1', config.id, 'SELF' as any);
    await expect(service.createParty('u1', config.id, 'SELF' as any)).rejects.toThrow(BadRequestException);
  });

  it('acceptance-тест: FamilyLawAsset без ownerId — isMaritalProperty=true за замовчуванням', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    const asset = await service.createAsset('u1', config.id, 'Квартира');

    expect(asset.isMaritalProperty).toBe(true);
  });

  it('FamilyLawAsset з ownerId — прив\'язка до конкретної сторони', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const party = prisma._seedParty({ configId: config.id, role: 'SELF' });
    const service = makeService(prisma);

    const asset = await service.createAsset('u1', config.id, 'Автомобіль', undefined, party.id, false);

    expect(asset.ownerId).toBe(party.id);
    expect(asset.isMaritalProperty).toBe(false);
  });

  it('acceptance-тест: FamilyLawStatusDetermination isOfficial=false за замовчуванням', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    const record = await service.createStatusDetermination('u1', config.id, 'MEDIATION_AGREEMENT', 'Попередня домовленість', new Date().toISOString());

    expect(record.isOfficial).toBe(false);
  });

  it('acceptance-тест: byCurrency групує окремо, НЕ сумує наївно', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    await service.createBudgetLineItem('u1', config.id, 'ASSET_TRANSFER', 'EXPENSE', 500, 'UAH');
    await service.createBudgetLineItem('u1', config.id, 'LEGAL_FEES', 'EXPENSE', 50, 'USD');

    const budget = await service.getBudget('u1', config.id);

    expect(budget.byCurrency.length).toBe(2);
  });

  it('acceptance-тест (НАЙВАЖЛИВІШИЙ, нова знахідка): goal-history зберігає ВСІ версії, жодна не втрачається', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'Початкова мета' });
    prisma._seedGoalRevision({ configId: config.id, goalDescription: 'Початкова мета' });
    const service = makeService(prisma);

    await service.updateGoal('u1', config.id, 'Оновлена мета 1');
    await service.updateGoal('u1', config.id, 'Оновлена мета 2');

    const history = await service.getGoalHistory('u1', config.id);

    expect(history.length).toBe(3);
    expect(history.map((h: any) => h.goalDescription)).toEqual(['Початкова мета', 'Оновлена мета 1', 'Оновлена мета 2']);
  });

  it('updateGoal відхиляє порожній goalDescription', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    await expect(service.updateGoal('u1', config.id, '   ')).rejects.toThrow(BadRequestException);
  });

  it('getSettlementProtocolDraft містить попередження про чутливість активів', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    const draft = await service.getSettlementProtocolDraft('u1', config.id);

    expect(draft.text).toContain('фінансові дані обох сторін');
  });

  it('acceptance-тест: crossConsultationCheck делегує в СПІЛЬНИЙ CriteriaComparisonService (той самий, що DTP)', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Розділ майна' });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Юрист X' });
    prisma._seedConsultation({
      advisorId: advisor.id,
      criteriaBreakdown: [{ criterionId: criterion.id, whatWasSaid: 'Сказано щось' }],
    });

    let capturedStatements: any[] = [];
    const comparison = {
      compare: async (_u: string, _p: string, _t: string, statements: any[]) => {
        capturedStatements = statements;
        return { status: 'INSUFFICIENT_DATA', statements };
      },
    };
    const service = makeService(prisma, comparison);

    await service.crossConsultationCheck('u1', criterion.id);

    expect(capturedStatements.length).toBe(1);
  });

  it('регресійний тест (аудит одразу після реалізації, той самий фікс, що DTP): "не піднімалось у розмові" відфільтровується з cross-consultation-check', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Розділ майна' });
    const advisorA = prisma._seedAdvisor({ configId: config.id, label: 'Юрист A' });
    const advisorB = prisma._seedAdvisor({ configId: config.id, label: 'Юрист B' });
    prisma._seedConsultation({
      advisorId: advisorA.id,
      criteriaBreakdown: [{ criterionId: criterion.id, whatWasSaid: 'Реальна відповідь юриста A' }],
    });
    prisma._seedConsultation({
      advisorId: advisorB.id,
      criteriaBreakdown: [{ criterionId: criterion.id, whatWasSaid: 'не піднімалось у розмові' }],
    });

    let capturedStatements: any[] = [];
    const comparison = {
      compare: async (_u: string, _p: string, _t: string, statements: any[]) => {
        capturedStatements = statements;
        return { status: 'INSUFFICIENT_DATA', statements };
      },
    };
    const service = makeService(prisma, comparison);

    await service.crossConsultationCheck('u1', criterion.id);

    expect(capturedStatements.length).toBe(1);
  });

  it('регресійний тест (аудит одразу після реалізації): невалідні source/category/direction відхиляються', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    await expect(
      service.createStatusDetermination('u1', config.id, 'GARBAGE', 'Текст', new Date().toISOString()),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.createBudgetLineItem('u1', config.id, 'GARBAGE', 'EXPENSE', 100),
    ).rejects.toThrow(BadRequestException);
  });

  it('регресійний тест (аудит одразу після реалізації): estimatedValue не може бути від\'ємним', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    await expect(
      service.createAsset('u1', config.id, 'Квартира', undefined, undefined, true, -1000),
    ).rejects.toThrow(BadRequestException);
  });

  it('чужий користувач не має доступу до сторін конфігу', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);
    await service.createParty('owner', config.id, 'SELF' as any);

    await expect(service.listParties('stranger', config.id)).rejects.toThrow(NotFoundException);
  });
});

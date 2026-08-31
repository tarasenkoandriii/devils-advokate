import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HealthV2Service } from '../health/health-v2.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const configs = new Map<string, any>();
  const providers = new Map<string, any>();
  const consultations = new Map<string, any>();
  const budgetLineItems: any[] = [];
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
    _seedProvider(p: any) {
      const provider = { id: nextId(), ...p };
      providers.set(provider.id, provider);
      return provider;
    },
    _seedConsultation(c: any) {
      const consultation = { id: nextId(), estimatedCost: null, ...c };
      consultations.set(consultation.id, consultation);
      return consultation;
    },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        return p && p.ownerId === where.ownerId ? p : null;
      },
    },
    healthConfig: {
      findUnique: async ({ where }: any) => configs.get(where.id) ?? null,
    },
    healthConsultation: {
      findUnique: async ({ where, include }: any) => {
        const c = consultations.get(where.id);
        if (!c) return null;
        if (include?.provider) return { ...c, provider: providers.get(c.providerId) };
        return c;
      },
      findMany: async ({ where, select }: any) => {
        let rows = [...consultations.values()];
        if (where?.provider?.configId) rows = rows.filter((c) => providers.get(c.providerId)?.configId === where.provider.configId);
        if (where?.estimatedCost?.not === null) rows = rows.filter((c) => c.estimatedCost !== null);
        if (select) rows = rows.map((c) => ({ id: c.id }));
        return rows;
      },
    },
    healthBudgetLineItem: {
      create: async ({ data }: any) => {
        const rec = { id: nextId(), ...data };
        budgetLineItems.push(rec);
        return rec;
      },
      findMany: async ({ where }: any) => budgetLineItems.filter((b) => b.configId === where.configId),
    },
  };
}

function makeService(prisma: any) {
  return new HealthV2Service(prisma as any);
}

describe('HealthV2Service', () => {
  it('acceptance-тест: byCurrency групує окремо, НЕ сумує наївно (реальний кейс для України)', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, targetBudget: 1000, currency: 'USD' });
    const service = makeService(prisma);

    await service.createBudgetLineItem('u1', config.id, 'PROCEDURE_COST', 'EXPENSE', 500, 'UAH');
    await service.createBudgetLineItem('u1', config.id, 'MEDICATION', 'EXPENSE', 50, 'USD');

    const budget = await service.getBudget('u1', config.id);

    expect(budget.byCurrency.length).toBe(2);
    const uah = budget.byCurrency.find((b: any) => b.currency === 'UAH');
    const usd = budget.byCurrency.find((b: any) => b.currency === 'USD');
    expect(uah!.totalExpense).toBe(500);
    expect(usd!.totalExpense).toBe(50);
  });

  it('acceptance-тест: EXPENSE і COVERAGE рахуються окремо, netBudget = різниця', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    await service.createBudgetLineItem('u1', config.id, 'PROCEDURE_COST', 'EXPENSE', 500, 'USD');
    await service.createBudgetLineItem('u1', config.id, 'INSURANCE_COVERAGE', 'COVERAGE', 200, 'USD');

    const budget = await service.getBudget('u1', config.id);
    const usd = budget.byCurrency.find((b: any) => b.currency === 'USD');

    expect(usd!.totalExpense).toBe(500);
    expect(usd!.totalCoverage).toBe(200);
    expect(usd!.netBudget).toBe(300);
  });

  it('acceptance-тест: hasLegacyEstimatedCosts=true, коли є HealthConsultation.estimatedCost', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const provider = prisma._seedProvider({ configId: config.id, label: 'Лікар X' });
    prisma._seedConsultation({ providerId: provider.id, estimatedCost: 300 });
    const service = makeService(prisma);

    const budget = await service.getBudget('u1', config.id);

    expect(budget.hasLegacyEstimatedCosts).toBe(true);
  });

  it('hasLegacyEstimatedCosts=false, коли немає застарілих записів', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    const budget = await service.getBudget('u1', config.id);

    expect(budget.hasLegacyEstimatedCosts).toBe(false);
  });

  it('регресійний тест (той самий клас, що знайдений у DTP v2/family-law v2): невалідні category/direction відхиляються', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    await expect(
      service.createBudgetLineItem('u1', config.id, 'GARBAGE', 'EXPENSE', 100),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.createBudgetLineItem('u1', config.id, 'PROCEDURE_COST', 'GARBAGE', 100),
    ).rejects.toThrow(BadRequestException);
  });

  it('createBudgetLineItem відхиляє від\'ємну суму', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    await expect(
      service.createBudgetLineItem('u1', config.id, 'PROCEDURE_COST', 'EXPENSE', -100),
    ).rejects.toThrow(BadRequestException);
  });

  it('createBudgetLineItem з consultationId, що не належить конфігу — NotFoundException', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const otherProject = prisma._seedProject({ ownerId: 'u1' });
    const otherConfig = prisma._seedConfig({ projectId: otherProject.id });
    const otherProvider = prisma._seedProvider({ configId: otherConfig.id, label: 'Чужий лікар' });
    const foreignConsultation = prisma._seedConsultation({ providerId: otherProvider.id });
    const service = makeService(prisma);

    await expect(
      service.createBudgetLineItem('u1', config.id, 'PROCEDURE_COST', 'EXPENSE', 100, 'USD', undefined, foreignConsultation.id),
    ).rejects.toThrow(NotFoundException);
  });

  it('чужий користувач не має доступу до бюджету', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    await expect(service.getBudget('stranger', config.id)).rejects.toThrow(NotFoundException);
  });
});

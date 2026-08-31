import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DtpV2Service } from '../dtp/dtp-v2.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const configs = new Map<string, any>();
  const criteria: any[] = [];
  const advisors = new Map<string, any>();
  const consultations = new Map<string, any>();
  const participants = new Map<string, any>();
  const insurance = new Map<string, any>();
  const faultDeterminations: any[] = [];
  const budgetLineItems: any[] = [];
  const evidenceItems = new Map<string, any>();
  const accessLogs: any[] = [];
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
    _seedParticipant(p: any) {
      const participant = { id: nextId(), displayName: null, hasFledScene: false, ...p };
      participants.set(participant.id, participant);
      return participant;
    },
    _seedEvidence(e: any) {
      const item = { id: nextId(), ...e };
      evidenceItems.set(item.id, item);
      return item;
    },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        return p && p.ownerId === where.ownerId ? p : null;
      },
    },
    dtpConfig: {
      findUnique: async ({ where }: any) => configs.get(where.id) ?? null,
    },
    dtpCriterion: {
      findMany: async ({ where }: any) => criteria.filter((c) => c.configId === where.configId),
      findUnique: async ({ where, include }: any) => {
        const c = criteria.find((cc) => cc.id === where.id);
        if (!c) return null;
        if (include?.config) return { ...c, config: configs.get(c.configId) };
        return c;
      },
    },
    dtpParticipant: {
      create: async ({ data }: any) => {
        const p = { id: nextId(), displayName: null, hasFledScene: false, ...data };
        participants.set(p.id, p);
        return p;
      },
      findFirst: async ({ where }: any) =>
        [...participants.values()].find((p) => p.configId === where.configId && p.role === where.role) ?? null,
      findUnique: async ({ where, include }: any) => {
        const p = participants.get(where.id);
        if (!p) return null;
        if (include?.config) return { ...p, config: configs.get(p.configId) };
        return p;
      },
      findMany: async ({ where }: any) => [...participants.values()].filter((p) => p.configId === where.configId),
    },
    dtpParticipantInsurance: {
      upsert: async ({ where, create, update }: any) => {
        const existing = insurance.get(where.participantId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const rec = { id: nextId(), ...create };
        insurance.set(where.participantId, rec);
        return rec;
      },
      findUnique: async ({ where }: any) => insurance.get(where.participantId) ?? null,
    },
    dtpFaultDetermination: {
      create: async ({ data }: any) => {
        const rec = { id: nextId(), ...data };
        faultDeterminations.push(rec);
        return rec;
      },
      findMany: async ({ where, orderBy, take }: any) => {
        let rows = faultDeterminations.filter((f) => f.configId === where.configId);
        if (orderBy?.determinedAt === 'asc') rows = rows.sort((a, b) => a.determinedAt - b.determinedAt);
        if (orderBy?.determinedAt === 'desc') rows = rows.sort((a, b) => b.determinedAt - a.determinedAt);
        if (take) rows = rows.slice(0, take);
        return rows;
      },
    },
    dtpBudgetLineItem: {
      create: async ({ data }: any) => {
        const rec = { id: nextId(), ...data };
        budgetLineItems.push(rec);
        return rec;
      },
      findMany: async ({ where }: any) => budgetLineItems.filter((b) => b.configId === where.configId),
    },
    dtpConsultation: {
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
    dtpEvidenceItem: {
      findUnique: async ({ where, include }: any) => {
        const e = evidenceItems.get(where.id);
        if (!e) return null;
        if (include?.config) return { ...e, config: configs.get(e.configId) };
        return e;
      },
    },
    dtpEvidenceAccessLog: {
      create: async ({ data }: any) => {
        const rec = { id: nextId(), occurredAt: new Date(), ...data };
        accessLogs.push(rec);
        return rec;
      },
      findMany: async ({ where, orderBy }: any) => {
        let rows = accessLogs.filter((a) => a.evidenceId === where.evidenceId);
        if (orderBy?.occurredAt) rows = rows.sort((a, b) => a.occurredAt - b.occurredAt);
        return rows;
      },
    },
  };
}

function makeService(prisma: any, comparison: any = { compare: async () => ({ status: 'NO_DISCREPANCY_FOUND', statements: [] }) }) {
  return new DtpV2Service(prisma as any, comparison as any);
}

describe('DtpV2Service', () => {
  it('acceptance-тест: не більше одного SELF на конфіг — сервісна перевірка', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    await service.createParticipant('u1', config.id, 'SELF' as any);
    await expect(service.createParticipant('u1', config.id, 'SELF' as any)).rejects.toThrow(BadRequestException);
  });

  it('декілька OTHER_PARTY дозволені без обмежень', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    await service.createParticipant('u1', config.id, 'OTHER_PARTY' as any);
    await service.createParticipant('u1', config.id, 'OTHER_PARTY' as any);
    const list = await service.listParticipants('u1', config.id);

    expect(list.length).toBe(2);
  });

  it('acceptance-тест: upsertParticipantInsurance — другий виклик ОНОВЛЮЄ, не дублює', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const participant = prisma._seedParticipant({ configId: config.id, role: 'OTHER_PARTY' });
    const service = makeService(prisma);

    await service.upsertParticipantInsurance('u1', participant.id, true);
    const updated = await service.upsertParticipantInsurance('u1', participant.id, true, 'Приватне страхування');

    expect(updated.insurerName).toBe('Приватне страхування');
  });

  it('getParticipantInsurance — NotFoundException, коли запису ще немає', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const participant = prisma._seedParticipant({ configId: config.id, role: 'OTHER_PARTY' });
    const service = makeService(prisma);

    await expect(service.getParticipantInsurance('u1', participant.id)).rejects.toThrow(NotFoundException);
  });

  it('acceptance-тест: DtpFaultDetermination isOfficial=false за замовчуванням', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    const record = await service.createFaultDetermination('u1', config.id, 'INSURANCE_COMPANY', 'Попередньо 50/50', new Date().toISOString());

    expect(record.isOfficial).toBe(false);
  });

  it('acceptance-тест: byCurrency групує окремо, НЕ сумує наївно', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, targetBudget: 1000, currency: 'USD' });
    const service = makeService(prisma);

    await service.createBudgetLineItem('u1', config.id, 'REPAIR', 'EXPENSE', 500, 'UAH');
    await service.createBudgetLineItem('u1', config.id, 'LEGAL_FEES', 'EXPENSE', 50, 'USD');

    const budget = await service.getBudget('u1', config.id);

    expect(budget.byCurrency.length).toBe(2);
    const uah = budget.byCurrency.find((b: any) => b.currency === 'UAH');
    const usd = budget.byCurrency.find((b: any) => b.currency === 'USD');
    expect(uah!.totalExpense).toBe(500);
    expect(usd!.totalExpense).toBe(50);
  });

  it('acceptance-тест: hasLegacyEstimatedCosts=true, коли є DtpConsultation.estimatedCost', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Агент X' });
    prisma._seedConsultation({ advisorId: advisor.id, estimatedCost: 300 });
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

  it('getSettlementProtocolDraft містить незнімний преамбул', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    const draft = await service.getSettlementProtocolDraft('u1', config.id);

    expect(draft.text).toContain('НЕ юридично завершений документ');
  });

  it('acceptance-тест: crossConsultationCheck делегує в спільний CriteriaComparisonService, не має власного AI-виклику', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Хто винен' });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Агент X' });
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
    expect(capturedStatements[0].whatWasSaid).toBe('Сказано щось');
  });

  it('getEvidenceAccessLog — порожній масив, коли ще не переглядався', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const evidence = prisma._seedEvidence({ configId: config.id, mediaType: 'PHOTO', hasAudio: false });
    const service = makeService(prisma);

    const log = await service.getEvidenceAccessLog('u1', evidence.id);

    expect(log.length).toBe(0);
  });

  it('logEvidenceAccess додає append-only записи', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const evidence = prisma._seedEvidence({ configId: config.id, mediaType: 'PHOTO', hasAudio: false });
    const service = makeService(prisma);

    await service.logEvidenceAccess('u1', evidence.id, 'VIEWED_METADATA' as any);
    await service.logEvidenceAccess('u1', evidence.id, 'VIEWED_METADATA' as any);
    const log = await service.getEvidenceAccessLog('u1', evidence.id);

    expect(log.length).toBe(2);
  });

  it('регресійний тест (аудит одразу після реалізації, НАЙВАЖЛИВІШИЙ): "не піднімалось у розмові" відфільтровується з cross-consultation-check, не стає хибним джерелом для порівняння', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Хто винен' });
    const advisorA = prisma._seedAdvisor({ configId: config.id, label: 'Агент A' });
    const advisorB = prisma._seedAdvisor({ configId: config.id, label: 'Агент B' });
    prisma._seedConsultation({
      advisorId: advisorA.id,
      criteriaBreakdown: [{ criterionId: criterion.id, whatWasSaid: 'Реальна відповідь агента A' }],
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
    expect(capturedStatements[0].whatWasSaid).toBe('Реальна відповідь агента A');
  });

  it('регресійний тест (аудит одразу після реалізації): невалідний source відхиляється, не потрапляє мовчки в БД', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    await expect(
      service.createFaultDetermination('u1', config.id, 'GARBAGE', 'Текст', new Date().toISOString()),
    ).rejects.toThrow(BadRequestException);
  });

  it('регресійний тест (аудит одразу після реалізації): невалідні category/direction відхиляються', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    await expect(
      service.createBudgetLineItem('u1', config.id, 'GARBAGE', 'EXPENSE', 100),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.createBudgetLineItem('u1', config.id, 'REPAIR', 'GARBAGE', 100),
    ).rejects.toThrow(BadRequestException);
  });

  it('регресійний тест (аудит одразу після реалізації): coverageAmount не може бути від\'ємним', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const participant = prisma._seedParticipant({ configId: config.id, role: 'OTHER_PARTY' });
    const service = makeService(prisma);

    await expect(
      service.upsertParticipantInsurance('u1', participant.id, true, undefined, undefined, -500),
    ).rejects.toThrow(BadRequestException);
  });

  it('createBudgetLineItem відхиляє від\'ємну суму', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id });
    const service = makeService(prisma);

    await expect(service.createBudgetLineItem('u1', config.id, 'REPAIR', 'EXPENSE', -100)).rejects.toThrow(BadRequestException);
  });
});

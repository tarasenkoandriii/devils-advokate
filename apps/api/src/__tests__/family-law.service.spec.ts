import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FamilyLawService } from '../family-law/family-law.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const configs = new Map<string, any>();
  const criteria: any[] = [];
  const advisors = new Map<string, any>();
  const consultations = new Map<string, any>();
  const conversations = new Map<string, any>();
  const segments: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
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
    _seedCriterion(c: any) {
      const criterion = { id: nextId(), ...c };
      criteria.push(criterion);
      return criterion;
    },
    _seedAdvisor(a: any) {
      const advisor = { id: nextId(), advisorName: null, role: null, ...a };
      advisors.set(advisor.id, advisor);
      return advisor;
    },
    _seedConsultation(c: any) {
      const consultation = { id: nextId(), criteriaBreakdown: null, draftedAt: null, reviewedAt: null, reviewNotes: null, estimatedCost: null, isMediationSession: false, ...c };
      consultations.set(consultation.id, consultation);
      return consultation;
    },
    _seedConversation(c: any) {
      const conv = { id: nextId(), ...c };
      conversations.set(conv.id, conv);
      return conv;
    },
    _seedSegment(s: any) {
      segments.push({ id: nextId(), ...s });
    },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        return p && p.ownerId === where.ownerId ? p : null;
      },
    },
    familyLawConfig: {
      findUnique: async ({ where, include }: any) => {
        const config = where.id ? configs.get(where.id) : [...configs.values()].find((c) => c.projectId === where.projectId);
        if (!config) return null;
        if (include?.criteria) return { ...config, criteria: criteria.filter((c) => c.configId === config.id) };
        return config;
      },
      create: async ({ data, include }: any) => {
        const { criteria: criteriaInput, ...rest } = data;
        const config = { id: nextId(), ...rest };
        configs.set(config.id, config);
        const created = (criteriaInput?.create ?? []).map((c: any) => ({ id: nextId(), configId: config.id, ...c }));
        created.forEach((c: any) => criteria.push(c));
        return include?.criteria ? { ...config, criteria: created } : config;
      },
    },
    familyLawCriterion: {
      findMany: async ({ where }: any) => criteria.filter((c) => c.configId === where.configId).sort((a, b) => a.orderIndex - b.orderIndex),
    },
    familyLawAdvisor: {
      create: async ({ data }: any) => {
        const advisor = { id: nextId(), advisorName: null, role: null, ...data };
        advisors.set(advisor.id, advisor);
        return advisor;
      },
      findUnique: async ({ where, include }: any) => {
        const advisor = advisors.get(where.id);
        if (!advisor) return null;
        if (include?.config) return { ...advisor, config: configs.get(advisor.configId) };
        return advisor;
      },
      findMany: async ({ where, include }: any) => {
        let rows = [...advisors.values()].filter((a) => a.configId === where.configId);
        if (include?.consultations) {
          rows = rows.map((a) => ({
            ...a,
            consultations: [...consultations.values()].filter((c) => c.advisorId === a.id).sort((a2, b2) => b2.occurredAt - a2.occurredAt),
          }));
        }
        return rows;
      },
    },
    familyLawConsultation: {
      create: async ({ data }: any) => {
        const consultation = { id: nextId(), criteriaBreakdown: null, draftedAt: null, reviewedAt: null, reviewNotes: null, estimatedCost: null, isMediationSession: false, ...data };
        consultations.set(consultation.id, consultation);
        return consultation;
      },
      findUnique: async ({ where, include }: any) => {
        const c = consultations.get(where.id);
        if (!c) return null;
        if (include?.advisor) {
          const advisor = advisors.get(c.advisorId);
          return { ...c, advisor: { ...advisor, config: configs.get(advisor.configId) } };
        }
        return c;
      },
      findMany: async ({ where, orderBy }: any) => {
        let rows = [...consultations.values()].filter((c) => c.advisorId === where.advisorId);
        if (orderBy?.occurredAt) rows = rows.sort((a, b) => b.occurredAt - a.occurredAt);
        return rows;
      },
      update: async ({ where, data }: any) => {
        const c = consultations.get(where.id);
        Object.assign(c, data);
        return c;
      },
    },
    conversation: {
      findUnique: async ({ where }: any) => conversations.get(where.id) ?? null,
    },
    transcriptSegment: {
      findMany: async ({ where, orderBy }: any) => {
        let rows = segments.filter((s) => s.conversationId === where.transcript.conversationId);
        if (orderBy?.startMs) rows = rows.sort((a, b) => a.startMs - b.startMs);
        return rows;
      },
    },
  };
}

function makeService(prisma: any, aiRouter: any = { execute: async () => ({ text: '{"criteriaBreakdown":[]}' }) }) {
  return new FamilyLawService(prisma as any, aiRouter as any);
}

describe('FamilyLawService', () => {
  it('регресійний тест (повний аудит проєкту): createConfig відхиляє невалідну category критерію', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'PRENUP' });
    const service = makeService(prisma);

    await expect(
      service.createConfig('u1', project.id, {
        goalDescription: 'x',
        targetBudget: null,
        currency: null,
        criteria: [{ text: 'Критерій', category: 'GARBAGE' as any, isRequired: true, orderIndex: 0 }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('createConfig фіксує чернетку разом з критеріями, відхиляє повторне створення', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'PRENUP' });
    const service = makeService(prisma);

    const config = await service.createConfig('u1', project.id, {
      goalDescription: 'Шлюбний договір',
      targetBudget: 2000,
      currency: 'USD',
      criteria: [{ text: 'Розділ майна', category: 'ASSET_DIVISION' as any, isRequired: true, orderIndex: 0 }],
    });

    expect(config.criteria.length).toBe(1);

    await expect(
      service.createConfig('u1', project.id, { goalDescription: 'дубль', targetBudget: null, currency: null, criteria: [] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('чужий користувач не має доступу до конфігу', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner', contractType: 'PRENUP' });
    const service = makeService(prisma);
    await service.createConfig('owner', project.id, { goalDescription: 'x', targetBudget: null, currency: null, criteria: [] });

    await expect(service.getConfig('stranger', project.id)).rejects.toThrow(NotFoundException);
  });

  it('acceptance-тест §7 ТЗ (НАЙВАЖЛИВІШИЙ): system prompt generate-breakdown містить явну заборону на UPL-формулювання', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'DIVORCE_SETTLEMENT' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Розділ майна', category: 'ASSET_DIVISION', isRequired: true, orderIndex: 0 });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Юрист X' });
    const conv = prisma._seedConversation({});
    prisma._seedSegment({ conversationId: conv.id, text: 'Юрист каже: майно ділиться порівну', startMs: 0 });
    const consultation = prisma._seedConsultation({ advisorId: advisor.id, conversationId: conv.id, occurredAt: new Date() });

    let capturedSystemPrompt = '';
    const aiRouter = {
      execute: async (req: any) => {
        capturedSystemPrompt = req.systemPrompt;
        return { text: JSON.stringify({ criteriaBreakdown: [{ criterionId: criterion.id, whatWasSaid: 'Юрист сказав про рівний розділ' }] }) };
      },
    };
    const service = makeService(prisma, aiRouter);

    await service.generateBreakdown('u1', consultation.id);

    expect(capturedSystemPrompt.toLowerCase()).toContain('має право');
    expect(capturedSystemPrompt.toLowerCase()).toContain('вирішить суд');
    expect(capturedSystemPrompt.toLowerCase()).toContain('справедливою');
  });

  it('acceptance-тест §7 ТЗ: criteriaBreakdown має ТІЛЬКИ criterionId/whatWasSaid/sourceSegmentId', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'PRENUP' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Аліменти', category: 'FINANCIAL_SUPPORT', isRequired: true, orderIndex: 0 });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Юрист Y' });
    const conv = prisma._seedConversation({});
    prisma._seedSegment({ conversationId: conv.id, text: 'Про аліменти', startMs: 0 });
    const consultation = prisma._seedConsultation({ advisorId: advisor.id, conversationId: conv.id, occurredAt: new Date() });

    const aiRouter = {
      execute: async () => ({
        text: JSON.stringify({ criteriaBreakdown: [{ criterionId: criterion.id, whatWasSaid: 'Названо суму', sourceSegmentId: 'seg-1' }] }),
      }),
    };
    const service = makeService(prisma, aiRouter);

    const updated = await service.generateBreakdown('u1', consultation.id);
    const breakdown = (updated.criteriaBreakdown as any)[0];

    expect(Object.keys(breakdown).sort()).toEqual(['criterionId', 'sourceSegmentId', 'whatWasSaid']);
  });

  it('регресійний тест: повторна generate-breakdown очищує старий reviewedAt/reviewNotes (застосовано одразу, той самий урок, що health)', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'PRENUP' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Майно', category: 'ASSET_DIVISION', isRequired: true, orderIndex: 0 });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Юрист Q' });
    const conv = prisma._seedConversation({});
    prisma._seedSegment({ conversationId: conv.id, text: 'Розмова', startMs: 0 });
    const consultation = prisma._seedConsultation({
      advisorId: advisor.id,
      conversationId: conv.id,
      occurredAt: new Date(),
      draftedAt: new Date(),
      reviewedAt: new Date(),
      reviewNotes: 'Стара примітка',
    });

    const aiRouter = { execute: async () => ({ text: JSON.stringify({ criteriaBreakdown: [{ criterionId: criterion.id, whatWasSaid: 'Нова відповідь' }] }) }) };
    const service = makeService(prisma, aiRouter);

    const updated = await service.generateBreakdown('u1', consultation.id);

    expect(updated.reviewedAt).toBeNull();
    expect(updated.reviewNotes).toBeNull();
  });

  it('acceptance-тест §7 ТЗ: reviewConsultation без generate-breakdown — 400, гейт вимагає draftedAt', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'PRENUP' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Юрист Z' });
    const consultation = prisma._seedConsultation({ advisorId: advisor.id, occurredAt: new Date() });
    const service = makeService(prisma);

    await expect(service.reviewConsultation('u1', consultation.id)).rejects.toThrow(BadRequestException);
  });

  it('acceptance-тест §7 ТЗ: mediation-notice повертає непорожній текст, коли isMediationSession=true', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'DIVORCE_SETTLEMENT' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Медіатор M' });
    const consultation = prisma._seedConsultation({ advisorId: advisor.id, occurredAt: new Date(), isMediationSession: true });
    const service = makeService(prisma);

    const notice = await service.getMediationNotice('u1', consultation.id);

    expect(notice.text.length).toBeGreaterThan(0);
  });

  it('acceptance-тест §7 ТЗ: mediation-notice — NotFoundException, коли isMediationSession=false (дефолт)', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'DIVORCE_SETTLEMENT' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Юрист N' });
    const consultation = prisma._seedConsultation({ advisorId: advisor.id, occurredAt: new Date() });
    const service = makeService(prisma);

    await expect(service.getMediationNotice('u1', consultation.id)).rejects.toThrow(NotFoundException);
  });

  it('acceptance-тест §7 ТЗ (структурний): getComparisonTable НЕ повертає жодного поля score/rank/sortedBy', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'PRENUP' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    prisma._seedAdvisor({ configId: config.id, label: 'Юрист A' });
    prisma._seedAdvisor({ configId: config.id, label: 'Юрист B' });
    const service = makeService(prisma);

    const table = await service.getComparisonTable('u1', config.id);
    const serialized = JSON.stringify(table);

    expect(serialized.toLowerCase()).not.toContain('"score"');
    expect(serialized.toLowerCase()).not.toContain('"rank"');
    expect(serialized.toLowerCase()).not.toContain('sortedby');
    expect(table.advisors.length).toBe(2);
  });

  it('generateBreakdown без пов’язаної Conversation — BadRequestException', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'PRENUP' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Юрист V' });
    const consultation = prisma._seedConsultation({ advisorId: advisor.id, conversationId: null, occurredAt: new Date() });
    const service = makeService(prisma);

    await expect(service.generateBreakdown('u1', consultation.id)).rejects.toThrow(BadRequestException);
  });

  it('createConsultation відхиляє від\'ємний estimatedCost', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'PRENUP' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Юрист U' });
    const service = makeService(prisma);

    await expect(
      service.createConsultation('u1', advisor.id, undefined, new Date().toISOString(), -100),
    ).rejects.toThrow(BadRequestException);
  });
});

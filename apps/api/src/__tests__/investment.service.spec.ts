import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InvestmentService } from '../investment/investment.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const configs = new Map<string, any>();
  const criteria: any[] = [];
  const opportunities = new Map<string, any>();
  const meetings = new Map<string, any>();
  const comparisons: any[] = [];
  const conversations = new Map<string, any>();
  const segments: any[] = [];
  const groupMembers: any[] = [];
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
    _seedOpportunity(o: any) {
      const opp = { id: nextId(), advisorName: null, advisorCompany: null, ...o };
      opportunities.set(opp.id, opp);
      return opp;
    },
    _seedMeeting(m: any) {
      const meeting = { id: nextId(), criteriaBreakdown: null, draftedAt: null, reviewedAt: null, reviewNotes: null, ...m };
      meetings.set(meeting.id, meeting);
      return meeting;
    },
    _seedConversation(c: any) {
      const conv = { id: nextId(), ...c };
      conversations.set(conv.id, conv);
      return conv;
    },
    _seedSegment(s: any) {
      segments.push({ id: nextId(), ...s });
    },
    _seedGroupMembership(m: any) {
      groupMembers.push(m);
    },
    _getComparisons() {
      return comparisons;
    },

    project: {
      findUnique: async ({ where }: any) => projects.get(where.id) ?? null,
    },
    investmentGroupMember: {
      findUnique: async ({ where }: any) =>
        groupMembers.find((m) => m.groupId === where.groupId_userId.groupId && m.userId === where.groupId_userId.userId) ?? null,
    },
    investmentConfig: {
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
    investmentQuizCriterion: {
      findMany: async ({ where }: any) => criteria.filter((c) => c.configId === where.configId).sort((a, b) => a.orderIndex - b.orderIndex),
    },
    investmentOpportunity: {
      create: async ({ data }: any) => {
        const opp = { id: nextId(), advisorName: null, advisorCompany: null, ...data };
        opportunities.set(opp.id, opp);
        return opp;
      },
      findUnique: async ({ where, include }: any) => {
        const opp = opportunities.get(where.id);
        if (!opp) return null;
        if (include?.config) return { ...opp, config: configs.get(opp.configId) };
        return opp;
      },
      findMany: async ({ where, include }: any) => {
        let rows = [...opportunities.values()].filter((o) => o.configId === where.configId);
        if (include?.meetings || include?.comparisons) {
          rows = rows.map((o) => ({
            ...o,
            meetings: [...meetings.values()].filter((m) => m.opportunityId === o.id).sort((a, b) => b.occurredAt - a.occurredAt),
            comparisons: comparisons.filter((c) => c.opportunityId === o.id),
          }));
        }
        return rows;
      },
    },
    investmentMeeting: {
      create: async ({ data }: any) => {
        const meeting = { id: nextId(), criteriaBreakdown: null, draftedAt: null, reviewedAt: null, reviewNotes: null, ...data };
        meetings.set(meeting.id, meeting);
        return meeting;
      },
      findUnique: async ({ where, include }: any) => {
        const m = meetings.get(where.id);
        if (!m) return null;
        if (include?.opportunity) {
          const opp = opportunities.get(m.opportunityId);
          return { ...m, opportunity: { ...opp, config: configs.get(opp.configId) } };
        }
        return m;
      },
      update: async ({ where, data }: any) => {
        const m = meetings.get(where.id);
        Object.assign(m, data);
        return m;
      },
    },
    investmentSourceComparison: {
      create: async ({ data }: any) => {
        const c = { id: nextId(), ...data };
        comparisons.push(c);
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
  return new InvestmentService(prisma as any, aiRouter as any);
}

describe('InvestmentService', () => {
  it('регресійний тест (повний аудит проєкту): createConfig відхиляє невалідну category критерію, не пише мовчки в БД', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
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
    const project = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma);

    const config = await service.createConfig('u1', project.id, {
      goalDescription: 'Диверсифікація',
      targetBudget: 50000,
      currency: 'USD',
      criteria: [{ text: 'Гарантія дохідності', category: 'RETURN_GUARANTEE' as any, isRequired: true, orderIndex: 0 }],
    });

    expect(config.criteria.length).toBe(1);

    await expect(
      service.createConfig('u1', project.id, { goalDescription: 'дубль', targetBudget: null, currency: null, criteria: [] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('чужий/не-груповий користувач не має доступу до конфігу', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner' });
    const service = makeService(prisma);
    await service.createConfig('owner', project.id, { goalDescription: 'x', targetBudget: null, currency: null, criteria: [] });

    await expect(service.getConfig('stranger', project.id)).rejects.toThrow(NotFoundException);
  });

  it('acceptance-тест §7 ТЗ (НАЙВАЖЛИВІШИЙ): system prompt generate-breakdown містить явну заборону на рекомендаційні формулювання — перехоплення реального тексту запиту', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Гарантія дохідності', category: 'RETURN_GUARANTEE', isRequired: true, orderIndex: 0 });
    const opportunity = prisma._seedOpportunity({ configId: config.id, label: 'Фонд X' });
    const conv = prisma._seedConversation({});
    prisma._seedSegment({ conversationId: conv.id, text: 'Радник каже: дохідність гарантована 15%', startMs: 0 });
    const meeting = prisma._seedMeeting({ opportunityId: opportunity.id, conversationId: conv.id, occurredAt: new Date() });

    let capturedSystemPrompt = '';
    const aiRouter = {
      execute: async (req: any) => {
        capturedSystemPrompt = req.systemPrompt;
        return { text: JSON.stringify({ criteriaBreakdown: [{ criterionId: criterion.id, whatWasSaid: 'Радник сказав про гарантію 15%' }] }) };
      },
    };
    const service = makeService(prisma, aiRouter);

    await service.generateBreakdown('u1', meeting.id);

    expect(capturedSystemPrompt.toLowerCase()).toContain('рекоменд');
    expect(capturedSystemPrompt.toLowerCase()).toContain('варто');
    expect(capturedSystemPrompt.toLowerCase()).toContain('кращ');
  });

  it('acceptance-тест §7 ТЗ: criteriaBreakdown має ТІЛЬКИ criterionId/whatWasSaid/sourceSegmentId — жодного covered/score поля', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Комісії', category: 'FEES_AND_LOSSES', isRequired: true, orderIndex: 0 });
    const opportunity = prisma._seedOpportunity({ configId: config.id, label: 'Фонд Y' });
    const conv = prisma._seedConversation({});
    prisma._seedSegment({ conversationId: conv.id, text: 'Комісія за вхід 2%', startMs: 0 });
    const meeting = prisma._seedMeeting({ opportunityId: opportunity.id, conversationId: conv.id, occurredAt: new Date() });

    const aiRouter = {
      execute: async () => ({
        text: JSON.stringify({ criteriaBreakdown: [{ criterionId: criterion.id, whatWasSaid: 'Названо комісію 2% за вхід', sourceSegmentId: 'seg-1' }] }),
      }),
    };
    const service = makeService(prisma, aiRouter);

    const updated = await service.generateBreakdown('u1', meeting.id);
    const breakdown = (updated.criteriaBreakdown as any)[0];

    expect(Object.keys(breakdown).sort()).toEqual(['criterionId', 'sourceSegmentId', 'whatWasSaid']);
  });

  it('acceptance-тест §7 ТЗ: reviewMeeting без generate-breakdown — 400, гейт вимагає draftedAt', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const opportunity = prisma._seedOpportunity({ configId: config.id, label: 'Фонд Z' });
    const meeting = prisma._seedMeeting({ opportunityId: opportunity.id, occurredAt: new Date() });
    const service = makeService(prisma);

    await expect(service.reviewMeeting('u1', meeting.id)).rejects.toThrow(BadRequestException);
  });

  it('reviewMeeting після generate-breakdown проходить, зберігає reviewNotes користувача', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const opportunity = prisma._seedOpportunity({ configId: config.id, label: 'Фонд Z' });
    const meeting = prisma._seedMeeting({ opportunityId: opportunity.id, occurredAt: new Date(), draftedAt: new Date() });
    const service = makeService(prisma);

    const reviewed = await service.reviewMeeting('u1', meeting.id, 'Хочу передзвонити для уточнення');

    expect(reviewed.reviewedAt).not.toBeNull();
    expect(reviewed.reviewNotes).toBe('Хочу передзвонити для уточнення');
  });

  it('acceptance-тест §7 ТЗ: addSourceComparison завантажує ЛИШЕ вказаний URL, НЕ витягує ціну/оцінку', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const opportunity = prisma._seedOpportunity({ configId: config.id, label: 'Фонд W' });

    const fetchedUrls: string[] = [];
    (global as any).fetch = jest.fn(async (url: string) => {
      fetchedUrls.push(url);
      return { ok: true, headers: { get: () => null }, text: async () => '<html>Дохідність фонду за 5 років — 45%</html>' };
    });
    const service = makeService(prisma);

    const comparison = await service.addSourceComparison('u1', opportunity.id, 'https://example.com/fund-report');

    expect(fetchedUrls).toEqual(['https://example.com/fund-report']);
    expect(Object.keys(comparison).sort()).not.toContain('extractedPrice');
    expect(Object.keys(comparison).sort()).not.toContain('extractedScore');
    (global as any).fetch = undefined;
  });

  it('acceptance-тест §7 ТЗ (структурний): getComparisonTable НЕ повертає жодного поля score/rank/sortedBy', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    prisma._seedOpportunity({ configId: config.id, label: 'Фонд A' });
    prisma._seedOpportunity({ configId: config.id, label: 'Фонд B' });
    const service = makeService(prisma);

    const table = await service.getComparisonTable('u1', config.id);
    const serialized = JSON.stringify(table);

    expect(serialized.toLowerCase()).not.toContain('"score"');
    expect(serialized.toLowerCase()).not.toContain('"rank"');
    expect(serialized.toLowerCase()).not.toContain('sortedby');
    expect(table.opportunities.length).toBe(2);
  });

  it('generateBreakdown без пов’язаної Conversation — BadRequestException', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const opportunity = prisma._seedOpportunity({ configId: config.id, label: 'Фонд V' });
    const meeting = prisma._seedMeeting({ opportunityId: opportunity.id, conversationId: null, occurredAt: new Date() });
    const service = makeService(prisma);

    await expect(service.generateBreakdown('u1', meeting.id)).rejects.toThrow(BadRequestException);
  });

  it('член групи має доступ до конфігу групового проєкту', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner', investmentGroupId: 'group-1' });
    prisma._seedGroupMembership({ groupId: 'group-1', userId: 'colleague' });
    const service = makeService(prisma);
    await service.createConfig('owner', project.id, { goalDescription: 'x', targetBudget: null, currency: null, criteria: [] });

    await expect(service.getConfig('colleague', project.id)).resolves.toBeDefined();
  });
});

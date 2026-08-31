import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { HealthService } from '../health/health.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const configs = new Map<string, any>();
  const criteria: any[] = [];
  const providers = new Map<string, any>();
  const consultations = new Map<string, any>();
  const sourceReferences: any[] = [];
  const labDrafts: any[] = [];
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
    _seedProvider(p: any) {
      const provider = { id: nextId(), providerName: null, specialty: null, ...p };
      providers.set(provider.id, provider);
      return provider;
    },
    _seedSourceReference(s: any) {
      const reference = { id: nextId(), createdAt: new Date(), ...s };
      sourceReferences.push(reference);
      return reference;
    },
    _seedLabDraft(d: any) {
      const draft = { id: nextId(), verified: false, verifiedAt: null, createdAt: new Date(), ...d };
      labDrafts.push(draft);
      return draft;
    },
    _seedConsultation(c: any) {
      const consultation = { id: nextId(), criteriaBreakdown: null, draftedAt: null, reviewedAt: null, reviewNotes: null, estimatedCost: null, ...c };
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
    _getSourceReferences() {
      return sourceReferences;
    },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        return p && p.ownerId === where.ownerId ? p : null;
      },
    },
    healthConfig: {
      findUnique: async ({ where, include }: any) => {
        let config = where.id ? configs.get(where.id) : [...configs.values()].find((c) => c.projectId === where.projectId);
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
    healthQuizCriterion: {
      findMany: async ({ where }: any) => criteria.filter((c) => c.configId === where.configId).sort((a, b) => a.orderIndex - b.orderIndex),
    },
    healthProvider: {
      create: async ({ data }: any) => {
        const provider = { id: nextId(), providerName: null, specialty: null, ...data };
        providers.set(provider.id, provider);
        return provider;
      },
      findUnique: async ({ where, include }: any) => {
        const provider = providers.get(where.id);
        if (!provider) return null;
        if (include?.config) return { ...provider, config: configs.get(provider.configId) };
        return provider;
      },
      findMany: async ({ where, include }: any) => {
        let rows = [...providers.values()].filter((p) => p.configId === where.configId);
        if (include?.consultations || include?.sourceReferences) {
          rows = rows.map((p) => ({
            ...p,
            consultations: [...consultations.values()].filter((c) => c.providerId === p.id).sort((a, b) => b.occurredAt - a.occurredAt),
            sourceReferences: sourceReferences.filter((s) => s.providerId === p.id),
          }));
        }
        return rows;
      },
    },
    healthConsultation: {
      create: async ({ data }: any) => {
        const consultation = { id: nextId(), criteriaBreakdown: null, draftedAt: null, reviewedAt: null, reviewNotes: null, estimatedCost: null, ...data };
        consultations.set(consultation.id, consultation);
        return consultation;
      },
      findUnique: async ({ where, include }: any) => {
        const c = consultations.get(where.id);
        if (!c) return null;
        if (include?.provider) {
          const provider = providers.get(c.providerId);
          return { ...c, provider: { ...provider, config: configs.get(provider.configId) } };
        }
        return c;
      },
      findMany: async ({ where, orderBy }: any) => {
        let rows = [...consultations.values()].filter((c) => c.providerId === where.providerId);
        if (orderBy?.occurredAt) rows = rows.sort((a, b) => b.occurredAt - a.occurredAt);
        return rows;
      },
      update: async ({ where, data }: any) => {
        const c = consultations.get(where.id);
        Object.assign(c, data);
        return c;
      },
    },
    healthLabDocumentDraft: {
      create: async ({ data }: any) => {
        const draft = { id: nextId(), verified: false, verifiedAt: null, createdAt: new Date(), ...data };
        labDrafts.push(draft);
        return draft;
      },
      findUnique: async ({ where }: any) => labDrafts.find((d) => d.id === where.id) ?? null,
      findMany: async ({ where, orderBy }: any) => {
        let rows = labDrafts.filter((d) => d.configId === where.configId);
        if (orderBy?.createdAt) rows = rows.sort((a, b) => b.createdAt - a.createdAt);
        return rows;
      },
      update: async ({ where, data }: any) => {
        const d = labDrafts.find((dd) => dd.id === where.id);
        Object.assign(d, data);
        return d;
      },
      count: async ({ where }: any) => {
        const since = where.createdAt?.gte;
        return labDrafts.filter((d) => {
          const cfg = configs.get(d.configId);
          const proj = cfg ? projects.get(cfg.projectId) : null;
          const ownerMatches = proj?.ownerId === where.config?.project?.ownerId;
          const timeMatches = !since || d.createdAt >= since;
          return ownerMatches && timeMatches;
        }).length;
      },
    },
    healthSourceReference: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), createdAt: new Date(), ...data };
        sourceReferences.push(s);
        return s;
      },
      findMany: async ({ where, orderBy }: any) => {
        let rows = sourceReferences.filter((s) => s.providerId === where.providerId);
        if (orderBy?.createdAt) rows = rows.sort((a, b) => b.createdAt - a.createdAt);
        return rows;
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

function makeService(
  prisma: any,
  aiRouter: any = { execute: async () => ({ text: '{"criteriaBreakdown":[]}' }) },
  secrets: any = { resolve: async () => 'fake-api-key' },
  consent: any = { requireConsent: async () => {} },
) {
  return new HealthService(prisma as any, aiRouter as any, secrets as any, consent as any);
}

describe('HealthService', () => {
  it('регресійний тест (повний аудит проєкту): createConfig відхиляє невалідну category критерію', async () => {
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
      goalDescription: 'Чи потрібна операція',
      targetBudget: 5000,
      currency: 'USD',
      criteria: [{ text: 'Терміновість', category: 'PROCEDURE_NECESSITY' as any, isRequired: true, orderIndex: 0 }],
    });

    expect(config.criteria.length).toBe(1);

    await expect(
      service.createConfig('u1', project.id, { goalDescription: 'дубль', targetBudget: null, currency: null, criteria: [] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('чужий користувач не має доступу до конфігу', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner' });
    const service = makeService(prisma);
    await service.createConfig('owner', project.id, { goalDescription: 'x', targetBudget: null, currency: null, criteria: [] });

    await expect(service.getConfig('stranger', project.id)).rejects.toThrow(NotFoundException);
  });

  it('acceptance-тест §7 ТЗ (НАЙВАЖЛИВІШИЙ): system prompt generate-breakdown містить ОБИДВІ заборони — на медичну оцінку ТА на самостійну інтерпретацію аналізів', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Терміновість', category: 'PROCEDURE_NECESSITY', isRequired: true, orderIndex: 0 });
    const provider = prisma._seedProvider({ configId: config.id, label: 'Хірург X' });
    const conv = prisma._seedConversation({});
    prisma._seedSegment({ conversationId: conv.id, text: 'Лікар каже: операція обов\'язкова, аналізи показують запалення', startMs: 0 });
    const consultation = prisma._seedConsultation({ providerId: provider.id, conversationId: conv.id, occurredAt: new Date() });

    let capturedSystemPrompt = '';
    const aiRouter = {
      execute: async (req: any) => {
        capturedSystemPrompt = req.systemPrompt;
        return { text: JSON.stringify({ criteriaBreakdown: [{ criterionId: criterion.id, whatWasSaid: 'Лікар сказав, що операція обов\'язкова' }] }) };
      },
    };
    const service = makeService(prisma, aiRouter);

    await service.generateBreakdown('u1', consultation.id);

    expect(capturedSystemPrompt.toLowerCase()).toContain('варто робити операцію');
    expect(capturedSystemPrompt.toLowerCase()).toContain('лікар правий');
    expect(capturedSystemPrompt.toLowerCase()).toContain('не інтерпретуй результати аналізів');
  });

  it('acceptance-тест §7 ТЗ: criteriaBreakdown має ТІЛЬКИ criterionId/whatWasSaid/sourceSegmentId — жодного covered/score поля', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Ризики', category: 'RISKS_AND_ALTERNATIVES', isRequired: true, orderIndex: 0 });
    const provider = prisma._seedProvider({ configId: config.id, label: 'Хірург Y' });
    const conv = prisma._seedConversation({});
    prisma._seedSegment({ conversationId: conv.id, text: 'Ризик ускладнень 5%', startMs: 0 });
    const consultation = prisma._seedConsultation({ providerId: provider.id, conversationId: conv.id, occurredAt: new Date() });

    const aiRouter = {
      execute: async () => ({
        text: JSON.stringify({ criteriaBreakdown: [{ criterionId: criterion.id, whatWasSaid: 'Названо ризик ускладнень 5%', sourceSegmentId: 'seg-1' }] }),
      }),
    };
    const service = makeService(prisma, aiRouter);

    const updated = await service.generateBreakdown('u1', consultation.id);
    const breakdown = (updated.criteriaBreakdown as any)[0];

    expect(Object.keys(breakdown).sort()).toEqual(['criterionId', 'sourceSegmentId', 'whatWasSaid']);
  });

  it('acceptance-тест §7 ТЗ: reviewConsultation без generate-breakdown — 400, гейт вимагає draftedAt', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const provider = prisma._seedProvider({ configId: config.id, label: 'Хірург Z' });
    const consultation = prisma._seedConsultation({ providerId: provider.id, occurredAt: new Date() });
    const service = makeService(prisma);

    await expect(service.reviewConsultation('u1', consultation.id)).rejects.toThrow(BadRequestException);
  });

  it('reviewConsultation після generate-breakdown проходить, зберігає reviewNotes користувача', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const provider = prisma._seedProvider({ configId: config.id, label: 'Хірург Z' });
    const consultation = prisma._seedConsultation({ providerId: provider.id, occurredAt: new Date(), draftedAt: new Date() });
    const service = makeService(prisma);

    const reviewed = await service.reviewConsultation('u1', consultation.id, 'Хочу другу думку');

    expect(reviewed.reviewedAt).not.toBeNull();
    expect(reviewed.reviewNotes).toBe('Хочу другу думку');
  });

  it('регресійний тест (знайдено при реалізації, §3.3 ТЗ): addSourceReference завантажує ЛИШЕ вказаний URL, без AI-екстракції', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const provider = prisma._seedProvider({ configId: config.id, label: 'Хірург W' });

    let fetchedUrls: string[] = [];
    (global as any).fetch = jest.fn(async (url: string) => {
      fetchedUrls.push(url);
      return { ok: true, headers: { get: () => null }, text: async () => '<html>Стаття про метод лікування</html>' };
    });
    const service = makeService(prisma);

    const reference = await service.addSourceReference('u1', provider.id, 'https://example.com/article');

    expect(fetchedUrls).toEqual(['https://example.com/article']);
    expect(Object.keys(reference).sort()).toEqual(['createdAt', 'id', 'providerId', 'sourceText', 'sourceUrl']);
    (global as any).fetch = undefined;
  });

  it('регресійний тест (знайдено при аудиті одразу після реалізації): повторна generate-breakdown очищує старий reviewedAt/reviewNotes, не лишає їх прив\'язаними до нового контенту', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Терміновість', category: 'PROCEDURE_NECESSITY', isRequired: true, orderIndex: 0 });
    const provider = prisma._seedProvider({ configId: config.id, label: 'Хірург Q' });
    const conv = prisma._seedConversation({});
    prisma._seedSegment({ conversationId: conv.id, text: 'Перша версія розмови', startMs: 0 });
    const consultation = prisma._seedConsultation({
      providerId: provider.id,
      conversationId: conv.id,
      occurredAt: new Date(),
      draftedAt: new Date(),
      reviewedAt: new Date(),
      reviewNotes: 'Стара примітка користувача',
    });

    const aiRouter = { execute: async () => ({ text: JSON.stringify({ criteriaBreakdown: [{ criterionId: criterion.id, whatWasSaid: 'Нова відповідь' }] }) }) };
    const service = makeService(prisma, aiRouter);

    const updated = await service.generateBreakdown('u1', consultation.id);

    expect(updated.reviewedAt).toBeNull();
    expect(updated.reviewNotes).toBeNull();
  });

  it('acceptance-тест (Пункт [health-lab-ocr]): uploadLabDocument створює запис з verified=false ЗАВЖДИ, незалежно від вмісту OCR-тексту', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    let fetchedUrl = '';
    (global as any).fetch = jest.fn(async (url: string) => {
      fetchedUrl = url;
      return { ok: true, json: async () => ({ responses: [{ fullTextAnnotation: { text: 'Гемоглобін: 140 г/л' } }] }) };
    });
    const service = makeService(prisma);

    const draft = await service.uploadLabDocument('u1', config.id, 'ZmFrZS1iYXNlNjQ=');

    expect(draft.verified).toBe(false);
    expect(draft.ocrText).toBe('Гемоглобін: 140 г/л');
    expect(fetchedUrl).toContain('vision.googleapis.com');
    (global as any).fetch = undefined;
  });

  it('регресійний тест (НАЙВАЖЛИВІШИЙ, Пункт [health-lab-ocr]): generateBreakdown НІКОЛИ не читає HealthLabDocumentDraft, навіть якщо verified=true', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Терміновість', category: 'PROCEDURE_NECESSITY', isRequired: true, orderIndex: 0 });
    const provider = prisma._seedProvider({ configId: config.id, label: 'Хірург S' });
    const conv = prisma._seedConversation({});
    prisma._seedSegment({ conversationId: conv.id, text: 'Розмова з лікарем', startMs: 0 });
    const consultation = prisma._seedConsultation({ providerId: provider.id, conversationId: conv.id, occurredAt: new Date() });
    // Верифікований лабораторний документ з дуже специфічним текстом —
    // якби він потрапляв у промпт, ми б побачили цей рядок нижче.
    prisma._seedLabDraft({ configId: config.id, ocrText: 'СЕКРЕТНИЙ_МАРКЕР_ЛАБОРАТОРНОГО_РЕЗУЛЬТАТУ_12345', verified: true, verifiedAt: new Date() });

    let capturedUserPrompt = '';
    const aiRouter = {
      execute: async (req: any) => {
        capturedUserPrompt = req.userPrompt;
        return { text: JSON.stringify({ criteriaBreakdown: [{ criterionId: criterion.id, whatWasSaid: 'Щось сказано' }] }) };
      },
    };
    const service = makeService(prisma, aiRouter);

    await service.generateBreakdown('u1', consultation.id);

    expect(capturedUserPrompt).not.toContain('СЕКРЕТНИЙ_МАРКЕР_ЛАБОРАТОРНОГО_РЕЗУЛЬТАТУ_12345');
  });

  it('verifyLabDocument — єдиний шлях встановити verified=true, явний окремий виклик', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const draft = prisma._seedLabDraft({ configId: config.id, ocrText: 'текст' });
    const service = makeService(prisma);

    expect(draft.verified).toBe(false);
    const verified = await service.verifyLabDocument('u1', draft.id);

    expect(verified.verified).toBe(true);
    expect(verified.verifiedAt).not.toBeNull();
  });

  it('uploadLabDocument відхиляє файл, більший за ліміт', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const service = makeService(prisma);
    const hugeBase64 = 'A'.repeat(9_000_000);

    await expect(service.uploadLabDocument('u1', config.id, hugeBase64)).rejects.toThrow(BadRequestException);
  });

  it('uploadLabDocument вимагає ConsentType.EXTERNAL_AI', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const consent = { requireConsent: async () => { throw new ForbiddenException('нет согласия'); } };
    const service = makeService(prisma, undefined, undefined, consent);

    await expect(service.uploadLabDocument('u1', config.id, 'YQ==')).rejects.toThrow(ForbiddenException);
  });

  it('чужий користувач не має доступу до чужих lab-документів', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const draft = prisma._seedLabDraft({ configId: config.id, ocrText: 'текст' });
    const service = makeService(prisma);

    await expect(service.verifyLabDocument('stranger', draft.id)).rejects.toThrow(NotFoundException);
  });

  it('acceptance-тест §7 ТЗ (структурний): getComparisonTable НЕ повертає жодного поля score/rank/sortedBy', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    prisma._seedProvider({ configId: config.id, label: 'Хірург A' });
    prisma._seedProvider({ configId: config.id, label: 'Хірург B' });
    const service = makeService(prisma);

    const table = await service.getComparisonTable('u1', config.id);
    const serialized = JSON.stringify(table);

    expect(serialized.toLowerCase()).not.toContain('"score"');
    expect(serialized.toLowerCase()).not.toContain('"rank"');
    expect(serialized.toLowerCase()).not.toContain('sortedby');
    expect(table.providers.length).toBe(2);
  });

  it('generateBreakdown без пов’язаної Conversation — BadRequestException', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const provider = prisma._seedProvider({ configId: config.id, label: 'Хірург V' });
    const consultation = prisma._seedConsultation({ providerId: provider.id, conversationId: null, occurredAt: new Date() });
    const service = makeService(prisma);

    await expect(service.generateBreakdown('u1', consultation.id)).rejects.toThrow(BadRequestException);
  });

  it('регресійний тест (аудит одразу після реалізації): getConsultation/listConsultations/listSourceReferences раніше не існували взагалі', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const provider = prisma._seedProvider({ configId: config.id, label: 'Хірург T' });
    const consultation = prisma._seedConsultation({ providerId: provider.id, occurredAt: new Date() });
    prisma._seedSourceReference({ providerId: provider.id, sourceUrl: 'https://example.com', sourceText: 'текст' });
    const service = makeService(prisma);

    const fetchedConsultation = await service.getConsultation('u1', consultation.id);
    expect(fetchedConsultation.id).toBe(consultation.id);

    const list = await service.listConsultations('u1', provider.id);
    expect(list.length).toBe(1);

    const references = await service.listSourceReferences('u1', provider.id);
    expect(references.length).toBe(1);

    await expect(service.getConsultation('attacker', consultation.id)).rejects.toThrow(NotFoundException);
  });

  it('createConsultation відхиляє від\'ємний estimatedCost', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const provider = prisma._seedProvider({ configId: config.id, label: 'Хірург U' });
    const service = makeService(prisma);

    await expect(
      service.createConsultation('u1', provider.id, undefined, new Date().toISOString(), -100),
    ).rejects.toThrow(BadRequestException);
  });
});

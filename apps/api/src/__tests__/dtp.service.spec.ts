import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DtpService } from '../dtp/dtp.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const configs = new Map<string, any>();
  const criteria: any[] = [];
  const advisors = new Map<string, any>();
  const consultations = new Map<string, any>();
  const evidenceItems = new Map<string, any>();
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
      const advisor = { id: nextId(), advisorName: null, role: null, ...a };
      advisors.set(advisor.id, advisor);
      return advisor;
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
    _getEvidenceItems() {
      return [...evidenceItems.values()];
    },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        return p && p.ownerId === where.ownerId ? p : null;
      },
    },
    dtpConfig: {
      findUnique: async ({ where, include }: any) => {
        const config = where.id ? configs.get(where.id) : [...configs.values()].find((c) => c.projectId === where.projectId);
        if (!config) return null;
        if (include?.criteria) return { ...config, criteria: criteria.filter((c) => c.configId === config.id) };
        return config;
      },
      create: async ({ data, include }: any) => {
        const { criteria: criteriaInput, ...rest } = data;
        const config = { id: nextId(), targetBudget: null, currency: null, ...rest };
        configs.set(config.id, config);
        const created = (criteriaInput?.create ?? []).map((c: any) => ({ id: nextId(), configId: config.id, ...c }));
        created.forEach((c: any) => criteria.push(c));
        return include?.criteria ? { ...config, criteria: created } : config;
      },
    },
    dtpCriterion: {
      findMany: async ({ where }: any) => criteria.filter((c) => c.configId === where.configId).sort((a, b) => a.orderIndex - b.orderIndex),
    },
    dtpAdvisor: {
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
    dtpConsultation: {
      create: async ({ data }: any) => {
        const consultation = { id: nextId(), criteriaBreakdown: null, draftedAt: null, reviewedAt: null, reviewNotes: null, estimatedCost: null, ...data };
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
        let rows = [...consultations.values()];
        if (where?.advisorId) rows = rows.filter((c) => c.advisorId === where.advisorId);
        if (where?.advisor?.configId) rows = rows.filter((c) => advisors.get(c.advisorId)?.configId === where.advisor.configId);
        if (orderBy?.occurredAt) rows = rows.sort((a, b) => b.occurredAt - a.occurredAt);
        return rows;
      },
      update: async ({ where, data }: any) => {
        const c = consultations.get(where.id);
        Object.assign(c, data);
        return c;
      },
    },
    dtpEvidenceItem: {
      create: async ({ data }: any) => {
        const item = { id: nextId(), latitude: null, longitude: null, createdAt: new Date(), ...data };
        evidenceItems.set(item.id, item);
        return item;
      },
      findUnique: async ({ where, include }: any) => {
        const item = evidenceItems.get(where.id);
        if (!item) return null;
        if (include?.config) return { ...item, config: configs.get(item.configId) };
        return item;
      },
      findMany: async ({ where, orderBy }: any) => {
        let rows = [...evidenceItems.values()].filter((e) => e.configId === where.configId);
        if (orderBy?.capturedAt) rows = rows.sort((a, b) => b.capturedAt - a.capturedAt);
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
  consent: any = { requireConsent: async () => {} },
  secrets: any = { resolve: async () => 'fake-blob-token' },
) {
  return new DtpService(prisma as any, aiRouter as any, consent as any, secrets as any);
}

// putPrivateBlob() йде через глобальний fetch — той самий мок-патерн,
// що вже застосований для vision-ocr-client.ts (Пункт [health-lab-ocr]).
function mockBlobFetch() {
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ url: 'https://blob.vercel-storage.com/dtp-evidence/fake', pathname: 'dtp-evidence/fake', contentType: 'image/jpeg' }),
  }));
}

const FAKE_BASE64 = Buffer.from('fake evidence content').toString('base64');

describe('DtpService', () => {
  it('регресійний тест (повний аудит проєкту): createConfig відхиляє невалідну category критерію', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma);

    await expect(
      service.createConfig('u1', project.id, {
        goalDescription: 'x',
        targetBudget: null,
        currency: null,
        occurredAt: null,
        criteria: [{ text: 'Критерій', category: 'GARBAGE' as any, isRequired: true, orderIndex: 0 }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('createConfig фіксує чернетку разом з критеріями, відхиляє повторне створення', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma);

    const config = await service.createConfig('u1', project.id, {
      goalDescription: 'ДТП',
      targetBudget: 1000,
      currency: 'USD',
      occurredAt: null,
      criteria: [{ text: 'Хто винен', category: 'FAULT_DETERMINATION' as any, isRequired: true, orderIndex: 0 }],
    });

    expect(config.criteria.length).toBe(1);

    await expect(
      service.createConfig('u1', project.id, { goalDescription: 'дубль', targetBudget: null, currency: null, occurredAt: null, criteria: [] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('чужий користувач не має доступу до конфігу', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner' });
    const service = makeService(prisma);
    await service.createConfig('owner', project.id, { goalDescription: 'x', targetBudget: null, currency: null, occurredAt: null, criteria: [] });

    await expect(service.getConfig('stranger', project.id)).rejects.toThrow(NotFoundException);
  });

  it('acceptance-тест §7 ТЗ (НАЙВАЖЛИВІШИЙ, video-only): mediaType=PHOTO примусово скидає hasAudio=false, незалежно від переданого значення', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const service = makeService(prisma);
    mockBlobFetch();

    const item = await service.createEvidence('u1', config.id, 'PHOTO' as any, true, FAKE_BASE64, 'image/jpeg', new Date().toISOString());

    expect(item.hasAudio).toBe(false);
    (global as any).fetch = undefined;
  });

  it('acceptance-тест §7 ТЗ: hasAudio за замовчуванням false, video-only — центральне рішення документа', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const service = makeService(prisma);
    mockBlobFetch();

    const item = await service.createEvidence('u1', config.id, 'VIDEO' as any, false, FAKE_BASE64, 'video/mp4', new Date().toISOString());

    expect(item.hasAudio).toBe(false);
    (global as any).fetch = undefined;
  });

  it('acceptance-тест §7 ТЗ: VIDEO з hasAudio=true вимагає ConsentType.THIRD_PARTY_AUDIO_RECORDING', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    let capturedConsentType = '';
    const consent = { requireConsent: async (_u: string, type: string) => { capturedConsentType = type; } };
    const service = makeService(prisma, undefined, consent);
    mockBlobFetch();

    const item = await service.createEvidence('u1', config.id, 'VIDEO' as any, true, FAKE_BASE64, 'video/mp4', new Date().toISOString());

    expect(item.hasAudio).toBe(true);
    expect(capturedConsentType).toBe('THIRD_PARTY_AUDIO_RECORDING');
    (global as any).fetch = undefined;
  });

  it('VIDEO з hasAudio=true, без згоди — ForbiddenException, запис не створюється, putPrivateBlob НЕ викликається', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const consent = { requireConsent: async () => { throw new ForbiddenException('нет согласия'); } };
    const service = makeService(prisma, undefined, consent);
    let fetchCalled = false;
    (global as any).fetch = jest.fn(async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; });

    await expect(
      service.createEvidence('u1', config.id, 'VIDEO' as any, true, FAKE_BASE64, 'video/mp4', new Date().toISOString()),
    ).rejects.toThrow(ForbiddenException);
    expect(fetchCalled).toBe(false);
    (global as any).fetch = undefined;
  });

  it('acceptance-тест §7 ТЗ: latitude/longitude вимагають ConsentType.LOCATION', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const capturedTypes: string[] = [];
    const consent = { requireConsent: async (_u: string, type: string) => { capturedTypes.push(type); } };
    const service = makeService(prisma, undefined, consent);
    mockBlobFetch();

    await service.createEvidence('u1', config.id, 'PHOTO' as any, false, FAKE_BASE64, 'image/jpeg', new Date().toISOString(), 50.45, 30.52);

    expect(capturedTypes).toContain('LOCATION');
    (global as any).fetch = undefined;
  });

  it('createEvidence без гео не вимагає ConsentType.LOCATION взагалі', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const capturedTypes: string[] = [];
    const consent = { requireConsent: async (_u: string, type: string) => { capturedTypes.push(type); } };
    const service = makeService(prisma, undefined, consent);
    mockBlobFetch();

    await service.createEvidence('u1', config.id, 'PHOTO' as any, false, FAKE_BASE64, 'image/jpeg', new Date().toISOString());

    expect(capturedTypes).toEqual([]);
    (global as any).fetch = undefined;
  });

  it('регресійний тест (аудит одразу після реалізації): невалідний mediaType відхиляється, не потрапляє мовчки в гілку "не PHOTO"', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const service = makeService(prisma);

    await expect(
      service.createEvidence('u1', config.id, 'GARBAGE' as any, true, FAKE_BASE64, 'image/jpeg', new Date().toISOString()),
    ).rejects.toThrow(BadRequestException);
  });

  it('регресійний тест (аудит одразу після реалізації): latitude без longitude (і навпаки) відхиляється — не безглузда половинна координата', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const service = makeService(prisma);

    await expect(
      service.createEvidence('u1', config.id, 'PHOTO' as any, false, FAKE_BASE64, 'image/jpeg', new Date().toISOString(), 50.45, undefined),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.createEvidence('u1', config.id, 'PHOTO' as any, false, FAKE_BASE64, 'image/jpeg', new Date().toISOString(), undefined, 30.52),
    ).rejects.toThrow(BadRequestException);
  });

  it('регресійний тест (аудит одразу після реалізації): дешева валідація (base64Content) відбувається ДО дорогого consent-виклику', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    let consentCalled = false;
    const consent = { requireConsent: async () => { consentCalled = true; } };
    const service = makeService(prisma, undefined, consent);

    await expect(
      service.createEvidence('u1', config.id, 'VIDEO' as any, true, '  ', 'image/jpeg', new Date().toISOString()),
    ).rejects.toThrow(BadRequestException);
    expect(consentCalled).toBe(false);
  });

  it('createEvidence відхиляє порожній base64Content', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const service = makeService(prisma);

    await expect(
      service.createEvidence('u1', config.id, 'PHOTO' as any, false, '  ', 'image/jpeg', new Date().toISOString()),
    ).rejects.toThrow(BadRequestException);
  });

  it('регресійний тест (найважливіший цього аудиту): createEvidence реально викликає putPrivateBlob (через fetch) і обчислює SHA-256 на сервері, не довіряє клієнту', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const service = makeService(prisma);
    let fetchCalled = false;
    let capturedAuth = '';
    (global as any).fetch = jest.fn(async (_url: string, opts: any) => {
      fetchCalled = true;
      capturedAuth = opts.headers.Authorization;
      return { ok: true, json: async () => ({ url: 'https://blob.vercel-storage.com/x', pathname: 'x', contentType: 'image/jpeg' }) };
    });

    const item = await service.createEvidence('u1', config.id, 'PHOTO' as any, false, FAKE_BASE64, 'image/jpeg', new Date().toISOString());

    expect(fetchCalled).toBe(true);
    expect(capturedAuth).toBe('Bearer fake-blob-token');
    expect(item.blobUrl).toBe('https://blob.vercel-storage.com/x');
    expect(item.fileHash.length).toBe(64); // SHA-256 hex — 64 символи, обчислений сервером
    (global as any).fetch = undefined;
  });


  it('acceptance-тест §7 ТЗ (НАЙВАЖЛИВІШИЙ, суддя): system prompt generate-breakdown містить явну заборону на висновок про винуватця', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Хто винен', category: 'FAULT_DETERMINATION', isRequired: true, orderIndex: 0 });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Страховий агент X' });
    const conv = prisma._seedConversation({});
    prisma._seedSegment({ conversationId: conv.id, text: 'Агент каже: попередньо винен другий водій', startMs: 0 });
    const consultation = prisma._seedConsultation({ advisorId: advisor.id, conversationId: conv.id, occurredAt: new Date() });

    let capturedSystemPrompt = '';
    const aiRouter = {
      execute: async (req: any) => {
        capturedSystemPrompt = req.systemPrompt;
        return { text: JSON.stringify({ criteriaBreakdown: [{ criterionId: criterion.id, whatWasSaid: 'Агент сказав про попереднє визначення' }] }) };
      },
    };
    const service = makeService(prisma, aiRouter);

    await service.generateBreakdown('u1', consultation.id);

    expect(capturedSystemPrompt.toLowerCase()).toContain('хто винен у дтп');
  });

  it('acceptance-тест §7 ТЗ: criteriaBreakdown має ТІЛЬКИ criterionId/whatWasSaid/sourceSegmentId', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Ремонт', category: 'DAMAGE_AND_REPAIR', isRequired: true, orderIndex: 0 });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Експерт Y' });
    const conv = prisma._seedConversation({});
    prisma._seedSegment({ conversationId: conv.id, text: 'Оцінка ремонту', startMs: 0 });
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

  it('регресійний тест: повторна generate-breakdown очищує старий reviewedAt/reviewNotes (застосовано одразу, той самий урок, що health/family-law)', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const criterion = prisma._seedCriterion({ configId: config.id, text: 'Ремонт', category: 'DAMAGE_AND_REPAIR', isRequired: true, orderIndex: 0 });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Експерт Q' });
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
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Юрист Z' });
    const consultation = prisma._seedConsultation({ advisorId: advisor.id, occurredAt: new Date() });
    const service = makeService(prisma);

    await expect(service.reviewConsultation('u1', consultation.id)).rejects.toThrow(BadRequestException);
  });

  it('acceptance-тест §7 ТЗ (структурний): getComparisonTable НЕ повертає жодного поля score/rank/sortedBy', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    prisma._seedAdvisor({ configId: config.id, label: 'Агент A' });
    prisma._seedAdvisor({ configId: config.id, label: 'Агент B' });
    const service = makeService(prisma);

    const table = await service.getComparisonTable('u1', config.id);
    const serialized = JSON.stringify(table);

    expect(serialized.toLowerCase()).not.toContain('"score"');
    expect(serialized.toLowerCase()).not.toContain('"rank"');
    expect(serialized.toLowerCase()).not.toContain('sortedby');
    expect(table.advisors.length).toBe(2);
  });

  it('acceptance-тест §7 ТЗ (аудит-фікс §5.5): comparison-table повертає budget з арифметичною сумою estimatedCost', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x', targetBudget: 2000, currency: 'USD' });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Агент C' });
    prisma._seedConsultation({ advisorId: advisor.id, occurredAt: new Date(), estimatedCost: 300 });
    prisma._seedConsultation({ advisorId: advisor.id, occurredAt: new Date(), estimatedCost: 450 });
    const service = makeService(prisma);

    const table = await service.getComparisonTable('u1', config.id);

    expect(table.budget.targetBudget).toBe(2000);
    expect(table.budget.totalEstimatedCost).toBe(750);
  });

  it('generateBreakdown без пов’язаної Conversation — BadRequestException', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Агент V' });
    const consultation = prisma._seedConsultation({ advisorId: advisor.id, conversationId: null, occurredAt: new Date() });
    const service = makeService(prisma);

    await expect(service.generateBreakdown('u1', consultation.id)).rejects.toThrow(BadRequestException);
  });

  it('createConsultation відхиляє від\'ємний estimatedCost', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const advisor = prisma._seedAdvisor({ configId: config.id, label: 'Агент U' });
    const service = makeService(prisma);

    await expect(
      service.createConsultation('u1', advisor.id, undefined, new Date().toISOString(), -100),
    ).rejects.toThrow(BadRequestException);
  });

  it('чужий користувач не має доступу до чужого доказу', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner' });
    const config = prisma._seedConfig({ projectId: project.id, goalDescription: 'x' });
    const service = makeService(prisma);
    mockBlobFetch();
    const item = await service.createEvidence('owner', config.id, 'PHOTO' as any, false, FAKE_BASE64, 'image/jpeg', new Date().toISOString());
    (global as any).fetch = undefined;

    await expect(service.getEvidence('stranger', item.id)).rejects.toThrow(NotFoundException);
  });
});

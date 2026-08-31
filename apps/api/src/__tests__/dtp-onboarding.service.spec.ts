import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DtpOnboardingService } from '../dtp/dtp-onboarding.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const conversations = new Map<string, any>();
  const participants = new Map<string, any>();
  const transcripts = new Map<string, any>();
  const segments: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  const client: any = {
    _seedProject(p: any) {
      const project = { id: nextId(), ...p };
      projects.set(project.id, project);
      return project;
    },

    project: {
      create: async ({ data }: any) => {
        const project = { id: nextId(), ...data };
        projects.set(project.id, project);
        return project;
      },
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        return p && p.ownerId === where.ownerId ? p : null;
      },
    },
    conversation: {
      create: async ({ data }: any) => {
        const conv = { id: nextId(), ...data };
        conversations.set(conv.id, conv);
        return conv;
      },
      findUnique: async ({ where, include }: any) => {
        const conv = conversations.get(where.id);
        if (!conv) return null;
        if (include?.project) return { ...conv, project: projects.get(conv.projectId) };
        return conv;
      },
    },
    conversationParticipant: {
      create: async ({ data }: any) => {
        const p = { id: nextId(), ...data };
        participants.set(p.id, p);
        return p;
      },
      findFirst: async ({ where }: any) =>
        [...participants.values()].find((p) => p.conversationId === where.conversationId && p.isSelf === where.isSelf) ?? null,
    },
    transcript: {
      create: async ({ data }: any) => {
        const t = { id: nextId(), ...data };
        transcripts.set(t.conversationId, t);
        return t;
      },
      findUnique: async ({ where, include }: any) => {
        const t = transcripts.get(where.conversationId);
        if (!t) return null;
        if (include?.segments) return { ...t, segments: segments.filter((s) => s.transcriptId === t.id) };
        return t;
      },
    },
    transcriptSegment: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), ...data };
        segments.push(s);
        return s;
      },
      findFirst: async ({ where }: any) => {
        const rows = segments.filter((s) => s.transcriptId === where.transcriptId).sort((a, b) => b.endMs - a.endMs);
        return rows[0] ?? null;
      },
    },
  };
  client.$transaction = async (fn: (tx: any) => Promise<any>) => fn(client);
  return client;
}

function createFakeAiRouter(responseText: string) {
  return { execute: async () => ({ aiInferenceId: 'inf-1', jobId: 'job-1', text: responseText }) } as any;
}

function makeService(prisma: any, aiRouter: any) {
  return new DtpOnboardingService(prisma as any, aiRouter as any);
}

describe('DtpOnboardingService', () => {
  it('createProject встановлює mode=DTP, відхиляє порожній question', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma, createFakeAiRouter('{}'));

    const project = await service.createProject('u1', 'ДТП на перехресті');
    expect(project.mode).toBe('DTP');

    await expect(service.createProject('u1', '   ')).rejects.toThrow(BadRequestException);
  });

  it('createOnboardingConversation створює TEXT_IMPORT Conversation, чужий проєкт — NotFoundException', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma, createFakeAiRouter('{}'));

    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    expect(conversation.sourceType).toBe('TEXT_IMPORT');

    await expect(service.createOnboardingConversation('attacker', project.id)).rejects.toThrow(NotFoundException);
  });

  it('acceptance-тест §7 ТЗ: extract повертає критерії, розподілені по трьох категоріях, коли всі обговорювались', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const aiResponse = JSON.stringify({
      goalDescription: 'ДТП на перехресті, потрібна допомога з процесом',
      targetBudget: 1500,
      currency: 'USD',
      occurredAt: '2026-08-01T10:00:00Z',
      criteria: [
        { text: 'Що сказано про визначення винуватця', category: 'FAULT_DETERMINATION', isRequired: true },
        { text: 'Оцінка пошкоджень бампера', category: 'DAMAGE_AND_REPAIR', isRequired: true },
        { text: 'Що покриває страховка КАСКО', category: 'INSURANCE_COVERAGE', isRequired: true },
      ],
    });
    const service = makeService(prisma, createFakeAiRouter(aiResponse));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'ДТП, потрібна допомога з винуватцем, ремонтом, страховкою');

    const draft = await service.extract('u1', conversation.id);

    expect(draft.criteria.length).toBe(3);
    expect(draft.criteria.map((c) => c.category).sort()).toEqual(['DAMAGE_AND_REPAIR', 'FAULT_DETERMINATION', 'INSURANCE_COVERAGE']);
    expect(draft.occurredAt).toBe('2026-08-01T10:00:00Z');
  });

  it('acceptance-тест §7 ТЗ: користувач не згадав страховку — чернетка НЕ містить вигаданого критерію INSURANCE_COVERAGE', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const aiResponse = JSON.stringify({
      goalDescription: 'ДТП, лише питання винуватця й ремонту',
      criteria: [
        { text: 'Хто визнаний винним', category: 'FAULT_DETERMINATION', isRequired: true },
        { text: 'Вартість ремонту', category: 'DAMAGE_AND_REPAIR', isRequired: true },
      ],
    });
    const service = makeService(prisma, createFakeAiRouter(aiResponse));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Про страховку взагалі не питали');

    const draft = await service.extract('u1', conversation.id);

    expect(draft.criteria.some((c) => c.category === 'INSURANCE_COVERAGE')).toBe(false);
    expect(draft.criteria.length).toBe(2);
  });

  it('extract на порожній розмові відхиляється, не викликає AI даремно', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    let aiCalled = false;
    const aiRouter = { execute: async () => { aiCalled = true; return { text: '{}' }; } };
    const service = makeService(prisma, aiRouter);
    const { conversation } = await service.createOnboardingConversation('u1', project.id);

    await expect(service.extract('u1', conversation.id)).rejects.toThrow(BadRequestException);
    expect(aiCalled).toBe(false);
  });

  it('невалідна category з AI-відповіді безпечно мапиться на OTHER, не падає', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const aiResponse = JSON.stringify({
      goalDescription: 'Опис',
      criteria: [{ text: 'Якийсь критерій', category: 'NONSENSE_VALUE', isRequired: true }],
    });
    const service = makeService(prisma, createFakeAiRouter(aiResponse));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Щось');

    const draft = await service.extract('u1', conversation.id);

    expect(draft.criteria[0].category).toBe('OTHER');
  });
});

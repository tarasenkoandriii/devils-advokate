import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { HealthOnboardingService } from '../health/health-onboarding.service';

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

function makeService(prisma: any, aiRouter: any, consent: any = { requireConsent: async () => {} }) {
  return new HealthOnboardingService(prisma as any, aiRouter as any, consent as any);
}

describe('HealthOnboardingService', () => {
  it('acceptance-тест §3.5 ТЗ: createProject вимагає ConsentType.HEALTH_DATA', async () => {
    const prisma = createFakePrisma();
    const consent = { requireConsent: async () => { throw new ForbiddenException('Consent required: HEALTH_DATA'); } };
    const service = makeService(prisma, createFakeAiRouter('{}'), consent);

    await expect(service.createProject('u1', 'Питання про операцію')).rejects.toThrow(ForbiddenException);
  });

  it('createProject встановлює mode=HEALTH, відхиляє порожній question', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma, createFakeAiRouter('{}'));

    const project = await service.createProject('u1', 'Чи потрібна операція на коліні');
    expect(project.mode).toBe('HEALTH');

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
      goalDescription: 'Чи потрібна операція на коліні',
      targetBudget: 5000,
      currency: 'USD',
      criteria: [
        { text: 'Наскільки терміново потрібна операція', category: 'PROCEDURE_NECESSITY', isRequired: true },
        { text: 'Які альтернативні методи лікування', category: 'RISKS_AND_ALTERNATIVES', isRequired: true },
        { text: 'Що покриває страховка', category: 'COST', isRequired: true },
      ],
    });
    const service = makeService(prisma, createFakeAiRouter(aiResponse));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Питання про коліно, ризики, страховку');

    const draft = await service.extract('u1', conversation.id);

    expect(draft.criteria.length).toBe(3);
    expect(draft.criteria.map((c) => c.category).sort()).toEqual(['COST', 'PROCEDURE_NECESSITY', 'RISKS_AND_ALTERNATIVES']);
  });

  it('acceptance-тест §7 ТЗ: користувач не згадав бюджет — чернетка НЕ містить вигаданого критерію COST', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const aiResponse = JSON.stringify({
      goalDescription: 'Вибір методу лікування',
      criteria: [
        { text: 'Наскільки терміново', category: 'PROCEDURE_NECESSITY', isRequired: true },
        { text: 'Ризики операції', category: 'RISKS_AND_ALTERNATIVES', isRequired: true },
      ],
    });
    const service = makeService(prisma, createFakeAiRouter(aiResponse));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Про бюджет взагалі не питали');

    const draft = await service.extract('u1', conversation.id);

    expect(draft.criteria.some((c) => c.category === 'COST')).toBe(false);
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

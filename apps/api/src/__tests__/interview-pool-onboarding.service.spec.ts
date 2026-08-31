import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InterviewPoolOnboardingService } from '../interview-pool/interview-pool-onboarding.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const conversations = new Map<string, any>();
  const participants = new Map<string, any>();
  const transcripts = new Map<string, any>();
  const segments: any[] = [];
  const teamMembers: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  const client: any = {
    _seedProject(p: any) {
      const project = { id: nextId(), ...p };
      projects.set(project.id, project);
      return project;
    },
    _seedTeamMembership(m: any) {
      teamMembers.push(m);
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
      findUnique: async ({ where }: any) => projects.get(where.id) ?? null,
    },
    recruitingTeamMember: {
      findUnique: async ({ where }: any) =>
        teamMembers.find((m) => m.teamId === where.teamId_userId.teamId && m.userId === where.teamId_userId.userId) ?? null,
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
  return new InterviewPoolOnboardingService(prisma as any, aiRouter as any);
}

describe('InterviewPoolOnboardingService', () => {
  it('createProject встановлює mode=INTERVIEW_POOL, відхиляє порожній question', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma, createFakeAiRouter('{}'));

    const project = await service.createProject('u1', 'Пошук Senior Backend Engineer');
    expect(project.mode).toBe('INTERVIEW_POOL');

    await expect(service.createProject('u1', '   ')).rejects.toThrow(BadRequestException);
  });

  it('createProject з recruitingTeamId відхиляється, якщо userId не член команди', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma, createFakeAiRouter('{}'));

    await expect(service.createProject('u1', 'Вакансія', 'team-1')).rejects.toThrow(NotFoundException);
  });

  it('getChecklist повертає фіксований 10-пунктний перелік §4.8 ТЗ', () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma, createFakeAiRouter('{}'));

    const checklist = service.getChecklist();

    expect(checklist.length).toBe(10);
    expect(checklist.some((i) => i.includes('Стать'))).toBe(true);
    expect(checklist.some((i) => i.includes('важка праця'))).toBe(true);
  });

  it('createOnboardingConversation створює TEXT_IMPORT Conversation + isSelf учасника, чужий проєкт — NotFoundException', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma, createFakeAiRouter('{}'));

    const { conversation, participant } = await service.createOnboardingConversation('u1', project.id);
    expect(conversation.sourceType).toBe('TEXT_IMPORT');
    expect(participant.isSelf).toBe(true);

    await expect(service.createOnboardingConversation('attacker', project.id)).rejects.toThrow(NotFoundException);
  });

  it('член команди має доступ до онбордінгу командного проєкту (§4.5 ТЗ)', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner', recruitingTeamId: 'team-1' });
    prisma._seedTeamMembership({ teamId: 'team-1', userId: 'colleague' });
    const service = makeService(prisma, createFakeAiRouter('{}'));

    await expect(service.createOnboardingConversation('colleague', project.id)).resolves.toBeDefined();
  });

  it('acceptance-тест §7 ТЗ: замовник каже про фізично важку працю зі статтю/віком — extract повертає структуровані поля', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const aiResponse = JSON.stringify({
      jobTitle: 'Вантажник складу',
      extendedDescription: 'Фізично важка робота, підйом вантажів до 40кг',
      genderRequirement: 'MALE',
      ageRequirement: 'RANGE',
      minAge: 20,
      maxAge: 45,
      isPhysicallyDemanding: true,
      interviewStages: [{ name: 'Співбесіда з керівником складу', isTestAssignment: false }],
      complianceFlags: [],
    });
    const service = makeService(prisma, createFakeAiRouter(aiResponse));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Шукаємо вантажника, важка фізична праця, чоловіки 20-45');

    const draft = await service.extract('u1', conversation.id);

    expect(draft.genderRequirement).toBe('MALE');
    expect(draft.ageRequirement).toBe('RANGE');
    expect(draft.maxAge).toBe(45);
    expect(draft.isPhysicallyDemanding).toBe(true);
  });

  it('acceptance-тест §7 ТЗ: замовник нічого не каже про стать/вік — дефолт NOT_IMPORTANT, не null/undefined', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const aiResponse = JSON.stringify({
      jobTitle: 'Frontend Developer',
      extendedDescription: 'React, TypeScript',
      interviewStages: [],
      complianceFlags: [],
    });
    const service = makeService(prisma, createFakeAiRouter(aiResponse));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Шукаємо React-розробника');

    const draft = await service.extract('u1', conversation.id);

    expect(draft.genderRequirement).toBe('NOT_IMPORTANT');
    expect(draft.ageRequirement).toBe('NOT_IMPORTANT');
  });

  it('acceptance-тест §7 ТЗ (§2.6a): згадка релігії/раси НЕ потрапляє в жодне структуроване поле, тільки в complianceFlags', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const aiResponse = JSON.stringify({
      jobTitle: 'Помічник по господарству',
      extendedDescription: 'Опис вакансії',
      interviewStages: [],
      complianceFlags: [{ category: 'religion', quotedText: 'бажано, щоб кандидат був тієї ж релігії, що й сім\'я' }],
    });
    const service = makeService(prisma, createFakeAiRouter(aiResponse));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Шукаємо помічника, бажано тієї ж релігії');

    const draft = await service.extract('u1', conversation.id);

    expect((draft as any).religionRequirement).toBeUndefined();
    expect(draft.complianceFlags.length).toBe(1);
    expect(draft.complianceFlags[0].category).toBe('religion');
    expect(draft.complianceFlags[0].quotedText).toContain('релігії');
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
});

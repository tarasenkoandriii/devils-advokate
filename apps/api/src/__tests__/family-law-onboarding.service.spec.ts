import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FamilyLawOnboardingService } from '../family-law/family-law-onboarding.service';

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
      // Пункт [onboarding-continuity] 2026-09-02: хелпер сначала ищет
      // уже существующий онбординг-разговор проекта — фейку нужен
      // findFirst, иначе повторный вызов снова плодил бы разговоры.
      findFirst: async ({ where, include }: any) => {
        const found = [...conversations.values()]
          .filter((c: any) => c.projectId === where.projectId && c.sourceType === where.sourceType)
          // Ревью 2026-09-02: хелпер отсекает чужие TEXT_IMPORT-разговоры
          // (импорт переписки) по участнику SELF и наличию транскрипта —
          // фейк обязан считать так же, иначе тест «не подхватываем чужой
          // разговор» проходил бы сам собой.
          .filter((c: any) => !where.participants || [...participants.values()].some(
            (p: any) => p.conversationId === c.id && p.isSelf && p.diarizationLabel === 'SELF',
          ))
          .filter((c: any) => !where.transcript || transcripts.get(c.id) != null)[0];
        if (!found) return null;
        if (!include) return found;
        return {
          ...found,
          transcript: transcripts.get(found.id) ?? null,
          participants: [...participants.values()].filter((p: any) => p.conversationId === found.id && p.isSelf),
        };
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
  return new FamilyLawOnboardingService(prisma as any, aiRouter as any);
}

describe('FamilyLawOnboardingService', () => {
  it('acceptance-тест §0/§7 ТЗ: createProject встановлює mode=FAMILY_LAW і contractType ЯВНО, не вгадано AI', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma, createFakeAiRouter('{}'));

    const project = await service.createProject('u1', 'Готуємось до шлюбного договору', 'PRENUP' as any);

    expect(project.mode).toBe('FAMILY_LAW');
    expect(project.contractType).toBe('PRENUP');
  });

  it('createProject приймає DIVORCE_SETTLEMENT так само явно', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma, createFakeAiRouter('{}'));

    const project = await service.createProject('u1', 'Розділ майна', 'DIVORCE_SETTLEMENT' as any);

    expect(project.contractType).toBe('DIVORCE_SETTLEMENT');
  });

  it('createProject відхиляє невалідний contractType і порожній question', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma, createFakeAiRouter('{}'));

    await expect(service.createProject('u1', 'Питання', 'NONSENSE' as any)).rejects.toThrow(BadRequestException);
    await expect(service.createProject('u1', '   ', 'PRENUP' as any)).rejects.toThrow(BadRequestException);
  });

  it('createOnboardingConversation створює TEXT_IMPORT Conversation, чужий проєкт — NotFoundException', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'PRENUP' });
    const service = makeService(prisma, createFakeAiRouter('{}'));

    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    expect(conversation.sourceType).toBe('TEXT_IMPORT');

    await expect(service.createOnboardingConversation('attacker', project.id)).rejects.toThrow(NotFoundException);
  });

  it('acceptance-тест §7 ТЗ: extract повертає критерії, розподілені по трьох категоріях, коли всі обговорювались', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'DIVORCE_SETTLEMENT' });
    const aiResponse = JSON.stringify({
      goalDescription: 'Розділ майна при розлученні',
      targetBudget: 3000,
      currency: 'USD',
      criteria: [
        { text: 'Як ділиться спільна нерухомість', category: 'ASSET_DIVISION', isRequired: true },
        { text: 'Розмір аліментів', category: 'FINANCIAL_SUPPORT', isRequired: true },
        { text: 'Вартість юридичного супроводу', category: 'PROCESS_AND_COST', isRequired: true },
      ],
    });
    const service = makeService(prisma, createFakeAiRouter(aiResponse));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Питання про майно, аліменти, вартість процесу');

    const draft = await service.extract('u1', conversation.id);

    expect(draft.criteria.length).toBe(3);
    expect(draft.criteria.map((c) => c.category).sort()).toEqual(['ASSET_DIVISION', 'FINANCIAL_SUPPORT', 'PROCESS_AND_COST']);
  });

  it('acceptance-тест §7 ТЗ: користувач не згадав аліменти — чернетка НЕ містить вигаданого критерію FINANCIAL_SUPPORT', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'PRENUP' });
    const aiResponse = JSON.stringify({
      goalDescription: 'Шлюбний договір, лише майно',
      criteria: [{ text: 'Розділ майна до шлюбу', category: 'ASSET_DIVISION', isRequired: true }],
    });
    const service = makeService(prisma, createFakeAiRouter(aiResponse));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Про аліменти взагалі не питали');

    const draft = await service.extract('u1', conversation.id);

    expect(draft.criteria.some((c) => c.category === 'FINANCIAL_SUPPORT')).toBe(false);
    expect(draft.criteria.length).toBe(1);
  });

  it('extract на порожній розмові відхиляється, не викликає AI даремно', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'PRENUP' });
    let aiCalled = false;
    const aiRouter = { execute: async () => { aiCalled = true; return { text: '{}' }; } };
    const service = makeService(prisma, aiRouter);
    const { conversation } = await service.createOnboardingConversation('u1', project.id);

    await expect(service.extract('u1', conversation.id)).rejects.toThrow(BadRequestException);
    expect(aiCalled).toBe(false);
  });

  it('невалідна category з AI-відповіді безпечно мапиться на OTHER, не падає', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1', contractType: 'PRENUP' });
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

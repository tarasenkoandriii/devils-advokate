import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InvestmentOnboardingService } from '../investment/investment-onboarding.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const conversations = new Map<string, any>();
  const participants = new Map<string, any>();
  const transcripts = new Map<string, any>();
  const segments: any[] = [];
  const groupMembers: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  const client: any = {
    _seedProject(p: any) {
      const project = { id: nextId(), ...p };
      projects.set(project.id, project);
      return project;
    },
    _seedGroupMembership(m: any) {
      groupMembers.push(m);
    },

    project: {
      create: async ({ data }: any) => {
        const project = { id: nextId(), ...data };
        projects.set(project.id, project);
        return project;
      },
      findUnique: async ({ where }: any) => projects.get(where.id) ?? null,
    },
    investmentGroupMember: {
      findUnique: async ({ where }: any) =>
        groupMembers.find((m) => m.groupId === where.groupId_userId.groupId && m.userId === where.groupId_userId.userId) ?? null,
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
  return new InvestmentOnboardingService(prisma as any, aiRouter as any);
}

describe('InvestmentOnboardingService', () => {
  it('createProject встановлює mode=INVESTMENT, відхиляє порожній question', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma, createFakeAiRouter('{}'));

    const project = await service.createProject('u1', 'Пошук інвестиційного фонду');
    expect(project.mode).toBe('INVESTMENT');

    await expect(service.createProject('u1', '   ')).rejects.toThrow(BadRequestException);
  });

  it('createProject з investmentGroupId відхиляється, якщо userId не член групи', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma, createFakeAiRouter('{}'));

    await expect(service.createProject('u1', 'Спільна інвестиція', 'group-1')).rejects.toThrow(NotFoundException);
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
      goalDescription: 'Диверсифікований портфель',
      targetBudget: 50000,
      currency: 'USD',
      criteria: [
        { text: 'Яка заявлена гарантія дохідності', category: 'RETURN_GUARANTEE', isRequired: true },
        { text: 'Чи розкрито структуру комісій', category: 'FEES_AND_LOSSES', isRequired: true },
        { text: 'Як оподатковується прибуток', category: 'TAXATION', isRequired: true },
      ],
    });
    const service = makeService(prisma, createFakeAiRouter(aiResponse));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Шукаю фонд, цікавить дохідність, комісії, податки');

    const draft = await service.extract('u1', conversation.id);

    expect(draft.criteria.length).toBe(3);
    expect(draft.criteria.map((c) => c.category).sort()).toEqual(['FEES_AND_LOSSES', 'RETURN_GUARANTEE', 'TAXATION']);
  });

  it('acceptance-тест §7 ТЗ: замовник не згадав оподаткування — чернетка НЕ містить вигаданого критерію TAXATION', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const aiResponse = JSON.stringify({
      goalDescription: 'Інвестиція в нерухомість через фонд',
      criteria: [
        { text: 'Гарантія дохідності 8% річних', category: 'RETURN_GUARANTEE', isRequired: true },
        { text: 'Комісія за вхід 2%', category: 'FEES_AND_LOSSES', isRequired: true },
      ],
    });
    const service = makeService(prisma, createFakeAiRouter(aiResponse));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Про податки взагалі не питали');

    const draft = await service.extract('u1', conversation.id);

    expect(draft.criteria.some((c) => c.category === 'TAXATION')).toBe(false);
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

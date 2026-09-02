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
    /** Импортированная переписка: тот же sourceType TEXT_IMPORT и
     *  транскрипт, но участники — IMPORTED_*, не SELF. Ревью
     *  2026-09-02: именно её онбординг НЕ должен принимать за свой. */
    _seedImportedChat(projectId: string) {
      const conv = { id: nextId(), projectId, sourceType: 'TEXT_IMPORT', createdAt: new Date(0) };
      conversations.set(conv.id, conv);
      const p1 = { id: nextId(), conversationId: conv.id, diarizationLabel: 'IMPORTED_0', isSelf: false };
      participants.set(p1.id, p1);
      transcripts.set(conv.id, { id: nextId(), conversationId: conv.id });
      return conv;
    },
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

  it('КЛЮЧОВИЙ ТЕСТ [onboarding-continuity]: повторний виклик повертає ТОЙ САМИЙ розмову, а не створює нову', async () => {
    // Знайдено аудитом 2026-09-02. Екран домену в TMA викликає це
    // щоразу, коли не знає conversationId, — а не знав він його завжди:
    // intake повертав id, перехід на екран його викидав. Кожен вхід
    // створював порожню розмову, і відповіді голосової вікторини
    // залишалися в першій, недосяжній. Обіцянка «дані не доведеться
    // вводити повторно» не працювала жодного разу.
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(
      prisma,
      createFakeAiRouter(JSON.stringify({ goalDescription: 'Опис', criteria: [] })),
    );

    const first = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', first.conversation.id, 'Відповідь з вікторини');
    const second = await service.createOnboardingConversation('u1', project.id);

    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.reused).toBe(true);
    // І сама відповідь на місці — extract її бачить (на порожній
    // розмові він відхиляє запит, див. наступний тест).
    await expect(service.extract('u1', second.conversation.id)).resolves.toBeDefined();
  });

  it('КЛЮЧОВИЙ ТЕСТ [onboarding-continuity]: імпортована переписка НЕ приймається за онбординг-розмову', async () => {
    // Ревью 2026-09-02: chat-import створює розмови з тим самим
    // sourceType TEXT_IMPORT, статусом і транскриптом. Якби хелпер
    // розрізняв їх лише за sourceType, відповіді онбордингу дописалися б
    // у транскрипт чужої переписки, а extract прочитав би весь чат як
    // відповіді користувача.
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const imported = prisma._seedImportedChat(project.id);
    const service = makeService(prisma, createFakeAiRouter(JSON.stringify({ goalDescription: 'Опис', criteria: [] })));

    const created = await service.createOnboardingConversation('u1', project.id);

    expect(created.conversation.id).not.toBe(imported.id);
    expect(created.reused).toBe(false);
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

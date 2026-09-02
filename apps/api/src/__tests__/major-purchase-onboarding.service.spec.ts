import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MajorPurchaseOnboardingService } from '../major-purchase/major-purchase-onboarding.service';
import { getOnboardingChecklist } from '../major-purchase/major-purchase-checklist';

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
    _seedConversation(c: any) {
      const conv = { id: nextId(), ...c };
      conversations.set(conv.id, conv);
      return conv;
    },
    _seedTranscript(t: any) {
      const transcript = { id: nextId(), ...t };
      transcripts.set(transcript.conversationId, transcript);
      return transcript;
    },
    _seedSegment(s: any) {
      segments.push({ id: nextId(), ...s });
    },
    _getSegments() {
      return segments;
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
        if (include?.segments) {
          const segs = segments.filter((s) => s.transcriptId === t.id);
          return { ...t, segments: segs };
        }
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
  return {
    execute: async () => ({ aiInferenceId: 'inf-1', jobId: 'job-1', text: responseText }),
  } as any;
}

function makeService(prisma: any, aiRouter: any) {
  return new MajorPurchaseOnboardingService(prisma as any, aiRouter as any);
}

describe('MajorPurchaseOnboardingService', () => {
  it('createProject встановлює mode=MAJOR_PURCHASE (розбіжність із ТЗ, виправлена: проєкт створюється ДО онбордінгу)', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma, createFakeAiRouter('{}'));

    const project = await service.createProject('u1', 'Пошук квартири в Києві');

    expect(project.mode).toBe('MAJOR_PURCHASE');
    expect(project.ownerId).toBe('u1');
  });

  it('createProject відхиляє порожній question', async () => {
    const prisma = createFakePrisma();
    const service = makeService(prisma, createFakeAiRouter('{}'));

    await expect(service.createProject('u1', '   ')).rejects.toThrow(BadRequestException);
  });

  it('getChecklist без брифу в розмові — статичний фолбек, різний для REAL_ESTATE і VEHICLE', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma, createFakeAiRouter('{}'));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);

    const realEstate = await service.getChecklist('u1', conversation.id, 'REAL_ESTATE' as any);
    const vehicle = await service.getChecklist('u1', conversation.id, 'VEHICLE' as any);

    expect(realEstate.some((i) => i.includes('кімнат'))).toBe(true);
    expect(vehicle.some((i) => i.includes('Пробіг'))).toBe(true);
    expect(realEstate).not.toEqual(vehicle);
  });

  it('getChecklist ІЗ брифом — динамічний, повертає персоналізований список від AI, не статичний', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const personalizedItems = ['Чи є консьєрж-сервіс', 'Наявність підземного паркомісця', 'Статус будинку (клубний/масовий)'];
    const aiRouter = createFakeAiRouter(JSON.stringify(personalizedItems));
    const service = makeService(prisma, aiRouter);
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Шукаю пентхаус преміум-класу, бюджет 2 млн доларів, без обмежень по терміну');

    const checklist = await service.getChecklist('u1', conversation.id, 'REAL_ESTATE' as any);

    expect(checklist).toEqual(personalizedItems);
  });

  it('getChecklist чесно деградує до статичного фолбеку, якщо AI повернув невалідний JSON', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const aiRouter = { execute: async () => { throw new Error('invalid output, validateOutput failed'); } };
    const service = makeService(prisma, aiRouter);
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Бюджет 30000 USD');

    const checklist = await service.getChecklist('u1', conversation.id, 'VEHICLE' as any);

    expect(checklist).toEqual(getOnboardingChecklist('VEHICLE' as any));
  });

  it('getChecklist НЕ проковтує ForbiddenException (відсутня згода EXTERNAL_AI) у фолбек — це реальна проблема прав, не збій AI', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const { ForbiddenException: FE } = require('@nestjs/common');
    const aiRouter = { execute: async () => { throw new FE('Consent required: EXTERNAL_AI'); } };
    const service = makeService(prisma, aiRouter);
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Бюджет 30000 USD');

    await expect(service.getChecklist('u1', conversation.id, 'VEHICLE' as any)).rejects.toThrow(FE);
  });

  it('createOnboardingConversation створює Conversation(sourceType=TEXT_IMPORT) + Transcript + isSelf учасника, чужий проєкт — NotFoundException', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma, createFakeAiRouter('{}'));

    const { conversation, participant, transcript } = await service.createOnboardingConversation('u1', project.id);

    expect(conversation.sourceType).toBe('TEXT_IMPORT');
    expect(participant.isSelf).toBe(true);
    expect(transcript.conversationId).toBe(conversation.id);

    await expect(service.createOnboardingConversation('attacker', project.id)).rejects.toThrow(NotFoundException);
  });

  it('appendAnswer додає TranscriptSegment з наростаючим startMs, відхиляє порожній текст', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma, createFakeAiRouter('{}'));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);

    const seg1 = await service.appendAnswer('u1', conversation.id, 'Бюджет 100000 USD');
    const seg2 = await service.appendAnswer('u1', conversation.id, '2 спальні мінімум');

    expect(seg2.startMs).toBeGreaterThan(seg1.startMs);
    await expect(service.appendAnswer('u1', conversation.id, '')).rejects.toThrow(BadRequestException);
  });

  it('acceptance-тест §7 ТЗ: extract повертає чернетку з критеріями, нічого не зберігає в БД сам по собі', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const aiResponse = JSON.stringify({
      goalDescription: 'Трикімнатна квартира в центрі Києва',
      budgetMin: 80000,
      budgetMax: 120000,
      currency: 'USD',
      financingMethod: 'готівка',
      timeline: 'протягом 2 місяців',
      criteria: [
        { text: 'Не менше 2 спалень', isRequired: true },
        { text: 'Ремонт не обов\'язковий', isRequired: false },
      ],
    });
    const service = makeService(prisma, createFakeAiRouter(aiResponse));
    const { conversation } = await service.createOnboardingConversation('u1', project.id);
    await service.appendAnswer('u1', conversation.id, 'Шукаю квартиру в Києві, бюджет 80-120к');

    const draft = await service.extract('u1', conversation.id, 'REAL_ESTATE' as any);

    expect(draft.goalDescription).toBe('Трикімнатна квартира в центрі Києва');
    expect(draft.criteria.length).toBe(2);
    expect(draft.criteria[0].orderIndex).toBe(0);
    expect(draft.criteria[1].orderIndex).toBe(1);
    // нічого не мало бути збережено в MajorPurchaseConfig — ця модель
    // навіть не мокована в цьому тесті, отже якби сервіс спробував
    // писати в неї, тест впав би з помилкою відсутнього методу
  });

  it('extract на порожній розмові (без відповідей) відхиляється, не викликає AI даремно', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    let aiCalled = false;
    const aiRouter = { execute: async () => { aiCalled = true; return { text: '{}' }; } };
    const service = makeService(prisma, aiRouter);
    const { conversation } = await service.createOnboardingConversation('u1', project.id);

    await expect(service.extract('u1', conversation.id, 'REAL_ESTATE' as any)).rejects.toThrow(BadRequestException);
    expect(aiCalled).toBe(false);
  });
});

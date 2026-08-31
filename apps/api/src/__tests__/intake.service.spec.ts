// ТЗ domain-ui-and-voice-intake §2 — квиз на входе. AIRouter — фейк с
// заранее заданной классификацией, доменные онбординги — фейки,
// фиксирующие вызовы (replay проверяется по порядку ответов).
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IntakeService, decideScenario, INTAKE_CONFIDENCE_THRESHOLD, INTAKE_MAX_FOLLOW_UPS } from '../intake/intake.service';

function createFakePrisma() {
  const sessions = new Map<string, any>();
  let n = 0;
  const fake: any = {
    _sessions: sessions,
    _activePrompt: null as any,
    promptVersion: { findFirst: async function (this: any) { return fake._activePrompt; } },
    intakeSession: {
      create: async ({ data }: any) => {
        const s = { id: `s${++n}`, status: 'IN_PROGRESS', chosenScenario: null, dispatchedProjectId: null, dispatchedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        sessions.set(s.id, s);
        return s;
      },
      findFirst: async ({ where }: any) => {
        const s = sessions.get(where.id);
        return s && s.userId === where.userId ? s : null;
      },
      update: async ({ where, data }: any) => {
        const s = { ...sessions.get(where.id), ...data, updatedAt: new Date() };
        sessions.set(where.id, s);
        return s;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const s of sessions.values()) {
          if (s.status === where.status && s.updatedAt < where.updatedAt.lt) { Object.assign(s, data); count++; }
        }
        return { count };
      },
    },
  };
  return fake;
}

function fakeRouter(responses: any[]) {
  const calls: any[] = [];
  let i = 0;
  return {
    calls,
    execute: async (req: any) => {
      calls.push(req);
      const r = responses[Math.min(i++, responses.length - 1)];
      const text = JSON.stringify(r);
      if (req.validateOutput && !req.validateOutput(text)) throw new Error('validation failed');
      return { text };
    },
  };
}

function fakeOnboarding(name: string) {
  const log: string[] = [];
  return {
    log,
    createProject: async (_u: string, question: string, extra?: any) => { log.push(`createProject:${question}${extra ? ':' + extra : ''}`); return { id: `${name}-p1` }; },
    createOnboardingConversation: async () => { log.push('createOnboarding'); return { conversation: { id: `${name}-c1` } }; },
    appendAnswer: async (_u: string, _c: string, text: string) => { log.push(`append:${text}`); return { id: 'seg', text }; },
  };
}

const cls = (scenario: string, confidence: number, followUpQuestion: string | null = null, extra: any = {}) => ({
  scenario, confidence, followUpQuestion,
  extracted: { question: 'Меня подрезали и уехали', goal: null, facts: ['вчера', 'царапина на крыле'], contractType: null, ...extra },
});

function makeService(router: any, prisma = createFakePrisma()) {
  const domains = { dtp: fakeOnboarding('dtp'), familyLaw: fakeOnboarding('fl'), health: fakeOnboarding('health'), interviewPool: fakeOnboarding('ip'), investment: fakeOnboarding('inv'), majorPurchase: fakeOnboarding('mp') };
  const projects = { created: [] as any[], create: async (_u: string, input: any) => { projects.created.push(input); return { id: 'universal-p1' }; } };
  const svc = new IntakeService(prisma as any, router as any, projects as any, domains.dtp as any, domains.familyLaw as any, domains.health as any, domains.interviewPool as any, domains.investment as any, domains.majorPurchase as any);
  return { svc, domains, projects, prisma };
}

describe('IntakeService (ТЗ §2)', () => {
  it('порог 0.6: 0.59 → UNIVERSAL, ровно 0.60 → домен (граница включительно)', () => {
    expect(decideScenario('dtp', 0.59)).toBe('UNIVERSAL');
    expect(decideScenario('dtp', INTAKE_CONFIDENCE_THRESHOLD)).toBe('dtp');
    expect(decideScenario('dtp', 0.95)).toBe('dtp');
  });

  it('start(): уверенная классификация без уточнений → сразу decision, nextQuestion=null', async () => {
    const { svc } = makeService(fakeRouter([cls('dtp', 0.9)]));
    const res = await svc.start('u1', 'Меня подрезали и уехали');
    expect(res.nextQuestion).toBeNull();
    expect(res.decision).toEqual({ scenario: 'dtp', suggestedScenario: 'dtp', confidence: 0.9, belowThreshold: false });
    expect(res.answers).toHaveLength(1);
  });

  it('ниже порога → decision.scenario=UNIVERSAL, но suggestedScenario сохраняется (калибровочный сигнал)', async () => {
    const { svc } = makeService(fakeRouter([cls('health', 0.4)]));
    const res = await svc.start('u1', 'что-то с врачом');
    expect(res.decision?.scenario).toBe('UNIVERSAL');
    expect(res.decision?.suggestedScenario).toBe('health');
    expect(res.decision?.belowThreshold).toBe(true);
  });

  it('уточняющий вопрос отдаётся как nextQuestion, decision при этом null; ответ записывается вместе с вопросом', async () => {
    const { svc } = makeService(fakeRouter([cls('dtp', 0.5, 'Была ли полиция?'), cls('dtp', 0.85)]));
    const first = await svc.start('u1', 'авария');
    expect(first.nextQuestion).toBe('Была ли полиция?');
    expect(first.decision).toBeNull();
    const second = await svc.answer('u1', first.id, 'да, оформили');
    expect(second.answers[1]).toMatchObject({ question: 'Была ли полиция?', text: 'да, оформили' });
    expect(second.decision?.scenario).toBe('dtp');
  });

  it(`жёсткий потолок: после ${INTAKE_MAX_FOLLOW_UPS} уточнений decision обязателен, даже если AI хочет спросить ещё`, async () => {
    const always = cls('investment', 0.5, 'ещё вопрос?');
    const { svc } = makeService(fakeRouter([always]));
    let s = await svc.start('u1', 'вложить деньги');
    for (let i = 0; i < INTAKE_MAX_FOLLOW_UPS; i++) {
      expect(s.nextQuestion).toBe('ещё вопрос?');
      s = await svc.answer('u1', s.id, `ответ ${i}`);
    }
    expect(s.followUpsAsked).toBe(INTAKE_MAX_FOLLOW_UPS);
    expect(s.nextQuestion).toBeNull();
    expect(s.decision).not.toBeNull();
    expect(s.decision?.scenario).toBe('UNIVERSAL'); // 0.5 < порога
  });

  it('dispatch в домен: createProject(question из extracted) → onboarding → replay ВСЕХ ответов в исходном порядке', async () => {
    const { svc, domains } = makeService(fakeRouter([cls('dtp', 0.5, 'Когда?'), cls('dtp', 0.9)]));
    const s1 = await svc.start('u1', 'подрезали');
    await svc.answer('u1', s1.id, 'вчера вечером');
    const res = await svc.dispatch('u1', s1.id, 'dtp');
    expect(domains.dtp.log).toEqual(['createProject:Меня подрезали и уехали', 'createOnboarding', 'append:подрезали', 'append:вчера вечером']);
    expect(res.projectId).toBe('dtp-p1');
    expect(res.conversationId).toBe('dtp-c1');
    expect(res.status).toBe('DISPATCHED');
    expect(res.chosenScenario).toBe('dtp');
  });

  it('пользователь может выбрать НЕ предложенный сценарий — chosen ≠ suggested сохраняются оба', async () => {
    const { svc, domains, prisma } = makeService(fakeRouter([cls('dtp', 0.9)]));
    const s = await svc.start('u1', 'x');
    await svc.dispatch('u1', s.id, 'major-purchase');
    const stored = prisma._sessions.get(s.id);
    expect(stored.suggestedScenario).toBe('dtp');
    expect(stored.chosenScenario).toBe('major-purchase');
    expect(domains.majorPurchase.log[0]).toMatch(/^createProject/);
    expect(domains.dtp.log).toHaveLength(0);
  });

  it('dispatch UNIVERSAL: ProjectsService.create с question и goal из фактов; доменные онбординги не трогаются', async () => {
    const { svc, projects, domains } = makeService(fakeRouter([cls('health', 0.3)]));
    const s = await svc.start('u1', 'спор с врачом');
    const res = await svc.dispatch('u1', s.id, 'UNIVERSAL');
    expect(projects.created[0]).toEqual({ question: 'Меня подрезали и уехали', goal: 'Контекст из квиза: вчера; царапина на крыле' });
    expect(res.projectId).toBe('universal-p1');
    expect(res.conversationId).toBeNull();
    expect(Object.values(domains).every((d) => d.log.length === 0)).toBe(true);
  });

  it('family-law без contractType — BadRequest; с contractType из dispatch — передаётся в createProject', async () => {
    const { svc, domains } = makeService(fakeRouter([cls('family-law', 0.9)]));
    const s = await svc.start('u1', 'развод');
    await expect(svc.dispatch('u1', s.id, 'family-law')).rejects.toThrow(BadRequestException);
    await svc.dispatch('u1', s.id, 'family-law', { contractType: 'DIVORCE_SETTLEMENT' });
    expect(domains.familyLaw.log[0]).toBe('createProject:Меня подрезали и уехали:DIVORCE_SETTLEMENT');
  });

  it('family-law: contractType, извлечённый AI, используется без явного указания', async () => {
    const { svc, domains } = makeService(fakeRouter([cls('family-law', 0.9, null, { contractType: 'PRENUP' })]));
    const s = await svc.start('u1', 'брачный договор');
    await svc.dispatch('u1', s.id, 'family-law');
    expect(domains.familyLaw.log[0]).toMatch(/:PRENUP$/);
  });

  it('повторный dispatch — BadRequest; чужая сессия — NotFound', async () => {
    const { svc } = makeService(fakeRouter([cls('dtp', 0.9)]));
    const s = await svc.start('u1', 'x');
    await svc.dispatch('u1', s.id, 'dtp');
    await expect(svc.dispatch('u1', s.id, 'dtp')).rejects.toThrow(BadRequestException);
    await expect(svc.get('attacker', s.id)).rejects.toThrow(NotFoundException);
  });

  it('abandonStale(): IN_PROGRESS старше 24 ч → ABANDONED, свежие и DISPATCHED не трогаются', async () => {
    const prisma = createFakePrisma();
    const { svc } = makeService(fakeRouter([cls('dtp', 0.9)]), prisma);
    const old = await svc.start('u1', 'a');
    const fresh = await svc.start('u1', 'b');
    const done = await svc.start('u1', 'c');
    await svc.dispatch('u1', done.id, 'dtp');
    prisma._sessions.get(old.id).updatedAt = new Date(Date.now() - 25 * 3600 * 1000);
    prisma._sessions.get(done.id).updatedAt = new Date(Date.now() - 25 * 3600 * 1000);
    const res = await svc.abandonStale();
    expect(res.abandoned).toBe(1);
    expect(prisma._sessions.get(old.id).status).toBe('ABANDONED');
    expect(prisma._sessions.get(fresh.id).status).toBe('IN_PROGRESS');
    expect(prisma._sessions.get(done.id).status).toBe('DISPATCHED');
  });

  it('ACTIVE-версия промпта в реестре переопределяет константу и уходит в телеметрию как promptVersionId', async () => {
    const prisma = createFakePrisma();
    prisma._activePrompt = { id: 'pv1', template: 'КАСТОМНЫЙ ПРОМПТ' };
    const router = fakeRouter([cls('dtp', 0.9)]);
    const { svc } = makeService(router, prisma);
    await svc.start('u1', 'x');
    expect(router.calls[0].systemPrompt).toBe('КАСТОМНЫЙ ПРОМПТ');
    expect(router.calls[0].promptVersionId).toBe('pv1');
  });

  it('без ACTIVE-версии — дефолтный промпт, promptVersionId undefined', async () => {
    const router = fakeRouter([cls('dtp', 0.9)]);
    const { svc } = makeService(router);
    await svc.start('u1', 'x');
    expect(router.calls[0].systemPrompt).toContain('«Адвокат дьявола»');
    expect(router.calls[0].promptVersionId).toBeUndefined();
  });

  it('AI вернул невалидный JSON — BadGateway с подсказкой про универсальный сценарий, сессия не создаётся', async () => {
    const { svc, prisma } = makeService(fakeRouter([{ scenario: 'nope' }]));
    await expect(svc.start('u1', 'x')).rejects.toThrow(/универсальном/);
    expect(prisma._sessions.size).toBe(0);
  });
});

import { InterviewPoolRelevanceService } from '../interview-pool/interview-pool-relevance.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const configs = new Map<string, any>();
  const questions: any[] = [];
  const statuses: any[] = [];
  const candidates = new Map<string, any>();
  const stageProgress: any[] = [];
  const segments: any[] = [];
  const snapshots: any[] = [];
  const entries: any[] = [];
  const followUpRequests: any[] = [];
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
    _seedQuestion(q: any) {
      const question = { id: nextId(), ...q };
      questions.push(question);
      return question;
    },
    _seedCandidate(c: any) {
      const candidate = { id: nextId(), ...c };
      candidates.set(candidate.id, candidate);
      return candidate;
    },
    _seedStatus(s: any) {
      const status = { id: nextId(), stage: 'SCHEDULED', ...s };
      statuses.push(status);
      return status;
    },
    _seedStageProgress(p: any) {
      stageProgress.push({ id: nextId(), ...p });
    },
    _seedSegment(s: any) {
      segments.push({ id: nextId(), ...s });
    },
    _getFollowUpRequests() {
      return followUpRequests;
    },
    _getStatuses() {
      return statuses;
    },

    project: {
      findUnique: async ({ where }: any) => projects.get(where.id) ?? null,
    },
    recruitingTeamMember: { findUnique: async () => null },
    interviewPoolConfig: {
      findUnique: async ({ where, include }: any) => {
        const config = [...configs.values()].find((c) => c.projectId === where.projectId);
        if (!config) return null;
        if (include?.questions) return { ...config, questions: questions.filter((q) => q.configId === config.id) };
        return config;
      },
    },
    candidatePipelineStatus: {
      findMany: async ({ where, include }: any) => {
        const rows = statuses.filter((s) => s.projectId === where.projectId);
        return rows.map((s) => ({
          ...s,
          candidateProfile: include?.candidateProfile ? candidates.get(s.candidateProfileId) : undefined,
          stageProgress: include?.stageProgress
            ? stageProgress.filter((p) => p.statusId === s.id && p.conversationId != null && p.completedAt != null)
            : [],
        }));
      },
      update: async ({ where, data }: any) => {
        const s = statuses.find((st) => st.id === where.id);
        Object.assign(s, data);
        return s;
      },
    },
    transcriptSegment: {
      findMany: async ({ where }: any) => {
        const convIds: string[] = where.transcript.conversationId.in;
        return segments.filter((s) => convIds.includes(s.conversationId));
      },
    },
    poolRelevanceSnapshot: {
      create: async ({ data }: any) => {
        const snap = { id: nextId(), createdAt: new Date(), ...data };
        snapshots.push(snap);
        return snap;
      },
      findFirst: async ({ where }: any) => {
        const rows = snapshots.filter((s) => s.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt);
        const snap = rows[0];
        if (!snap) return null;
        return { ...snap, entries: entries.filter((e) => e.snapshotId === snap.id).map((e) => ({ ...e, candidateProfile: candidates.get(e.candidateProfileId) })) };
      },
      findUnique: async ({ where }: any) => {
        const snap = snapshots.find((s) => s.id === where.id);
        if (!snap) return null;
        return { ...snap, entries: entries.filter((e) => e.snapshotId === snap.id).map((e) => ({ ...e, candidateProfile: candidates.get(e.candidateProfileId) })) };
      },
      findMany: async ({ where }: any) =>
        snapshots
          .filter((s) => s.projectId === where.projectId)
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((s) => ({ ...s, entries: entries.filter((e) => e.snapshotId === s.id) })),
    },
    poolRelevanceEntry: {
      create: async ({ data }: any) => {
        const entry = { id: nextId(), ...data };
        entries.push(entry);
        return entry;
      },
    },
    candidateFollowUpRequest: {
      createMany: async ({ data }: any) => {
        data.forEach((d: any) => followUpRequests.push({ id: nextId(), fulfilled: false, ...d }));
      },
    },
  };
}

function makeService(prisma: any, aiRouter: any) {
  return new InterviewPoolRelevanceService(prisma as any, aiRouter as any);
}

describe('InterviewPoolRelevanceService', () => {
  it('acceptance-тест §7 ТЗ: НАЙВАЖЛИВІШИЙ ТЕСТ — genderRequirement/ageRequirement/isPhysicallyDemanding НІКОЛИ не потрапляють у промпт AI-виклику', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({
      projectId: project.id,
      jobTitle: 'Backend Engineer',
      genderRequirement: 'FEMALE',
      ageRequirement: 'RANGE',
      minAge: 25,
      maxAge: 35,
      isPhysicallyDemanding: false,
    });
    const q1 = prisma._seedQuestion({ configId: config.id, text: 'Досвід з Node.js?', isRequired: true, orderIndex: 0 });
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    const status = prisma._seedStatus({ projectId: project.id, candidateProfileId: candidate.id });
    prisma._seedStageProgress({ statusId: status.id, conversationId: 'conv-1', completedAt: new Date() });
    prisma._seedSegment({ id: 'seg-1', conversationId: 'conv-1', text: 'Так, 5 років з Node.js' });

    let capturedPrompt = '';
    let capturedSystemPrompt = '';
    const aiRouter = {
      execute: async (req: any) => {
        capturedPrompt = req.userPrompt;
        capturedSystemPrompt = req.systemPrompt;
        return {
          text: JSON.stringify({
            criteriaBreakdown: [{ questionnaireItemId: q1.id, coverage: 'covered', note: 'Підтверджено', sourceSegmentId: 'seg-1' }],
            attentionPoints: [],
            followUpRequests: [],
          }),
        };
      },
    };
    const service = makeService(prisma, aiRouter);

    await service.regenerate('u1', project.id);

    expect(capturedPrompt).not.toContain('FEMALE');
    expect(capturedPrompt.toLowerCase()).not.toContain('gender');
    expect(capturedPrompt).not.toContain('25');
    expect(capturedPrompt).not.toContain('35');
    // Заборона на дискримінацію — явна інструкція в самому системному промпті
    expect(capturedSystemPrompt.toLowerCase()).toContain('стать');
    expect(capturedSystemPrompt.toLowerCase()).toContain('вік');
    expect(capturedSystemPrompt.toLowerCase()).toContain('рас');
  });

  it('acceptance-тест §7 ТЗ: followUpRequests непорожній → CandidatePipelineStatus.stage автоматично AWAITING_FOLLOWUP, ЖОДНЕ інше значення system не встановлює сам', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, jobTitle: 'Backend Engineer' });
    prisma._seedQuestion({ configId: config.id, text: 'Q1', isRequired: true, orderIndex: 0 });
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    const status = prisma._seedStatus({ projectId: project.id, candidateProfileId: candidate.id, stage: 'SCHEDULED' });
    prisma._seedStageProgress({ statusId: status.id, conversationId: 'conv-1', completedAt: new Date() });
    prisma._seedSegment({ id: 'seg-1', conversationId: 'conv-1', text: 'Відповідь кандидата' });

    const aiRouter = {
      execute: async () => ({
        text: JSON.stringify({
          criteriaBreakdown: [],
          attentionPoints: ['Потребує перевірки досвіду з Kubernetes'],
          followUpRequests: ['Надати приклад конфігурації Kubernetes'],
        }),
      }),
    };
    const service = makeService(prisma, aiRouter);

    await service.regenerate('u1', project.id);

    const updatedStatus = prisma._getStatuses().find((s: any) => s.id === status.id);
    expect(updatedStatus.stage).toBe('AWAITING_FOLLOWUP');
    expect(prisma._getFollowUpRequests().length).toBe(1);
  });

  it('followUpRequests порожній → stage НЕ змінюється автоматично', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, jobTitle: 'Backend Engineer' });
    prisma._seedQuestion({ configId: config.id, text: 'Q1', isRequired: true, orderIndex: 0 });
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    const status = prisma._seedStatus({ projectId: project.id, candidateProfileId: candidate.id, stage: 'SCHEDULED' });
    prisma._seedStageProgress({ statusId: status.id, conversationId: 'conv-1', completedAt: new Date() });
    prisma._seedSegment({ id: 'seg-1', conversationId: 'conv-1', text: 'Відповідь' });

    const aiRouter = { execute: async () => ({ text: JSON.stringify({ criteriaBreakdown: [], attentionPoints: [], followUpRequests: [] }) }) };
    const service = makeService(prisma, aiRouter);

    await service.regenerate('u1', project.id);

    const updatedStatus = prisma._getStatuses().find((s: any) => s.id === status.id);
    expect(updatedStatus.stage).toBe('SCHEDULED');
  });

  it('чесна деградація: збій AI на одному кандидаті НЕ провалює весь знімок пулу', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, jobTitle: 'Backend Engineer' });
    prisma._seedQuestion({ configId: config.id, text: 'Q1', isRequired: true, orderIndex: 0 });
    const candidateA = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'A' });
    const candidateB = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'B' });
    const statusA = prisma._seedStatus({ projectId: project.id, candidateProfileId: candidateA.id });
    const statusB = prisma._seedStatus({ projectId: project.id, candidateProfileId: candidateB.id });
    prisma._seedStageProgress({ statusId: statusA.id, conversationId: 'conv-a', completedAt: new Date() });
    prisma._seedStageProgress({ statusId: statusB.id, conversationId: 'conv-b', completedAt: new Date() });
    prisma._seedSegment({ id: 'seg-a', conversationId: 'conv-a', text: 'Відповідь A' });
    prisma._seedSegment({ id: 'seg-b', conversationId: 'conv-b', text: 'Відповідь B' });

    let callCount = 0;
    const aiRouter = {
      execute: async () => {
        callCount++;
        if (callCount === 1) throw new Error('AI provider timeout');
        return { text: JSON.stringify({ criteriaBreakdown: [], attentionPoints: [], followUpRequests: [] }) };
      },
    };
    const service = makeService(prisma, aiRouter);

    const snapshot = await service.regenerate('u1', project.id);

    // Один кандидат провалився (не потрапив у знімок), інший — успішно
    expect(snapshot!.entries.length).toBe(1);
  });

  it('кандидат без жодної завершеної співбесіди (немає conversationId у stageProgress) пропускається, не викликає AI даремно', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, jobTitle: 'Backend Engineer' });
    prisma._seedQuestion({ configId: config.id, text: 'Q1', isRequired: true, orderIndex: 0 });
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    prisma._seedStatus({ projectId: project.id, candidateProfileId: candidate.id });
    // жодного CandidateStageProgress не заведено

    let aiCalled = false;
    const aiRouter = { execute: async () => { aiCalled = true; return { text: '{}' }; } };
    const service = makeService(prisma, aiRouter);

    await service.regenerate('u1', project.id);

    expect(aiCalled).toBe(false);
  });

  it('регресійний тест (аудит): співбесіда ПРИВ\'ЯЗАНА (conversationId є), але ще НЕ ЗАВЕРШЕНА (completedAt=null) — НЕ включається в оцінку, §4.3 ТЗ буквально "завершеної"', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, jobTitle: 'Backend Engineer' });
    prisma._seedQuestion({ configId: config.id, text: 'Q1', isRequired: true, orderIndex: 0 });
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    const status = prisma._seedStatus({ projectId: project.id, candidateProfileId: candidate.id });
    prisma._seedStageProgress({ statusId: status.id, conversationId: 'conv-1', completedAt: null });
    prisma._seedSegment({ id: 'seg-1', conversationId: 'conv-1', text: 'Часткова відповідь' });

    let aiCalled = false;
    const aiRouter = { execute: async () => { aiCalled = true; return { text: '{}' }; } };
    const service = makeService(prisma, aiRouter);

    await service.regenerate('u1', project.id);

    expect(aiCalled).toBe(false);
  });

  it('PoolRelevanceSnapshot — новий запис при повторній генерації, стара історія лишається доступною', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, jobTitle: 'Backend Engineer' });
    prisma._seedQuestion({ configId: config.id, text: 'Q1', isRequired: true, orderIndex: 0 });
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    const status = prisma._seedStatus({ projectId: project.id, candidateProfileId: candidate.id });
    prisma._seedStageProgress({ statusId: status.id, conversationId: 'conv-1', completedAt: new Date() });
    prisma._seedSegment({ id: 'seg-1', conversationId: 'conv-1', text: 'Відповідь' });

    const aiRouter = { execute: async () => ({ text: JSON.stringify({ criteriaBreakdown: [], attentionPoints: [], followUpRequests: [] }) }) };
    const service = makeService(prisma, aiRouter);

    await service.regenerate('u1', project.id);
    await service.regenerate('u1', project.id);

    const history = await service.getHistory('u1', project.id);
    expect(history.length).toBe(2);
  });
});

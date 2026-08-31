import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InterviewPoolService } from '../interview-pool/interview-pool.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const configs = new Map<string, any>();
  const stages: any[] = [];
  const complianceFlags: any[] = [];
  const questions: any[] = [];
  const candidates = new Map<string, any>();
  const statuses: any[] = [];
  const teamMembers: any[] = [];
  const stageProgress: any[] = [];
  const conversations = new Map<string, any>();
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
    _seedConfig(c: any) {
      const config = { id: nextId(), ...c };
      configs.set(config.id, config);
      return config;
    },
    _seedCandidate(c: any) {
      const candidate = { id: nextId(), ...c };
      candidates.set(candidate.id, candidate);
      return candidate;
    },
    _seedStatus(s: any) {
      const status = { id: nextId(), createdAt: new Date(), reuseHistory: false, ...s };
      statuses.push(status);
      return status;
    },
    _seedTeamMembership(m: any) {
      teamMembers.push(m);
    },
    _seedConversation(c: any) {
      const conv = { id: nextId(), ...c };
      conversations.set(conv.id, conv);
      return conv;
    },
    _seedTranscriptWithSegments(conversationId: string, texts: string[]) {
      const transcript = { id: nextId(), conversationId };
      transcripts.set(transcript.id, transcript);
      texts.forEach((text, i) => segments.push({ id: nextId(), transcriptId: transcript.id, text, startMs: i }));
      return transcript;
    },
    _seedStageProgress(p: any) {
      const progress = { id: nextId(), ...p };
      stageProgress.push(progress);
      return progress;
    },
    _getComplianceFlags() {
      return complianceFlags;
    },
    _getStageProgress() {
      return stageProgress;
    },

    project: {
      findUnique: async ({ where }: any) => projects.get(where.id) ?? null,
    },
    recruitingTeamMember: {
      findUnique: async ({ where }: any) =>
        teamMembers.find((m) => m.teamId === where.teamId_userId.teamId && m.userId === where.teamId_userId.userId) ?? null,
    },
    interviewPoolConfig: {
      findUnique: async ({ where, include }: any) => {
        let config = where.id ? configs.get(where.id) : [...configs.values()].find((c) => c.projectId === where.projectId);
        if (!config) return null;
        if (include?.interviewStages) {
          config = { ...config, interviewStages: stages.filter((s) => s.configId === config.id) };
        }
        if (include?.questions) {
          config = { ...config, questions: questions.filter((q) => q.configId === config.id) };
        }
        return config;
      },
      create: async ({ data, include }: any) => {
        const { interviewStages, complianceFlags: cfInput, ...rest } = data;
        const config = { id: nextId(), ...rest };
        configs.set(config.id, config);
        const createdStages = (interviewStages?.create ?? []).map((s: any) => ({ id: nextId(), configId: config.id, ...s }));
        createdStages.forEach((s: any) => stages.push(s));
        const createdFlags = (cfInput?.create ?? []).map((c: any) => ({ id: nextId(), configId: config.id, ...c }));
        createdFlags.forEach((c: any) => complianceFlags.push(c));
        return { ...config, ...(include?.interviewStages ? { interviewStages: createdStages } : {}), ...(include?.complianceFlags ? { complianceFlags: createdFlags } : {}) };
      },
    },
    interviewStageDefinition: {
      findUnique: async ({ where, include }: any) => {
        const stage = stages.find((s) => s.id === where.id);
        if (!stage) return null;
        if (include?.config) return { ...stage, config: configs.get(stage.configId) };
        return stage;
      },
    },
    complianceFlag: {
      findMany: async ({ where }: any) => complianceFlags.filter((c) => c.configId === where.configId),
    },
    questionnaireItem: {
      deleteMany: async ({ where }: any) => {
        for (let i = questions.length - 1; i >= 0; i--) {
          if (questions[i].configId === where.configId) questions.splice(i, 1);
        }
      },
      createMany: async ({ data }: any) => {
        data.forEach((d: any) => questions.push({ id: nextId(), ...d }));
      },
      findMany: async ({ where }: any) => questions.filter((q) => q.configId === where.configId).sort((a, b) => a.orderIndex - b.orderIndex),
    },
    candidateProfile: {
      findUnique: async ({ where }: any) => candidates.get(where.id) ?? null,
    },
    candidatePipelineStatus: {
      findUnique: async ({ where }: any) => {
        if (where.id) return statuses.find((s) => s.id === where.id) ?? null;
        const key = where.projectId_candidateProfileId;
        return statuses.find((s) => s.projectId === key.projectId && s.candidateProfileId === key.candidateProfileId) ?? null;
      },
      findMany: async ({ where, include }: any) => {
        let rows = statuses;
        if (where?.candidateProfileId) rows = rows.filter((s) => s.candidateProfileId === where.candidateProfileId);
        if (where?.projectId?.not) rows = rows.filter((s) => s.projectId !== where.projectId.not);
        else if (where?.projectId) rows = rows.filter((s) => s.projectId === where.projectId);
        if (include?.project) {
          rows = rows.map((s) => ({
            ...s,
            project: include.project.include?.interviewPoolConfig
              ? { ...projects.get(s.projectId), interviewPoolConfig: [...configs.values()].find((c) => c.projectId === s.projectId) ?? null }
              : projects.get(s.projectId),
          }));
        }
        if (include?.candidateProfile) rows = rows.map((s) => ({ ...s, candidateProfile: candidates.get(s.candidateProfileId) }));
        return rows;
      },
      create: async ({ data }: any) => {
        const status = { id: nextId(), createdAt: new Date(), ...data };
        statuses.push(status);
        return status;
      },
    },
    candidateStageProgress: {
      findMany: async ({ where, select }: any) => {
        let rows = stageProgress;
        if (where?.status?.candidateProfileId) {
          rows = rows.filter((p) => {
            const st = statuses.find((s) => s.id === p.statusId);
            if (!st || st.candidateProfileId !== where.status.candidateProfileId) return false;
            if (where.status.projectId?.not && st.projectId === where.status.projectId.not) return false;
            return true;
          });
        }
        if (where?.conversationId?.not === null) rows = rows.filter((p) => p.conversationId != null);
        if (where?.completedAt?.not === null) rows = rows.filter((p) => p.completedAt != null);
        return select ? rows.map((p) => ({ conversationId: p.conversationId })) : rows;
      },
      upsert: async ({ where, create, update }: any) => {
        const key = where.statusId_stageDefinitionId;
        const existing = stageProgress.find((p) => p.statusId === key.statusId && p.stageDefinitionId === key.stageDefinitionId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const progress = { id: nextId(), ...create };
        stageProgress.push(progress);
        return progress;
      },
    },
    conversation: {
      findUnique: async ({ where }: any) => conversations.get(where.id) ?? null,
    },
    transcriptSegment: {
      findMany: async ({ where, orderBy }: any) => {
        const convIds: string[] = where.transcript.conversationId.in;
        const transcriptIds = [...transcripts.values()].filter((t) => convIds.includes(t.conversationId)).map((t) => t.id);
        let rows = segments.filter((s) => transcriptIds.includes(s.transcriptId));
        if (orderBy?.startMs) rows = rows.sort((a, b) => a.startMs - b.startMs);
        return rows;
      },
    },
  };
  client.$transaction = async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(client));
  return client;
}

function makeService(prisma: any, aiRouter: any = { execute: async () => ({ text: '[]' }) }) {
  return new InterviewPoolService(prisma as any, aiRouter as any);
}

const MINIMAL_DRAFT = {
  jobTitle: 'Backend Engineer',
  extendedDescription: 'Node.js, TypeScript',
  salaryRange: null,
  employmentLoad: null,
  workArrangement: null,
  officeLocation: null,
  employmentFormat: null,
  perks: [],
  genderRequirement: 'NOT_IMPORTANT' as const,
  ageRequirement: 'NOT_IMPORTANT' as const,
  minAge: null,
  maxAge: null,
  isPhysicallyDemanding: false,
  interviewStages: [{ name: 'Технічне інтерв\'ю', orderIndex: 0, isTestAssignment: false, interviewerRole: null }],
  complianceFlags: [],
};

describe('InterviewPoolService', () => {
  it('createConfig фіксує чернетку разом зі stages/complianceFlags, відхиляє повторне створення', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma);

    const config = await service.createConfig('u1', project.id, {
      ...MINIMAL_DRAFT,
      complianceFlags: [{ category: 'race', quotedText: 'тест' }],
    });

    expect(config.interviewStages.length).toBe(1);
    expect(config.complianceFlags.length).toBe(1);

    await expect(service.createConfig('u1', project.id, MINIMAL_DRAFT)).rejects.toThrow(BadRequestException);
  });

  it('getComplianceFlags доступний тільки власнику/команді, ComplianceFlag зберігається окремо', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    await new InterviewPoolService(prisma as any, { execute: async () => ({ text: '[]' }) } as any).createConfig('u1', project.id, {
      ...MINIMAL_DRAFT,
      complianceFlags: [{ category: 'pregnancy', quotedText: 'цитата' }],
    });
    const service = makeService(prisma);

    const flags = await service.getComplianceFlags('u1', project.id);
    expect(flags.length).toBe(1);

    await expect(service.getComplianceFlags('attacker', project.id)).rejects.toThrow(NotFoundException);
  });

  it('регресійний тест: fixQuestionnaire виконується атомарно через $transaction (аудит)', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma);
    await service.createConfig('u1', project.id, MINIMAL_DRAFT);

    await service.fixQuestionnaire('u1', project.id, [{ text: 'Q1', category: null, orderIndex: 0, isRequired: true }]);
    const secondFix = await service.fixQuestionnaire('u1', project.id, [
      { text: 'Q2', category: null, orderIndex: 0, isRequired: true },
      { text: 'Q3', category: null, orderIndex: 1, isRequired: false },
    ]);

    expect(secondFix.length).toBe(2);
    expect(secondFix.map((q: any) => q.text)).toEqual(['Q2', 'Q3']);
  });

  it('acceptance-тест §7 ТЗ: reuseHistory=true з іншою jobTitle попереднього пулу — historyDisclaimer заповнений точним текстом', async () => {
    const prisma = createFakePrisma();
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Іван' });
    const oldProject = prisma._seedProject({ ownerId: 'u1' });
    const newProject = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma);
    await service.createConfig('u1', oldProject.id, { ...MINIMAL_DRAFT, jobTitle: 'Junior Developer' });
    await service.createConfig('u1', newProject.id, { ...MINIMAL_DRAFT, jobTitle: 'Senior Developer' });
    prisma._seedStatus({ projectId: oldProject.id, candidateProfileId: candidate.id });

    const result = await service.addCandidate('u1', newProject.id, candidate.id, true);

    expect(result.historyDisclaimer).toContain('Junior Developer');
  });

  it('регресійний тест (аудит): addCandidate ФАКТИЧНО зберігає reuseHistory на статусі, не тільки повертає транзитно', async () => {
    const prisma = createFakePrisma();
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Іван' });
    const project = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma);
    await service.createConfig('u1', project.id, MINIMAL_DRAFT);

    await service.addCandidate('u1', project.id, candidate.id, true);

    const stored = await prisma.candidatePipelineStatus.findUnique({
      where: { projectId_candidateProfileId: { projectId: project.id, candidateProfileId: candidate.id } },
    });
    expect(stored.reuseHistory).toBe(true);
  });

  it('reuseHistory=false — historyDisclaimer відсутній, навіть якщо є попередня історія з іншою вакансією', async () => {
    const prisma = createFakePrisma();
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Іван' });
    const oldProject = prisma._seedProject({ ownerId: 'u1' });
    const newProject = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma);
    await service.createConfig('u1', oldProject.id, { ...MINIMAL_DRAFT, jobTitle: 'Junior Developer' });
    await service.createConfig('u1', newProject.id, { ...MINIMAL_DRAFT, jobTitle: 'Senior Developer' });
    prisma._seedStatus({ projectId: oldProject.id, candidateProfileId: candidate.id });

    const result = await service.addCandidate('u1', newProject.id, candidate.id, false);

    expect(result.historyDisclaimer).toBeUndefined();
  });

  it('addCandidate відхиляє повторне додавання того самого кандидата в той самий пул', async () => {
    const prisma = createFakePrisma();
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Іван' });
    const project = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma);
    await service.createConfig('u1', project.id, MINIMAL_DRAFT);
    await service.addCandidate('u1', project.id, candidate.id, false);

    await expect(service.addCandidate('u1', project.id, candidate.id, false)).rejects.toThrow(BadRequestException);
  });

  it('член команди має доступ до пулу командного проєкту (§4.5 ТЗ)', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner', recruitingTeamId: 'team-1' });
    prisma._seedTeamMembership({ teamId: 'team-1', userId: 'colleague' });
    const service = makeService(prisma);
    await service.createConfig('owner', project.id, MINIMAL_DRAFT);

    await expect(service.getConfig('colleague', project.id)).resolves.toBeDefined();
  });

  it('чужий/не-командний користувач не має доступу до пулу', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'owner', recruitingTeamId: 'team-1' });
    const service = makeService(prisma);
    await service.createConfig('owner', project.id, MINIMAL_DRAFT);

    await expect(service.getConfig('stranger', project.id)).rejects.toThrow(NotFoundException);
  });

  it('getAgenda: reuseHistory=false (дефолт) — повертає ВСІ питання, без спроби фільтрації', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    const service = makeService(prisma);
    await service.createConfig('u1', project.id, MINIMAL_DRAFT);
    await service.fixQuestionnaire('u1', project.id, [
      { text: 'Q1', category: null, orderIndex: 0, isRequired: true },
      { text: 'Q2', category: null, orderIndex: 1, isRequired: true },
    ]);
    await service.addCandidate('u1', project.id, candidate.id, false);

    const agenda = await service.getAgenda('u1', project.id, candidate.id);

    expect(agenda.length).toBe(2);
  });

  it('регресійний тест (НАЙВАЖЛИВІШИЙ, аудит): reuseHistory=true з реальною попередньою завершеною співбесідою — питання, покриті AI-класифікацією, ВИКЛЮЧАЮТЬСЯ з agenda', async () => {
    const prisma = createFakePrisma();
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    const oldProject = prisma._seedProject({ ownerId: 'u1' });
    const newProject = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma);
    await service.createConfig('u1', oldProject.id, { ...MINIMAL_DRAFT, jobTitle: 'Junior Dev' });
    await service.createConfig('u1', newProject.id, { ...MINIMAL_DRAFT, jobTitle: 'Senior Dev' });
    const items = await service.fixQuestionnaire('u1', newProject.id, [
      { text: 'Досвід з Node.js?', category: null, orderIndex: 0, isRequired: true },
      { text: 'Чому хочете змінити роботу?', category: null, orderIndex: 1, isRequired: true },
    ]);
    const covered = items[0];

    const oldConv = prisma._seedConversation({});
    prisma._seedTranscriptWithSegments(oldConv.id, ['Так, у мене 5 років досвіду з Node.js']);
    const oldStatus = prisma._seedStatus({ projectId: oldProject.id, candidateProfileId: candidate.id });
    prisma._seedStageProgress({
      statusId: oldStatus.id,
      stageDefinitionId: 'stage-x',
      conversationId: oldConv.id,
      completedAt: new Date(),
    });

    await service.addCandidate('u1', newProject.id, candidate.id, true);

    const aiRouter = { execute: async () => ({ text: JSON.stringify([covered.id]) }) };
    const service2 = new InterviewPoolService(prisma as any, aiRouter as any);

    const agenda = await service2.getAgenda('u1', newProject.id, candidate.id);

    expect(agenda.length).toBe(1);
    expect(agenda[0].text).toBe('Чому хочете змінити роботу?');
  });

  it('getAgenda: reuseHistory=true, але попередньої ЗАВЕРШЕНОЇ співбесіди немає — чесна деградація до повного списку, AI не викликається', async () => {
    const prisma = createFakePrisma();
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    const oldProject = prisma._seedProject({ ownerId: 'u1' });
    const newProject = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma);
    await service.createConfig('u1', oldProject.id, MINIMAL_DRAFT);
    await service.createConfig('u1', newProject.id, MINIMAL_DRAFT);
    await service.fixQuestionnaire('u1', newProject.id, [{ text: 'Q1', category: null, orderIndex: 0, isRequired: true }]);

    const oldConv = prisma._seedConversation({});
    const oldStatus = prisma._seedStatus({ projectId: oldProject.id, candidateProfileId: candidate.id });
    prisma._seedStageProgress({ statusId: oldStatus.id, stageDefinitionId: 'stage-x', conversationId: oldConv.id, completedAt: null });

    await service.addCandidate('u1', newProject.id, candidate.id, true);

    let aiCalled = false;
    const aiRouter = { execute: async () => { aiCalled = true; return { text: '[]' }; } };
    const service2 = new InterviewPoolService(prisma as any, aiRouter as any);

    const agenda = await service2.getAgenda('u1', newProject.id, candidate.id);

    expect(agenda.length).toBe(1);
    expect(aiCalled).toBe(false);
  });

  it('getAgenda: reuseHistory=true, AI-виклик класифікації провалюється — чесна деградація до повного списку, не помилка користувачу', async () => {
    const prisma = createFakePrisma();
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    const oldProject = prisma._seedProject({ ownerId: 'u1' });
    const newProject = prisma._seedProject({ ownerId: 'u1' });
    const service = makeService(prisma);
    await service.createConfig('u1', oldProject.id, MINIMAL_DRAFT);
    await service.createConfig('u1', newProject.id, MINIMAL_DRAFT);
    await service.fixQuestionnaire('u1', newProject.id, [{ text: 'Q1', category: null, orderIndex: 0, isRequired: true }]);

    const oldConv = prisma._seedConversation({});
    prisma._seedTranscriptWithSegments(oldConv.id, ['Відповідь']);
    const oldStatus = prisma._seedStatus({ projectId: oldProject.id, candidateProfileId: candidate.id });
    prisma._seedStageProgress({ statusId: oldStatus.id, stageDefinitionId: 'stage-x', conversationId: oldConv.id, completedAt: new Date() });

    await service.addCandidate('u1', newProject.id, candidate.id, true);

    const aiRouter = { execute: async () => { throw new Error('AI provider timeout'); } };
    const service2 = new InterviewPoolService(prisma as any, aiRouter as any);

    const agenda = await service2.getAgenda('u1', newProject.id, candidate.id);

    expect(agenda.length).toBe(1);
  });

  it('регресійний тест (аудит): recordStageProgress відхиляє stageDefinitionId з ІНШОГО пулу', async () => {
    const prisma = createFakePrisma();
    const projectA = prisma._seedProject({ ownerId: 'u1' });
    const projectB = prisma._seedProject({ ownerId: 'u1' });
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    const service = makeService(prisma);
    await service.createConfig('u1', projectA.id, MINIMAL_DRAFT);
    const configB = await service.createConfig('u1', projectB.id, MINIMAL_DRAFT);
    const statusA = await service.addCandidate('u1', projectA.id, candidate.id, false);
    const foreignStage = configB.interviewStages[0];

    await expect(service.recordStageProgress('u1', statusA.id, foreignStage.id)).rejects.toThrow(NotFoundException);
  });

  it('recordStageProgress приймає валідний stageDefinitionId свого пулу, upsert ідемпотентний', async () => {
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    const service = makeService(prisma);
    const config = await service.createConfig('u1', project.id, MINIMAL_DRAFT);
    const status = await service.addCandidate('u1', project.id, candidate.id, false);
    const stage = config.interviewStages[0];
    const conv = prisma._seedConversation({ projectId: project.id });

    await service.recordStageProgress('u1', status.id, stage.id, conv.id);
    const updated = await service.recordStageProgress('u1', status.id, stage.id, conv.id, '2026-01-01T00:00:00Z');

    expect(prisma._getStageProgress().length).toBe(1);
    expect(updated.completedAt).not.toBeNull();
  });
});

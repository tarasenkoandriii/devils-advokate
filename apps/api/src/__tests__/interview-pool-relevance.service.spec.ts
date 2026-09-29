import { resetMigrationLagForTests } from '../common/enum-migration-lag';
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
      // Пункт [interview-pool-mode] 2026-09-02: доступ теперь проверяет
      // и режим проекта (как в job-search) — фейку нужен режим по
      // умолчанию, иначе тесты домена проверяли бы чужой сценарий.
      const project = { id: nextId(), mode: 'INTERVIEW_POOL', ...p };
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
        const snap = { id: nextId(), createdAt: new Date(), notAssessed: null, ...data };
        snapshots.push(snap);
        return snap;
      },
      // Сверка «пустота, неотличимая от полноты» 2026-09-04: снимок
      // дописывается списком тех, кого сверить не удалось.
      update: async ({ where, data }: any) => {
        const snap = snapshots.find((x: any) => x.id === where.id);
        if (snap) Object.assign(snap, data);
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
      // Пункт 2026-09-02: пересчёт теперь сверяется с уже созданными
      // запросами — без этого он плодил дубли при каждом прогоне.
      findMany: async ({ where }: any) =>
        followUpRequests.filter((r: any) => r.statusId === where.statusId),
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

  it('КЛЮЧОВИЙ ТЕСТ 2026-09-02: повторний перерахунок НЕ дублює домашні завдання', async () => {
    // §4.3 ТЗ: знімок формується після КОЖНОЇ завершеної співбесіди і
    // прогоняє ВСІХ кандидатів пулу. Без дедуплікації другий прогін
    // створював другі копії тих самих запитів, третій — треті: список
    // «домашніх завдань» кандидата ріс лінійно від числа перерахунків,
    // а закриті завдання «воскресали» поруч із дублями.
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
          attentionPoints: [],
          followUpRequests: ['Надати приклад конфігурації Kubernetes'],
        }),
      }),
    };
    const service = makeService(prisma, aiRouter);

    await service.regenerate('u1', project.id);
    await service.regenerate('u1', project.id);
    await service.regenerate('u1', project.id);

    expect(prisma._getFollowUpRequests().length).toBe(1);
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

    // КЛЮЧЕВОЙ ТЕСТ (сверка «пустота, неотличимая от полноты» 2026-09-04):
    // раньше провалившийся кандидат просто ИСЧЕЗАЛ из снимка. Рекрутер
    // видел одного из двух и не мог отличить «сравнили, совпадений нет»
    // от «не сравнивали вовсе» — а по этому снимку он решает, с кем
    // продолжать разговор.
    const notAssessed = (snapshot as any).notAssessed as Array<{ displayName: string; reason: string }> | null;
    if (!notAssessed || notAssessed.length !== 1) {
      throw new Error(`FAIL: непроверенный кандидат не назван в снимке: ${JSON.stringify(notAssessed)}`);
    }
    if (!/сбой AI/i.test(notAssessed[0].reason)) {
      throw new Error(`FAIL: причина пропуска не названа человеческим текстом: ${notAssessed[0].reason}`);
    }
    if (!/не результат сравнения/i.test(notAssessed[0].reason)) {
      throw new Error('FAIL: не сказано главное — что это НЕ результат сравнения');
    }

    // Один кандидат провалився (не потрапив у знімок), інший — успішно
    expect(snapshot!.entries.length).toBe(1);
  });

  // ── Пункт [lag-told-only-the-log] 2026-09-24 ──
  //
  // Терпимость к неприменённой миграции сделана по верному правилу —
  // «пробел конфигурации не должен выглядеть как отказ функции», — но
  // предупреждение уходило В ЛОГ СЕРВЕРА и никуда больше. А последствие
  // названо в самом предупреждении: «пропуски снова невидимы». Экран
  // рисует блок «Не вошли в этот снимок» только при непустом списке,
  // значит при отставании не рисует ничего, и снимок выглядит ПОЛНЫМ.
  it('КЛЮЧЕВОЙ ТЕСТ [lag-told-only-the-log]: неприменённая миграция доходит до читателя снимка, а не только до лога', async () => {
    resetMigrationLagForTests();
    const prisma = createFakePrisma();
    const project = prisma._seedProject({ ownerId: 'u1' });
    const config = prisma._seedConfig({ projectId: project.id, jobTitle: 'Backend Engineer' });
    prisma._seedQuestion({ configId: config.id, text: 'Q1', isRequired: true, orderIndex: 0 });
    const candidate = prisma._seedCandidate({ ownerUserId: 'u1', displayName: 'Кандидат' });
    const status = prisma._seedStatus({ projectId: project.id, candidateProfileId: candidate.id });
    prisma._seedStageProgress({ statusId: status.id, conversationId: 'conv-1', completedAt: new Date() });
    prisma._seedSegment({ id: 'seg-1', conversationId: 'conv-1', text: 'Відповідь' });

    // База без колонки: ровно то, что происходит у владельца, пока
    // миграция не применена.
    prisma.poolRelevanceSnapshot.update = async () => {
      throw Object.assign(new Error('The column `notAssessed` does not exist'), { code: 'P2022' });
    };
    // AI падает — значит кандидат в снимок не попадёт, и список
    // непроверенных был бы единственным следом пропуска.
    const aiRouter = { execute: async () => { throw new Error('провайдер недоступен'); } };
    const service = makeService(prisma, aiRouter);

    const snapshot: any = await service.regenerate('u1', project.id);

    // Список действительно не сохранился — иначе тест проверял бы не то.
    expect(snapshot.notAssessed ?? null).toBeNull();
    // И именно поэтому отставание обязано дойти до читателя.
    //
    // `toBeTruthy`, а НЕ `not.toBeNull`: у отсутствующего поля значение
    // `undefined`, которое `not.toBeNull()` проходит насквозь. Первая
    // редакция этих двух строк была написана именно так, и мутация
    // «убрать пометку из getLatest» прошла мимо — проверка выглядела
    // существующей, ничего не проверяя.
    expect(snapshot.pendingMigration).toBeTruthy();
    expect(snapshot.pendingMigration.migration).toContain('pool_snapshot_not_assessed');
    expect(snapshot.pendingMigration.consequence).toMatch(/пропуски/i);

    // И на повторном чтении — тоже: последний снимок читают чаще, чем
    // только что созданный.
    const latest: any = await service.getLatest('u1', project.id);
    expect(latest.pendingMigration).toBeTruthy();
    expect(latest.pendingMigration.migration).toContain('pool_snapshot_not_assessed');
  });

  it('[lag-told-only-the-log]: миграция применена — пометки нет, иначе её перестанут читать', async () => {
    resetMigrationLagForTests();
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
    const snapshot: any = await service.regenerate('u1', project.id);

    expect(snapshot.pendingMigration).toBeNull();
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

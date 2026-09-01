// Пункт [admin-sandbox] 2026-08-31 — тесты песочницы оператора.
//
// Главное, что здесь проверяется, — ГРАНИЦЫ, а не счастливый путь:
// песочница выполняет реальные платные операции, и ошибка в её
// авторизации или в утечке секретов стоила бы дороже, чем сломанная
// кнопка. Плюс WAV-генератор: битый заголовок дал бы «error» от
// AssemblyAI, неотличимый от реальной проблемы конфигурации — то есть
// песочница ЛГАЛА бы про исправную цепочку.

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AdminSandboxService, makeSandboxWav } from '../admin-sandbox/admin-sandbox.service';

const OPERATOR = 'op-1';
const REGULAR = 'user-2';

function makeDeps(overrides: { operator?: boolean } = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        isOperator: where.id === OPERATOR ? overrides.operator !== false : false,
        privacyProcessingMode: 'BALANCED',
      })),
      count: jest.fn(async () => 3),
    },
    aIProvider: {
      count: jest.fn(async () => 4),
      findUnique: jest.fn(async () => ({ id: 'p1', name: 'assemblyai' })),
    },
    project: {
      findFirst: jest.fn(async (): Promise<{ id: string } | null> => null),
      create: jest.fn(async ({ data }: any) => ({ id: 'proj-sandbox', ...data })),
      // [sandbox-domain-conversations]: доменный проект принадлежит
      // оператору; чужой ловится тестом ниже.
      findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, ownerId: OPERATOR })),
    },
    interviewPoolConfig: {
      findUnique: jest.fn(async () => ({ id: 'pc-1', interviewStages: [{ id: 'stage-1', name: 'Тех. интервью' }] })),
    },
    candidatePipelineStatus: {
      findFirst: jest.fn(async () => ({ id: 'st-1', projectId: 'proj-p' })),
      findUnique: jest.fn(async () => ({ id: 'st-1', projectId: 'proj-p' })),
    },
    transcript: {
      // Итог разбора для очереди: 2 сегмента, 1 сигнал суммарно.
      findUnique: jest.fn(async () => ({
        segments: [{ _count: { signals: 1 } }, { _count: { signals: 0 } }],
      })),
    },
    conversation: {
      findUnique: jest.fn(async () => ({ status: 'ANALYZING' })),
    },
    aIJob: {
      findUnique: jest.fn(async () => ({
        status: 'RUNNING',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        externalInteractionId: 'int-1',
        retryCount: 0,
        partialResult: null,
        leaseExpiresAt: new Date('2026-09-01T02:00:00Z'),
      })),
      update: jest.fn(async () => ({})),
    },
    mediaReviewQueueItem: {
      findFirst: jest.fn(async () => ({ id: 'item-1', status: 'PROCESSING', aiJobId: 'job-1', conversationId: 'conv-1' })),
      findUniqueOrThrow: jest.fn(async () => ({ status: 'PROCESSING', autoAnalysisError: null })),
    },
  };
  const secrets = {
    resolve: jest.fn(async (ref: string) => {
      if (ref === 'YOUTUBE_API_KEY' || ref === 'ASSEMBLYAI_API_KEY') return 'SUPERSECRET-VALUE-42';
      throw new Error(`Secret not found for credentialRef "${ref}"`);
    }),
  };
  const consent = {
    hasActiveConsent: jest.fn(async (_u: string, _type: string) => false),
    grant: jest.fn(async () => ({})),
  };
  const conversations = {
    create: jest.fn(async () => ({ id: 'conv-1' })),
    streamUploadAudio: jest.fn(async () => ({ audioUrl: 'https://cdn/upload' })),
    requestTranscription: jest.fn(async () => ({ status: 'TRANSCRIBING', externalTranscriptionJobId: 'job-1' })),
    get: jest.fn(async () => ({
      id: 'conv-1', status: 'TRANSCRIBED', externalTranscriptionJobId: 'job-1',
      transcript: { segments: [] }, participants: [], updatedAt: new Date(),
    })),
  };
  const audioBlob = {
    issueUploadToken: jest.fn(async () => ({ type: 'blob.generate-client-token', clientToken: 'tok-1' })),
    confirmUpload: jest.fn(async () => ({ pathname: 'conversation-audio/conv-1/f.m4a', sizeBytes: 10, contentType: 'audio/mp4' })),
  };
  const youtube = { search: jest.fn(async () => [{ videoId: 'v1' }]) };
  const mediaReview = {
    listQueues: jest.fn(async (): Promise<Array<{ id: string; title: string }>> => []),
    createQueue: jest.fn(async () => ({ id: 'queue-1', title: '[SANDBOX] Очередь из админки' })),
    addItem: jest.fn(async () => ({ id: 'item-1' })),
    linkConversation: jest.fn(async () => ({ id: 'item-1', status: 'READY' })),
    getQueue: jest.fn(async () => ({
      id: 'queue-1', title: '[SANDBOX] Очередь из админки',
      items: [{ id: 'item-1', youtubeVideoId: 'v1', title: 'T', status: 'READY', conversationId: 'conv-1' }],
    })),
  };
  const mediaReviewAuto = {
    retryAnalysis: jest.fn(async () => ({ status: 'PROCESSING', autoAnalysisError: null })),
  };
  const aiRouter = {
    inspectJob: jest.fn(async () => ({
      jobStatus: 'RUNNING', retryCount: 0, submitted: true,
      leaseExpiresAt: null, note: null, providerStatus: 'in_progress', providerError: null,
    })),
    pollRunning: jest.fn(async () => ({ completed: 0, failed: 0, waiting: 1 })),
  };
  const intake = {
    start: jest.fn(async () => ({ id: 'is-1', status: 'IN_PROGRESS', nextQuestion: 'Кто виноват?', decision: null })),
    answer: jest.fn(async () => ({ id: 'is-1', status: 'IN_PROGRESS', nextQuestion: null, decision: { scenario: 'dtp', confidence: 0.9 } })),
    dispatch: jest.fn(async () => ({ id: 'is-1', status: 'DISPATCHED', projectId: 'proj-dtp', conversationId: 'conv-dtp' })),
  };
  const healthOnboarding = {
    appendAnswer: jest.fn(async () => ({ id: 'seg-1' })),
    extract: jest.fn(async () => ({ goalDescription: 'операция на колене', targetBudget: null, currency: null, criteria: [] })),
  };
  const health = {
    createConfig: jest.fn(async () => ({ id: 'hc-1' })),
    uploadLabDocument: jest.fn(async () => ({ id: 'draft-1', ocrText: 'Гемоглобин 140', verified: false })),
    verifyLabDocument: jest.fn(async () => ({ id: 'draft-1', verified: true })),
  };
  const liveSession = {
    mintTranscriptionToken: jest.fn(async () => ({ token: 'rt-token', expiresInSeconds: 300 })),
  };
  const manipulation = { detect: jest.fn(async () => ({ kind: 'manip' })) };
  const discrepancy = {
    detect: jest.fn(async () => ({ kind: 'disc' })),
    factCheckConversationSegments: jest.fn(async () => ({ language: 'ru', checkedSegments: 1, totalSegments: 1, results: [] })),
  };
  const turningPoints = { detect: jest.fn(async () => ({ kind: 'tp' })) };
  // Пункт [sandbox-major-purchase] 2026-09-01 — этап 1 доменного покрытия.
  const majorPurchaseOnboarding = {
    appendAnswer: jest.fn(async () => ({ id: 'seg-1' })),
    getChecklist: jest.fn(async () => ['Проверить VIN', 'История ДТП']),
    extract: jest.fn(async () => ({ goalDescription: 'Octavia до 20к', budgetMin: null, budgetMax: 20000, currency: 'USD', financingMethod: null, timeline: null, criteria: [{ text: 'не бита', isRequired: true, orderIndex: 0 }] })),
  };
  const majorPurchase = {
    createConfig: jest.fn(async () => ({ id: 'mpc-1' })),
    createVariant: jest.fn(async () => ({ id: 'var-1', label: 'Octavia 2019' })),
    getComparisonTable: jest.fn(async () => ({ criteria: [], variants: [] })),
    createMeeting: jest.fn(async () => ({ id: 'meet-1' })),
    generateConclusion: jest.fn(async () => ({ id: 'meet-1', conclusionDraft: 'взять на заметку: торг уместен', criteriaBreakdown: [{ criterionId: 'c1', covered: 'yes' }] })),
  };
  // Пункт [sandbox-investment] 2026-09-01 — этап 2 доменного покрытия.
  const investmentOnboarding = {
    appendAnswer: jest.fn(async () => ({ id: 'seg-i' })),
    extract: jest.fn(async () => ({ goalDescription: 'Проверить фонд Х', targetBudget: 500000, currency: 'UAH', criteria: [{ text: 'гарантия доходности', category: 'RETURN_GUARANTEE', isRequired: true, orderIndex: 0 }] })),
  };
  const investment = {
    createConfig: jest.fn(async () => ({ id: 'ic-1' })),
    createOpportunity: jest.fn(async () => ({ id: 'opp-1', label: 'Фонд Х' })),
    addSourceComparison: jest.fn(async () => ({ id: 'src-1', sourceUrl: 'https://example.com/fund', sourceText: 'x'.repeat(1000) })),
    getComparisonTable: jest.fn(async () => ({ criteria: [], opportunities: [] })),
    createMeeting: jest.fn(async () => ({ id: 'imeet-1' })),
    generateBreakdown: jest.fn(async () => ({ id: 'imeet-1', criteriaBreakdown: [{ criterionId: 'ic-c1', coverage: 'covered' }] })),
  };
  const investmentGroups = {
    createGroup: jest.fn(async () => ({ id: 'grp-1', name: 'Песочная группа' })),
    createInviteLink: jest.fn(async () => ({ deepLink: 't.me/x', token: 'tok-1', expiresAt: new Date() })),
    joinGroup: jest.fn(async () => ({ id: 'mem-1', role: 'OWNER' })),
    setPledge: jest.fn(async () => ({ id: 'mem-1', pledgedAmount: 50000 })),
    listMyGroups: jest.fn(async () => [{ id: 'grp-1' }]),
  };
  // Пункт [sandbox-interview-pool] 2026-09-01 — этап 3 доменного покрытия.
  const poolOnboarding = {
    appendAnswer: jest.fn(async () => ({ id: 'seg-p' })),
    extract: jest.fn(async () => ({ jobTitle: 'Бариста', extendedDescription: 'Кофейня', salaryRange: null, employmentLoad: null, workArrangement: null, officeLocation: null, employmentFormat: null, perks: [], genderRequirement: 'NONE', ageRequirement: 'NONE', minAge: null, maxAge: null, isPhysicallyDemanding: false, interviewStages: [], complianceFlags: [{ category: 'AGE', quotedText: 'до 35 лет' }] })),
  };
  const pool = {
    createConfig: jest.fn(async () => ({ id: 'pc-1' })),
    generateQuestionnaireDraft: jest.fn(async () => [{ text: 'Опыт с кофе?', category: null, orderIndex: 0, isRequired: true }]),
    fixQuestionnaire: jest.fn(async () => [{ id: 'q-1' }]),
    addCandidate: jest.fn(async () => ({ id: 'st-1', stage: 'SCHEDULED' })),
    recordStageProgress: jest.fn(async () => ({ id: 'prog-1', completedAt: new Date('2026-09-01T12:00:00Z') })),
  };
  const poolCandidates = {
    createCandidate: jest.fn(async () => ({ id: 'cand-1' })),
  };
  const poolRelevance = {
    regenerate: jest.fn(async () => ({ id: 'snap-1', entries: [] })),
  };
  const poolReports = {
    generateSummaryReport: jest.fn(async () => ({ id: 'rep-1', content: { funnel: { totalCandidates: 1, byStage: {} }, entries: [] } })),
  };
  const poolTeams = {
    createTeam: jest.fn(async () => ({ id: 'team-1', name: 'Песочная команда' })),
    createInviteLink: jest.fn(async () => ({ deepLink: 't.me/x', token: 'ttok-1', expiresAt: new Date() })),
    joinTeam: jest.fn(async () => ({ id: 'tm-1', role: 'OWNER' })),
    listMyTeams: jest.fn(async () => [{ id: 'team-1' }]),
  };
  // Пункт [sandbox-family-law] 2026-09-01 — этап 4 доменного покрытия.
  const familyLawOnboarding = {
    appendAnswer: jest.fn(async () => ({ id: 'seg-f' })),
    extract: jest.fn(async () => ({ goalDescription: 'Раздел имущества без суда', targetBudget: 100000, currency: 'UAH', criteria: [{ text: 'квартира остаётся детям', category: 'ASSET_DIVISION', isRequired: true, orderIndex: 0 }] })),
  };
  const familyLaw = {
    createConfig: jest.fn(async () => ({ id: 'flc-1' })),
    createAdvisor: jest.fn(async () => ({ id: 'adv-1' })),
    createConsultation: jest.fn(async () => ({ id: 'cons-1' })),
    generateBreakdown: jest.fn(async () => ({ id: 'cons-1', criteriaBreakdown: [{ criterionId: 'fl-c1', coverage: 'covered' }] })),
  };
  const familyLawV2 = {
    createParty: jest.fn(async () => ({ id: 'party-1', role: 'SELF' })),
    createAsset: jest.fn(async () => ({ id: 'asset-1' })),
    createBudgetLineItem: jest.fn(async () => ({ id: 'bli-1' })),
    getBudget: jest.fn(async () => ({ lineItems: [], byCurrency: [{ currency: 'UAH', totalExpense: 50000, totalCoverage: 0, netBudget: 50000 }], targetBudget: 100000, currency: 'UAH' })),
    getSettlementProtocolDraft: jest.fn(async () => ({ text: 'Це чернетка-компіляція... НЕ юридично завершений документ', generatedAt: new Date().toISOString(), disclaimer: 'НЕ юридично завершений документ' })),
  };
  // Пункт [sandbox-dtp] 2026-09-01 — этап 5 доменного покрытия.
  const dtpOnboarding = {
    appendAnswer: jest.fn(async () => ({ id: 'seg-d' })),
    extract: jest.fn(async () => ({ goalDescription: 'Полная выплата от страховой', targetBudget: null, currency: null, occurredAt: '2026-08-30', criteria: [{ text: 'вина установлена протоколом', category: 'FAULT_DETERMINATION', isRequired: true, orderIndex: 0 }] })),
  };
  const dtp = {
    createConfig: jest.fn(async () => ({ id: 'dc-1' })),
    createEvidence: jest.fn(async () => ({ id: 'ev-1', fileHash: 'a'.repeat(64), mediaType: 'PHOTO', capturedAt: new Date('2026-09-01T10:00:00Z') })),
    createAdvisor: jest.fn(async () => ({ id: 'dadv-1' })),
    createConsultation: jest.fn(async () => ({ id: 'dcons-1' })),
    generateBreakdown: jest.fn(async () => ({ id: 'dcons-1', criteriaBreakdown: [{ criterionId: 'd-c1', coverage: 'covered' }] })),
  };
  const dtpV2 = {
    createParticipant: jest.fn(async () => ({ id: 'pt-1', role: 'SELF' })),
    createFaultDetermination: jest.fn(async () => ({ id: 'fd-1' })),
    logEvidenceAccess: jest.fn(async () => undefined),
    getEvidenceAccessLog: jest.fn(async () => [{ action: 'VIEWED_METADATA', occurredAt: new Date('2026-09-01T10:00:01Z') }]),
    getSettlementProtocolDraft: jest.fn(async () => ({ text: 'чернетка... НЕ юридично завершений документ', generatedAt: new Date().toISOString(), disclaimer: 'x' })),
  };
  return { prisma, secrets, consent, conversations, audioBlob, youtube, mediaReview, mediaReviewAuto, aiRouter, intake, healthOnboarding, health, liveSession, manipulation, discrepancy, turningPoints, majorPurchaseOnboarding, majorPurchase, investmentOnboarding, investment, investmentGroups, poolOnboarding, pool, poolCandidates, poolRelevance, poolReports, poolTeams, familyLawOnboarding, familyLaw, familyLawV2, dtpOnboarding, dtp, dtpV2 };
}

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new AdminSandboxService(
    deps.prisma as any,
    deps.secrets as any,
    deps.consent as any,
    deps.conversations as any,
    deps.audioBlob as any,
    deps.youtube as any,
    deps.mediaReview as any,
    deps.mediaReviewAuto as any,
    deps.aiRouter as any,
    deps.intake as any,
    deps.healthOnboarding as any,
    deps.health as any,
    deps.liveSession as any,
    deps.manipulation as any,
    deps.discrepancy as any,
    deps.turningPoints as any,
    deps.majorPurchaseOnboarding as any,
    deps.majorPurchase as any,
    deps.investmentOnboarding as any,
    deps.investment as any,
    deps.investmentGroups as any,
    deps.poolOnboarding as any,
    deps.pool as any,
    deps.poolCandidates as any,
    deps.poolRelevance as any,
    deps.poolReports as any,
    deps.poolTeams as any,
    deps.familyLawOnboarding as any,
    deps.familyLaw as any,
    deps.familyLawV2 as any,
    deps.dtpOnboarding as any,
    deps.dtp as any,
    deps.dtpV2 as any,
  );
}

describe('AdminSandboxService — граница по роли', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: без isOperator ни один метод не работает', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await expect(svc.getStatus(REGULAR)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.grantOwnConsents(REGULAR)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.youtubeSearch(REGULAR, 'x')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.runTranscriptionSmoke(REGULAR)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getConversation(REGULAR, 'conv-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.analyze(REGULAR, 'conv-1', 'manipulation')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.createUploadConversation(REGULAR, false)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.issueUploadClientToken(REGULAR, 'conv-1', 'conversation-audio/conv-1/f.m4a')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.confirmUpload(REGULAR, 'conv-1', 'conversation-audio/conv-1/f.m4a')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.transcribeUploaded(REGULAR, 'conv-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.addToQueue(REGULAR, { youtubeVideoId: 'v1', title: '', channelName: '', thumbnailUrl: '' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.linkQueueItem(REGULAR, 'item-1', 'conv-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getSandboxQueue(REGULAR)).rejects.toBeInstanceOf(ForbiddenException);
    // Ни платных вызовов, ни выдачи согласий не произошло.
    expect(deps.youtube.search).not.toHaveBeenCalled();
    expect(deps.consent.grant).not.toHaveBeenCalled();
    expect(deps.conversations.streamUploadAudio).not.toHaveBeenCalled();
  });
});

describe('AdminSandboxService.getStatus', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: в ответе нет значений секретов — только задан/не задан', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    const { items } = await svc.getStatus(OPERATOR);
    const dump = JSON.stringify(items);
    // 'SUPERSECRET-VALUE-42' — значение, которое мок резолвит для
    // заданных ключей. Проверка от противного: если кто-то начнёт
    // класть значение секрета в detail, тест поймает это на самом
    // дешёвом уровне.
    expect(dump).not.toContain('SUPERSECRET-VALUE-42');
  });

  it('отражает и заданные, и незаданные ключи', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    const { items } = await svc.getStatus(OPERATOR);
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey['youtube'].ok).toBe(true);
    expect(byKey['assemblyai'].ok).toBe(true);
    expect(byKey['webhook-secret'].ok).toBe(false);
    expect(byKey['llm'].ok).toBe(false);
    expect(byKey['seed'].ok).toBe(true);
    expect(byKey['consents'].ok).toBe(false); // hasActiveConsent → false
    // Аудит [fact-check-audit]: ключ факт-чека появился в чеклисте;
    // ok всегда true (опционален — без него режим AI-гипотез), но
    // detail различает режимы.
    expect(byKey['fact-check'].ok).toBe(true);
    expect(byKey['fact-check'].detail).toMatch(/AI-гипотез/);
  });
});

describe('AdminSandboxService.grantOwnConsents', () => {
  it('выдаёт только недостающие согласия и помечает источник admin-sandbox', async () => {
    const deps = makeDeps();
    deps.consent.hasActiveConsent = jest.fn(async (_u: string, type: string) => type === 'RECORDING');
    const svc = makeService(deps);

    const res = await svc.grantOwnConsents(OPERATOR);

    expect(res.granted.sort()).toEqual(['EPHEMERAL_SERVER', 'EXTERNAL_AI', 'HEALTH_DATA', 'THIRD_PARTY_AUDIO_RECORDING']);
    expect(res.alreadyHad).toEqual(['RECORDING']);
    for (const call of (deps.consent.grant as jest.Mock).mock.calls) {
      expect(call[0].source).toBe('admin-sandbox');
      expect(call[0].userId).toBe(OPERATOR); // только себе, никакой имперсонации
    }
  });
});

describe('AdminSandboxService.youtubeSearch', () => {
  it('делегирует в реальный YouTubeSearchService с userId оператора (лимит 20/сутки не обходится)', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await svc.youtubeSearch(OPERATOR, '  дебаты  ');

    expect(deps.youtube.search).toHaveBeenCalledWith(OPERATOR, 'дебаты');
  });

  it('пустой запрос — отказ до обращения к API (квота тратится даже на ошибку)', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await expect(svc.youtubeSearch(OPERATOR, '   ')).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.youtube.search).not.toHaveBeenCalled();
  });
});

describe('AdminSandboxService.runTranscriptionSmoke', () => {
  it('идёт через продовые методы ConversationsService — проверки согласий не обходятся', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    const res = await svc.runTranscriptionSmoke(OPERATOR);

    expect(deps.conversations.streamUploadAudio).toHaveBeenCalled();
    expect((deps.conversations.streamUploadAudio as jest.Mock).mock.calls[0][0]).toBe(OPERATOR);
    expect(deps.conversations.requestTranscription).toHaveBeenCalledWith(OPERATOR, 'conv-1', {
      audioUrl: 'https://cdn/upload',
    });
    expect(res.conversationId).toBe('conv-1');
    expect(res.status).toBe('TRANSCRIBING');
  });

  it('отказ по согласиям пробрасывается как есть — это результат прогона, не сбой песочницы', async () => {
    const deps = makeDeps();
    deps.conversations.streamUploadAudio = jest.fn(async () => {
      throw new ForbiddenException('Consent required: RECORDING');
    });
    const svc = makeService(deps);

    await expect(svc.runTranscriptionSmoke(OPERATOR)).rejects.toBeInstanceOf(ForbiddenException);
    expect(deps.conversations.requestTranscription).not.toHaveBeenCalled();
  });

  it('переиспользует существующий песочный проект, а не создаёт новый на каждый прогон', async () => {
    const deps = makeDeps();
    deps.prisma.project.findFirst = jest.fn(async () => ({ id: 'proj-existing' }));
    const svc = makeService(deps);

    const res = await svc.runTranscriptionSmoke(OPERATOR);

    expect(deps.prisma.project.create).not.toHaveBeenCalled();
    expect(res.projectId).toBe('proj-existing');
  });
});

describe('AdminSandboxService.analyze', () => {
  it('переключает на нужный детектор и не трогает остальные', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await svc.analyze(OPERATOR, 'conv-1', 'discrepancy');

    expect(deps.discrepancy.detect).toHaveBeenCalledWith(OPERATOR, 'conv-1');
    expect(deps.manipulation.detect).not.toHaveBeenCalled();
    expect(deps.turningPoints.detect).not.toHaveBeenCalled();
  });

  it('неизвестный вид анализа — BadRequest, а не тихий no-op', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    await expect(svc.analyze(OPERATOR, 'conv-1', 'nonsense' as never)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AdminSandboxService — загрузка реального файла (вторая итерация)', () => {
  it('токен берётся через AudioBlobService с userId оператора и multipart', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    const res = await svc.issueUploadClientToken(OPERATOR, 'conv-1', ' conversation-audio/conv-1/rec.m4a ');

    expect(res.clientToken).toBe('tok-1');
    const [userId, convId, body] = (deps.audioBlob.issueUploadToken as jest.Mock).mock.calls[0];
    expect(userId).toBe(OPERATOR);
    expect(convId).toBe('conv-1');
    // Синтезированное тело — ровно протокол handleUpload, с trim'ом
    // pathname: пробел из буфера обмена не должен попадать в токен.
    expect(body).toEqual({
      type: 'blob.generate-client-token',
      payload: { pathname: 'conversation-audio/conv-1/rec.m4a', clientPayload: null, multipart: true },
    });
  });

  it('пустой pathname — отказ до обращения к blob', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    await expect(svc.issueUploadClientToken(OPERATOR, 'conv-1', '  ')).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.audioBlob.issueUploadToken).not.toHaveBeenCalled();
  });

  it('подтверждение и запуск расшифровки делегируются продовым сервисам с userId оператора', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await svc.confirmUpload(OPERATOR, 'conv-1', 'conversation-audio/conv-1/rec.m4a');
    expect(deps.audioBlob.confirmUpload).toHaveBeenCalledWith(OPERATOR, 'conv-1', {
      pathname: 'conversation-audio/conv-1/rec.m4a',
    });

    const started = await svc.transcribeUploaded(OPERATOR, 'conv-1');
    // Без audioUrl — ссылку подписывает сам ConversationsService из
    // audioBlobPathname; передать сюда URL значило бы открыть обход.
    expect(deps.conversations.requestTranscription).toHaveBeenCalledWith(OPERATOR, 'conv-1', {
      languageCode: undefined,
    });
    expect(started.status).toBe('TRANSCRIBING');
  });

  it('createUploadConversation выбирает sourceType по типу файла', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await svc.createUploadConversation(OPERATOR, true, 120);
    const dto = (deps.conversations.create as jest.Mock).mock.calls[0][2];
    expect(dto.sourceType).toBe('UPLOADED_VIDEO');
    expect(dto.durationSeconds).toBe(120);
  });
});

describe('AdminSandboxService — песочная очередь медиа-разбора (третья итерация)', () => {
  it('addToQueue создаёт очередь один раз и переиспользует её по маркеру', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const video = { youtubeVideoId: 'v1', title: 'T', channelName: 'C', thumbnailUrl: 'u' };

    const first = await svc.addToQueue(OPERATOR, video);
    expect(first).toEqual({ queueId: 'queue-1', itemId: 'item-1' });
    expect(deps.mediaReview.createQueue).toHaveBeenCalledTimes(1);

    // Вторая кнопка «Разобрать» — очередь уже существует.
    deps.mediaReview.listQueues = jest.fn(async () => [{ id: 'queue-1', title: '[SANDBOX] Очередь из админки' }]);
    await svc.addToQueue(OPERATOR, video);
    expect(deps.mediaReview.createQueue).toHaveBeenCalledTimes(1);
  });

  it('пустой youtubeVideoId — отказ до создания чего-либо', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    await expect(
      svc.addToQueue(OPERATOR, { youtubeVideoId: '  ', title: '', channelName: '', thumbnailUrl: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.mediaReview.addItem).not.toHaveBeenCalled();
  });

  it('привязка и чтение очереди делегируются продовому MediaReviewService с userId оператора', async () => {
    const deps = makeDeps();
    deps.mediaReview.listQueues = jest.fn(async () => [{ id: 'queue-1', title: '[SANDBOX] Очередь из админки' }]);
    const svc = makeService(deps);

    await svc.linkQueueItem(OPERATOR, 'item-1', 'conv-1');
    expect(deps.mediaReview.linkConversation).toHaveBeenCalledWith(OPERATOR, 'item-1', 'conv-1');

    const res = await svc.getSandboxQueue(OPERATOR);
    // Именно продовый getQueue(): он синхронизирует READY→PROCESSING→DONE.
    expect(deps.mediaReview.getQueue).toHaveBeenCalledWith(OPERATOR, 'queue-1');
    expect(res.queue?.items[0].status).toBe('READY');
    // Итог разбора виден прямо в очереди: сигналов может быть честный
    // ноль, и без счётчика сегментов DONE читается как «пусто».
    expect(res.queue?.items[0].segments).toBe(2);
    expect(res.queue?.items[0].signals).toBe(1);
    expect(res.queue?.items[0].autoAnalysisError).toBeNull();
    // Сырьё прогресса: статус разговора отдаётся всегда (вторая ось),
    // факты джобы — только для PROCESSING (здесь READY → null).
    expect(res.queue?.items[0].conversationStatus).toBe('ANALYZING');
    expect(res.queue?.items[0].job).toBeNull();
  });

  it('прогресс PROCESSING-элемента несёт факты джобы (фаза, старт, submitted) — процент считает клиент', async () => {
    const deps = makeDeps();
    deps.mediaReview.listQueues = jest.fn(async () => [{ id: 'queue-1', title: '[SANDBOX] Очередь из админки' }]);
    deps.mediaReview.getQueue = jest.fn(async () => ({
      id: 'queue-1', title: '[SANDBOX] Очередь из админки',
      items: [{ id: 'item-1', youtubeVideoId: 'v1', title: 'T', status: 'PROCESSING', conversationId: 'conv-1', aiJobId: 'job-1', durationSeconds: 300 }],
    }));
    deps.prisma.transcript.findUnique = jest.fn(async (): Promise<any> => null);
    const svc = makeService(deps);

    const res = await svc.getSandboxQueue(OPERATOR);
    const item = res.queue!.items[0];
    expect(item.durationSeconds).toBe(300);
    expect(item.job).toEqual({
      status: 'RUNNING',
      startedAt: new Date('2026-09-01T00:00:00Z'),
      submitted: true,
      retryCount: 0,
      note: null,
      leaseExpiresAt: new Date('2026-09-01T02:00:00Z'),
    });
  });

  it('«Повторить» делегируется продовому retryAnalysis с userId оператора; не-оператору — отказ', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    const res = await svc.retryQueueItem(OPERATOR, 'item-1');
    expect(deps.mediaReviewAuto.retryAnalysis).toHaveBeenCalledWith(OPERATOR, 'item-1');
    expect(res.status).toBe('PROCESSING');

    await expect(svc.retryQueueItem(REGULAR, 'item-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('getAnalysis: сегменты с таймкодами и сигналами для аккордеона; не-оператору — отказ', async () => {
    const deps = makeDeps();
    deps.prisma.transcript.findUnique = jest.fn(async (): Promise<any> => ({
      language: 'ru',
      segments: [
        {
          startMs: 5000, endMs: 12000, text: 'реплика',
          participant: { diarizationLabel: 'SPEAKER_00' },
          signals: [{ signalType: 'MANIPULATION_PATTERN', paralinguisticChannel: null, confidence: 0.7 }],
        },
      ],
    }));
    const svc = makeService(deps);

    const res = await svc.getAnalysis(OPERATOR, 'conv-1');
    expect(res.language).toBe('ru');
    expect(res.segments[0].speaker).toBe('SPEAKER_00');
    expect(res.segments[0].signals[0].type).toBe('MANIPULATION_PATTERN');

    await expect(svc.getAnalysis(REGULAR, 'conv-1')).rejects.toBeInstanceOf(ForbiddenException);

    // Разговор без транскрипта — пустой разбор, не ошибка.
    deps.prisma.transcript.findUnique = jest.fn(async (): Promise<any> => null);
    const empty = await svc.getAnalysis(OPERATOR, 'conv-2');
    expect(empty.segments).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ диагностики: чинит RUNNING без lease, спрашивает живой статус провайдера, гоняет внеочередной опрос', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    const d = await svc.diagnoseQueueItem(OPERATOR, 'item-1');

    // Аномалия «RUNNING без lease» (inspectJob вернул leaseExpiresAt
    // null) исправлена: без этого джоба вне досягаемости сторожевой.
    expect(deps.prisma.aIJob.update).toHaveBeenCalled();
    expect(d.fixedMissingLease).toBe(true);
    // Внеочередной опрос — тот же продовый pollRunning, не копия.
    expect(deps.aiRouter.pollRunning).toHaveBeenCalled();
    // Провайдер подтвердил in_progress → вердикт «не сбой».
    expect(d.verdict).toContain('провайдер подтверждает');
    expect(d.steps.some((s) => s.includes('АНОМАЛИЯ'))).toBe(true);

    await expect(svc.diagnoseQueueItem(REGULAR, 'item-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('intake-квиз: start/answer/dispatch делегируются продовому IntakeService от имени оператора; не-оператору — отказ', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await svc.intakeStart(OPERATOR, 'в меня въехала машина');
    expect(deps.intake.start).toHaveBeenCalledWith(OPERATOR, 'в меня въехала машина');
    await svc.intakeAnswer(OPERATOR, 'is-1', 'виновник признал вину');
    expect(deps.intake.answer).toHaveBeenCalledWith(OPERATOR, 'is-1', 'виновник признал вину');
    const res = await svc.intakeDispatch(OPERATOR, 'is-1', 'dtp' as never);
    expect(deps.intake.dispatch).toHaveBeenCalledWith(OPERATOR, 'is-1', 'dtp', { contractType: undefined });
    expect(res.projectId).toBe('proj-dtp');

    // Пустой текст — отказ до единого LLM-вызова (реальные токены).
    await expect(svc.intakeStart(OPERATOR, '  ')).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.intake.start).toHaveBeenCalledTimes(1);

    await expect(svc.intakeStart(REGULAR, 'x')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.intakeDispatch(REGULAR, 'is-1', 'dtp' as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('health-цепочка (ответ → extract → config) делегируется продовым сервисам; не-оператору — отказ', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await svc.healthAppendAnswer(OPERATOR, 'conv-h', 'бюджет до 200 тысяч');
    expect(deps.healthOnboarding.appendAnswer).toHaveBeenCalledWith(OPERATOR, 'conv-h', 'бюджет до 200 тысяч');

    const draft = await svc.healthExtract(OPERATOR, 'conv-h');
    expect(deps.healthOnboarding.extract).toHaveBeenCalledWith(OPERATOR, 'conv-h');
    expect(draft.goalDescription).toContain('колене');

    const config = await svc.healthCreateConfig(OPERATOR, 'proj-h', draft as never);
    expect(deps.health.createConfig).toHaveBeenCalledWith(OPERATOR, 'proj-h', draft);
    expect(config.id).toBe('hc-1');

    await expect(svc.healthExtract(REGULAR, 'conv-h')).rejects.toBeInstanceOf(ForbiddenException);

    // OCR лабдокумента: делегирование с userId оператора, verify отдельно.
    const labDraft = await svc.healthUploadLabDocument(OPERATOR, 'hc-1', 'aGVsbG8=');
    expect(deps.health.uploadLabDocument).toHaveBeenCalledWith(OPERATOR, 'hc-1', 'aGVsbG8=');
    expect(labDraft.verified).toBe(false);
    const verified = await svc.healthVerifyLabDocument(OPERATOR, labDraft.id);
    expect(verified.verified).toBe(true);
    await expect(svc.healthUploadLabDocument(REGULAR, 'hc-1', 'x')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('major-purchase-цикл (ответ → чек-лист → extract → config → вариант → таблица) делегируется продовым сервисам; не-оператору — отказ', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await svc.mpAppendAnswer(OPERATOR, 'conv-mp', 'бюджет до 20 тысяч долларов');
    expect(deps.majorPurchaseOnboarding.appendAnswer).toHaveBeenCalledWith(OPERATOR, 'conv-mp', 'бюджет до 20 тысяч долларов');

    const checklist = await svc.mpChecklist(OPERATOR, 'conv-mp', 'VEHICLE' as never);
    expect(deps.majorPurchaseOnboarding.getChecklist).toHaveBeenCalledWith(OPERATOR, 'conv-mp', 'VEHICLE');
    expect(checklist.items).toContain('Проверить VIN');

    const draft = await svc.mpExtract(OPERATOR, 'conv-mp', 'VEHICLE' as never);
    expect(deps.majorPurchaseOnboarding.extract).toHaveBeenCalledWith(OPERATOR, 'conv-mp', 'VEHICLE');

    const config = await svc.mpCreateConfig(OPERATOR, 'proj-mp', 'VEHICLE' as never, draft as never);
    expect(deps.majorPurchase.createConfig).toHaveBeenCalledWith(OPERATOR, 'proj-mp', 'VEHICLE', draft);
    expect(config.id).toBe('mpc-1');

    await svc.mpAddVariant(OPERATOR, 'mpc-1', 'Octavia 2019', 18500, 'USD');
    expect(deps.majorPurchase.createVariant).toHaveBeenCalledWith(OPERATOR, 'mpc-1', 'Octavia 2019', 18500, 'USD');

    await svc.mpComparisonTable(OPERATOR, 'mpc-1');
    expect(deps.majorPurchase.getComparisonTable).toHaveBeenCalledWith(OPERATOR, 'mpc-1');

    await expect(svc.mpExtract(REGULAR, 'conv-mp', 'VEHICLE' as never)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.mpAddVariant(REGULAR, 'mpc-1', 'x')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('investment-цикл (ответ → extract → config → возможность → источник → таблица) и смоук групп делегируются продовым сервисам; не-оператору — отказ', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    await svc.invAppendAnswer(OPERATOR, 'conv-i', 'фонд обещает 30% годовых');
    expect(deps.investmentOnboarding.appendAnswer).toHaveBeenCalledWith(OPERATOR, 'conv-i', 'фонд обещает 30% годовых');

    const draft = await svc.invExtract(OPERATOR, 'conv-i');
    expect(deps.investmentOnboarding.extract).toHaveBeenCalledWith(OPERATOR, 'conv-i');

    const config = await svc.invCreateConfig(OPERATOR, 'proj-i', draft as never);
    expect(deps.investment.createConfig).toHaveBeenCalledWith(OPERATOR, 'proj-i', draft);
    expect(config.id).toBe('ic-1');

    await svc.invAddOpportunity(OPERATOR, 'ic-1', 'Фонд Х', 'Иван');
    expect(deps.investment.createOpportunity).toHaveBeenCalledWith(OPERATOR, 'ic-1', 'Фонд Х', 'Иван', undefined);

    // Сырой текст источника НЕ возвращается целиком — только длина и превью.
    const src = await svc.invSourceComparison(OPERATOR, 'opp-1', 'https://example.com/fund');
    expect(deps.investment.addSourceComparison).toHaveBeenCalledWith(OPERATOR, 'opp-1', 'https://example.com/fund');
    expect(src.sourceTextLength).toBe(1000);
    expect(src.sourceTextPreview).toHaveLength(400);
    expect((src as Record<string, unknown>).sourceText).toBeUndefined();

    await svc.invComparisonTable(OPERATOR, 'ic-1');
    expect(deps.investment.getComparisonTable).toHaveBeenCalledWith(OPERATOR, 'ic-1');

    // Смоук групп: создать → инвайт → повторный вход своим токеном → pledge.
    const smoke = await svc.invGroupSmoke(OPERATOR, 50000);
    expect(deps.investmentGroups.createGroup).toHaveBeenCalledTimes(1);
    expect(deps.investmentGroups.joinGroup).toHaveBeenCalledWith(OPERATOR, 'tok-1');
    expect(deps.investmentGroups.setPledge).toHaveBeenCalledWith(OPERATOR, 'grp-1', 50000);
    expect(smoke.rejoinIdempotent).toBe(true);
    expect(smoke.notes).toContain('не имперсонирует');

    await expect(svc.invExtract(REGULAR, 'conv-i')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.invGroupSmoke(REGULAR, 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('interview-pool-цикл (extract с compliance-флагами → config → анкета draft/fix → кандидат → релевантность → отчёт) делегируется продовым сервисам; не-оператору — отказ', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    const draft = await svc.ipExtract(OPERATOR, 'conv-p');
    expect(deps.poolOnboarding.extract).toHaveBeenCalledWith(OPERATOR, 'conv-p');
    expect(draft.complianceFlags[0]).toMatchObject({ category: 'AGE' }); // флаг доходит до оператора, не вычищается

    await svc.ipCreateConfig(OPERATOR, 'proj-p', draft as never);
    expect(deps.pool.createConfig).toHaveBeenCalledWith(OPERATOR, 'proj-p', draft);

    // Анкета: два ОТДЕЛЬНЫХ шага — AI предлагает, человек утверждает.
    const q = await svc.ipQuestionnaireDraft(OPERATOR, 'proj-p');
    expect(deps.pool.generateQuestionnaireDraft).toHaveBeenCalledWith(OPERATOR, 'proj-p');
    expect(deps.pool.fixQuestionnaire).not.toHaveBeenCalled();
    const fixed = await svc.ipFixQuestionnaire(OPERATOR, 'proj-p', q.items as never);
    expect(deps.pool.fixQuestionnaire).toHaveBeenCalledWith(OPERATOR, 'proj-p', q.items);
    expect(fixed.count).toBe(1);

    const cand = await svc.ipAddCandidate(OPERATOR, 'proj-p', 'Анна', 'бариста 3 года');
    expect(deps.poolCandidates.createCandidate).toHaveBeenCalledWith(OPERATOR, 'Анна', undefined, 'бариста 3 года');
    expect(deps.pool.addCandidate).toHaveBeenCalledWith(OPERATOR, 'proj-p', 'cand-1', false); // reuseHistory=false — дефолт продукта
    expect(cand.statusId).toBe('st-1');

    // Релевантность без завершённых собеседований — честно пустой
    // снимок с пояснением, не сбой.
    const rel = await svc.ipRelevance(OPERATOR, 'proj-p');
    expect(rel.entries).toEqual([]);
    expect(rel.note).toMatch(/завершённых собеседований/);

    const rep = await svc.ipSummaryReport(OPERATOR, 'proj-p');
    expect(rep.reportId).toBe('rep-1');

    const team = await svc.ipTeamSmoke(OPERATOR);
    expect(deps.poolTeams.joinTeam).toHaveBeenCalledWith(OPERATOR, 'ttok-1');
    expect(team.rejoinIdempotent).toBe(true);

    await expect(svc.ipExtract(REGULAR, 'conv-p')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.ipTeamSmoke(REGULAR)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('family-law-цикл (extract → config → сторона → актив → бюджет → черновик протокола с дисклеймером) делегируется продовым сервисам; не-оператору — отказ', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    const draft = await svc.flExtract(OPERATOR, 'conv-f');
    expect(deps.familyLawOnboarding.extract).toHaveBeenCalledWith(OPERATOR, 'conv-f');

    const config = await svc.flCreateConfig(OPERATOR, 'proj-f', draft as never);
    expect(deps.familyLaw.createConfig).toHaveBeenCalledWith(OPERATOR, 'proj-f', draft);
    expect(config.id).toBe('flc-1');

    await svc.flAddParty(OPERATOR, 'flc-1', 'SELF', 'Андрей');
    expect(deps.familyLawV2.createParty).toHaveBeenCalledWith(OPERATOR, 'flc-1', 'SELF', 'Андрей');

    await svc.flAddAsset(OPERATOR, 'flc-1', 'квартира', 2500000, 'UAH', true);
    // позиционные undefined — description/ownerId в панель не выведены.
    expect(deps.familyLawV2.createAsset).toHaveBeenCalledWith(OPERATOR, 'flc-1', 'квартира', undefined, undefined, true, 2500000, 'UAH');

    const budget = await svc.flAddBudgetItem(OPERATOR, 'flc-1', 'LEGAL_FEES', 'EXPENSE', 50000, 'UAH');
    expect(deps.familyLawV2.createBudgetLineItem).toHaveBeenCalledWith(OPERATOR, 'flc-1', 'LEGAL_FEES', 'EXPENSE', 50000, 'UAH');
    expect(budget.byCurrency[0].netBudget).toBe(50000); // сразу свежий свод, без второй кнопки

    // «Жемчужина»: черновик протокола приходит С продовым дисклеймером
    // «не юридический документ» — песочница его не срезает.
    const settlement = await svc.flSettlementDraft(OPERATOR, 'flc-1');
    expect(settlement.text).toMatch(/НЕ юридично/);

    await expect(svc.flExtract(REGULAR, 'conv-f')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.flSettlementDraft(REGULAR, 'flc-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('dtp-цикл (extract → config → участник → вина → доказательство с журналом доступа → черновик протокола) делегируется продовым сервисам; не-оператору — отказ', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    const draft = await svc.dtpExtract(OPERATOR, 'conv-d');
    expect(deps.dtpOnboarding.extract).toHaveBeenCalledWith(OPERATOR, 'conv-d');

    await svc.dtpCreateConfig(OPERATOR, 'proj-d', draft as never);
    expect(deps.dtp.createConfig).toHaveBeenCalledWith(OPERATOR, 'proj-d', draft);

    await svc.dtpAddParticipant(OPERATOR, 'dc-1', 'SELF');
    expect(deps.dtpV2.createParticipant).toHaveBeenCalledWith(OPERATOR, 'dc-1', 'SELF', undefined, undefined);

    await svc.dtpFault(OPERATOR, 'dc-1', 'POLICE', 'виновник признал вину', true);
    expect(deps.dtpV2.createFaultDetermination).toHaveBeenCalledWith(OPERATOR, 'dc-1', 'POLICE', 'виновник признал вину', expect.any(String), true);

    // Доказательство: PHOTO без аудио и без гео (не требовать LOCATION
    // ради смоука), сразу запись в журнал и его чтение.
    const ev = await svc.dtpUploadEvidence(OPERATOR, 'dc-1', 'aGVsbG8=', 'image/jpeg');
    expect(deps.dtp.createEvidence).toHaveBeenCalledWith(OPERATOR, 'dc-1', 'PHOTO', false, 'aGVsbG8=', 'image/jpeg', expect.any(String));
    expect(deps.dtpV2.logEvidenceAccess).toHaveBeenCalledWith(OPERATOR, 'ev-1', 'VIEWED_METADATA');
    expect(ev.fileHash).toBe('a'.repeat(64));
    expect(ev.accessLog[0]).toMatchObject({ action: 'VIEWED_METADATA' });

    const settlement = await svc.dtpSettlementDraft(OPERATOR, 'dc-1');
    expect(settlement.text).toMatch(/НЕ юридично/);

    await expect(svc.dtpExtract(REGULAR, 'conv-d')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.dtpUploadEvidence(REGULAR, 'dc-1', 'x', 'image/jpeg')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('[sandbox-domain-conversations]: загрузка в доменный проект + пять b-подэтапов делегируются продовым сервисам', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);

    // Загрузка с targetProjectId идёт в указанный проект (владение
    // проверено через project.findUnique), песочный не создаётся.
    const up = await svc.createUploadConversation(OPERATOR, false, 60, 'proj-mp');
    expect(up.projectId).toBe('proj-mp');
    expect(deps.prisma.project.create).not.toHaveBeenCalled();

    // Чужой проект — отказ (мок вернёт ownerId!==REGULAR для запроса от REGULAR? — тут проверяем ветку «не владелец»)
    (deps.prisma.project.findUnique as jest.Mock).mockResolvedValueOnce({ id: 'p-x', ownerId: 'someone-else' });
    await expect(svc.createUploadConversation(OPERATOR, false, 60, 'p-x')).rejects.toThrow(/не найден или принадлежит/);

    // 1b: встреча + заключение.
    const mp = await svc.mpMeetingConclusion(OPERATOR, 'var-1', 'conv-rec');
    expect(deps.majorPurchase.createMeeting).toHaveBeenCalledWith(OPERATOR, 'var-1', 'conv-rec', expect.any(String));
    expect(deps.majorPurchase.generateConclusion).toHaveBeenCalledWith(OPERATOR, 'meet-1');
    expect(mp.conclusionDraft).toContain('торг');

    // 2b: встреча + нейтральный разбор.
    await svc.invMeetingBreakdown(OPERATOR, 'opp-1', 'conv-rec');
    expect(deps.investment.generateBreakdown).toHaveBeenCalledWith(OPERATOR, 'imeet-1');

    // 3b: привязка интервью — первая стадия + первый кандидат, completedAt задан.
    const ip = await svc.ipAttachInterview(OPERATOR, 'proj-p', 'conv-rec');
    expect(deps.pool.recordStageProgress).toHaveBeenCalledWith(OPERATOR, 'st-1', 'stage-1', 'conv-rec', expect.any(String));
    expect(ip.note).toMatch(/упрощение песочницы/);

    // 4b/5b: советник → консультация → разбор.
    await svc.flConsultationBreakdown(OPERATOR, 'flc-1', 'Юрист', 'conv-rec');
    expect(deps.familyLaw.createConsultation).toHaveBeenCalledWith(OPERATOR, 'adv-1', 'conv-rec', expect.any(String));
    expect(deps.familyLaw.generateBreakdown).toHaveBeenCalledWith(OPERATOR, 'cons-1');
    await svc.dtpConsultationBreakdown(OPERATOR, 'dc-1', '', 'conv-rec');
    expect(deps.dtp.createAdvisor).toHaveBeenCalledWith(OPERATOR, 'dc-1', 'Песочный юрист'); // пустой label → дефолт
    expect(deps.dtp.generateBreakdown).toHaveBeenCalledWith(OPERATOR, 'dcons-1');

    await expect(svc.mpMeetingConclusion(REGULAR, 'var-1', 'c')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.ipAttachInterview(REGULAR, 'proj-p', 'c')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('согласия песочницы включают HEALTH_DATA — без него dispatch в health падал бы на createProject', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const res = await svc.grantOwnConsents(OPERATOR);
    expect(res.granted).toContain('HEALTH_DATA');
  });

  it('голосовой токен — тот же продовый mintTranscriptionToken, что у TMA; не-оператору — отказ', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const res = await svc.mintTranscriptionToken(OPERATOR);
    expect(deps.liveSession.mintTranscriptionToken).toHaveBeenCalledWith(OPERATOR);
    expect(res.token).toBe('rt-token');
    await expect(svc.mintTranscriptionToken(REGULAR)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fact-check делегируется сервису; не-оператору — отказ', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const res = await svc.factCheckConversation(OPERATOR, 'conv-1');
    // [fact-check-ai-fallback]: userId оператора передаётся дальше —
    // AI-фоллбек внутри требует владельца вызова (согласия/биллинг).
    expect(deps.discrepancy.factCheckConversationSegments).toHaveBeenCalledWith(OPERATOR, 'conv-1');
    expect(res.checkedSegments).toBe(1);
    await expect(svc.factCheckConversation(REGULAR, 'conv-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('очереди ещё нет — честный null, а не создание пустой при каждом просмотре', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const res = await svc.getSandboxQueue(OPERATOR);
    expect(res.queue).toBeNull();
    expect(deps.mediaReview.createQueue).not.toHaveBeenCalled();
  });
});

describe('makeSandboxWav', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: корректный WAV-заголовок — битый файл маскировал бы проблемы конфигурации под «error» провайдера', () => {
    const wav = makeSandboxWav();

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // моно
    expect(wav.readUInt32LE(24)).toBe(8000); // sample rate
    // RIFF-размер согласован с реальной длиной буфера — рассинхрон
    // здесь и есть «битый файл».
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
    // 3 секунды при 8кГц 16-бит моно.
    expect(wav.length - 44).toBe(8000 * 3 * 2);
  });

  it('в сигнале есть ненулевые сэмплы (не тишина) и нет клиппинга', () => {
    const wav = makeSandboxWav();
    let max = 0;
    for (let i = 44; i < wav.length; i += 2) {
      max = Math.max(max, Math.abs(wav.readInt16LE(i)));
    }
    expect(max).toBeGreaterThan(1000);
    expect(max).toBeLessThanOrEqual(32767);
  });
});

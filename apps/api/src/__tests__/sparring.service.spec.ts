import { SparringService } from '../sparring/sparring.service';
import { ForbiddenException, BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

// Повторный аудит 2026-08-30: SparringService получил ConsentService —
// голосовая реплика уходит внешнему провайдеру, и раньше это не
// проверялось ничем. В спеках согласие считается выданным (сценарии
// самой проверки живут в consent.service.spec.ts и
// conversations.service.spec.ts), но вызов фиксируется — тест ниже
// проверяет, что он реально происходит.
function fakeConsent(calls: string[] = []) {
  return {
    calls,
    assertAudioMayLeaveDevice: async (userId: string, projectId?: string) => {
      calls.push(`${userId}:${projectId ?? '-'}`);
    },
  };
}

function createFakePrisma() {
  const projects = new Map<string, any>();
  const people = new Map<string, any>();
  const projectPeople: any[] = [];
  const traits: any[] = [];
  const relationships: any[] = [];
  const scheduledConversations = new Map<string, any>();
  const precedents: any[] = [];
  const sessions: any[] = [];
  const messages: any[] = [];
  const voiceReplyJobs: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedProjectPerson(pp: any) { projectPeople.push(pp); },
    _seedScheduledConversation(s: any) { scheduledConversations.set(s.id, s); },
    _getScheduledConversation(id: string) { return scheduledConversations.get(id); },
    _seedTrait(t: any) { traits.push(t); },
    _seedRelationship(r: any) { relationships.push(r); },
    _seedPrecedent(p: any) { precedents.push(p); },
    _getSessions() { return sessions; },
    _getMessages() { return messages; },
    _getVoiceReplyJobs() { return voiceReplyJobs; },
    _seedVoiceReplyJob(j: any) { voiceReplyJobs.push({ id: j.id ?? nextId(), status: 'PENDING', createdAt: new Date(), ...j }); },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    projectPerson: {
      findFirst: async ({ where, include }: any) => {
        const pp = projectPeople.find((x) => x.projectId === where.projectId && x.personId === where.personId);
        if (!pp) return null;
        if (include?.person) return { ...pp, person: people.get(pp.personId) };
        return pp;
      },
    },
    personCommunicationTrait: {
      findMany: async ({ where }: any) => traits.filter((t) => t.personId === where.personId),
    },
    relationship: {
      findMany: async ({ where }: any) => relationships.filter((r) => r.personAId === where.OR[0].personAId || r.personBId === where.OR[1].personBId),
    },
    behaviorPrecedent: {
      findMany: async ({ where }: any) => precedents.filter((p) => p.personId === where.personId),
    },
    promptVersion: {
      findFirst: async () => null,
    },
    sparringSession: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), status: 'ACTIVE', endedAt: null, createdAt: new Date(), ...data };
        sessions.push(s);
        return s;
      },
      findUnique: async ({ where, include }: any) => {
        const s = sessions.find((x) => x.id === where.id);
        if (!s) return null;
        if (include?.project) return { ...s, project: projects.get(s.projectId) };
        return s;
      },
      findMany: async ({ where, include }: any) => {
        let result = sessions.filter((s) => s.projectId === where.projectId);
        if (include?.targetPerson) {
          result = result.map((s) => ({ ...s, targetPerson: s.targetPersonId ? people.get(s.targetPersonId) : null }));
        }
        return result.sort((a, b) => b.createdAt - a.createdAt);
      },
      update: async ({ where, data }: any) => {
        const idx = sessions.findIndex((s) => s.id === where.id);
        sessions[idx] = { ...sessions[idx], ...data };
        return sessions[idx];
      },
      findUniqueOrThrow: async ({ where, include }: any) => {
        const s = sessions.find((x) => x.id === where.id);
        if (!s) throw new Error('not found');
        if (include?.project) return { ...s, project: projects.get(s.projectId) };
        return s;
      },
    },
    sparringMessage: {
      create: async ({ data }: any) => {
        const m = { id: nextId(), createdAt: new Date(), ...data };
        messages.push(m);
        return m;
      },
      findMany: async ({ where }: any) => messages.filter((m) => m.sessionId === where.sessionId).sort((a, b) => a.createdAt - b.createdAt),
      count: async ({ where }: any) => messages.filter((m) => m.sessionId === where.sessionId).length,
    },
    aIProvider: {
      findUniqueOrThrow: async () => ({ id: 'provider-1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' }),
      // Повторный аудит 2026-09-01: чтение провайдера переведено на
      // requireAIProvider (findUnique + внятная ошибка вместо P2025/500).
      findUnique: async () => ({ id: 'provider-1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' }),
    },
    sparringVoiceReplyJob: {
      create: async ({ data }: any) => {
        const j = { id: nextId(), status: 'PENDING', createdAt: new Date(), ...data };
        voiceReplyJobs.push(j);
        return j;
      },
      findUnique: async ({ where }: any) => voiceReplyJobs.find((j) => (where.id ? j.id === where.id : j.externalTranscriptionJobId === where.externalTranscriptionJobId)) ?? null,
      // Пункт [stt-multi] 2026-09-02: сервис ищет по ОБОИМ написаниям
      // идентификатора (с префиксом провайдера и без) — задачи,
      // поставленные до выката, обязаны дочитаться.
      findFirst: async ({ where }: any) => {
        const filter = where.externalTranscriptionJobId;
        const ids: string[] = filter && typeof filter === 'object' && Array.isArray(filter.in) ? filter.in : [filter];
        return voiceReplyJobs.find((j) => ids.includes(j.externalTranscriptionJobId)) ?? null;
      },
      update: async ({ where, data }: any) => {
        const idx = voiceReplyJobs.findIndex((j) => j.id === where.id);
        voiceReplyJobs[idx] = { ...voiceReplyJobs[idx], ...data };
        return voiceReplyJobs[idx];
      },
      // Аудит 2026-09-02 (STT): атомарный забор PENDING → PROCESSING.
      updateMany: async ({ where, data }: any) => {
        const matching = voiceReplyJobs.filter(
          (j) => j.id === where.id && (where.status === undefined || j.status === where.status),
        );
        for (const j of matching) Object.assign(j, data);
        return { count: matching.length };
      },
    },
    // Пункт 90 (§3.26 ТЗ) — предзаготовка открывающей реплики.
    scheduledConversation: {
      findFirst: async ({ where }: any) => {
        const s = scheduledConversations.get(where.id);
        if (!s || s.projectId !== where.projectId) return null;
        return s;
      },
      findUnique: async ({ where, include }: any) => {
        const s = scheduledConversations.get(where.id);
        if (!s) return null;
        if (include?.project) return { ...s, project: projects.get(s.projectId), person: s.personId ? people.get(s.personId) : null };
        return s;
      },
      update: async ({ where, data }: any) => {
        const s = scheduledConversations.get(where.id);
        const updated = { ...s, ...data };
        scheduledConversations.set(where.id, updated);
        return updated;
      },
    },
  };
}

class FakeAIRouterService {
  responseText = '{"message":"Опровержение оппонента"}';
  aiInferenceId = 'inference-1';
  lastRequest: any = null;
  callCount = 0;

  async execute(request: any) {
    this.callCount++;
    this.lastRequest = request;
    if (request.validateOutput && !request.validateOutput(this.responseText)) {
      throw new Error('validation failed in fake router');
    }
    return { aiInferenceId: this.aiInferenceId, jobId: 'job-1', text: this.responseText };
  }
}

// Пункт 90 (§3.26 ТЗ) — фейк для голосового вывода реплик оппонента.
class FakeTextToSpeechService {
  shouldFail = false;
  synthesizeCalls: { userId: string; text: string; voiceId?: string }[] = [];

  async synthesize(userId: string, text: string, voiceId?: string) {
    this.synthesizeCalls.push({ userId, text, voiceId });
    if (this.shouldFail) {
      throw new Error('ElevenLabs недоступен (фейк)');
    }
    return { audioBase64: `base64-audio-for::${text}`, cached: false };
  }
}

// Пункт 69 (§3.26 ТЗ) — фейки для голосового ввода.
// Пункт [stt-multi] 2026-09-02: сервис ходит не в AssemblyAI напрямую,
// а в маршрутизатор STT (язык выбирает провайдера, при отказе —
// ElevenLabs). Фейк повторяет его контракт: загрузка возвращает
// провайдера вместе со ссылкой, идентификатор задачи хранится С
// ПРЕФИКСОМ, результат отдаётся уже разобранным в сегменты.
class FakeTranscriptionService {
  externalJobId = 'assemblyai-job-1';
  streamUploadCalled = false;
  submitJobCalled = false;
  getResultCalls: string[] = [];
  /** Ключ — «голый» id задачи; значение либо разобранный транскрипт,
   *  либо { error } для ветки отказа провайдера. */
  transcriptResultByJobId: Record<string, any> = {};

  get storedJobId() {
    return `assemblyai:${this.externalJobId}`;
  }

  async uploadAudio() {
    this.streamUploadCalled = true;
    return { audioUrl: 'https://fake-upload-url/audio.mp3', provider: 'assemblyai' as const };
  }

  async submitWebhookJob() {
    this.submitJobCalled = true;
    return { provider: 'assemblyai' as const, externalJobId: this.externalJobId, storedId: this.storedJobId };
  }

  discarded: string[] = [];
  async discardOrphan(hint: string | null, id: string) {
    this.discarded.push(`${hint}:${id}`);
  }
  async fetchResult(storedId: string) {
    const bare = storedId.includes(':') ? storedId.slice(storedId.indexOf(':') + 1) : storedId;
    this.getResultCalls.push(bare);
    const canned = this.transcriptResultByJobId[bare];
    if (canned?.error) throw new Error(canned.error);
    const utterances: Array<{ speaker?: string; text: string; start?: number; end?: number }> = canned?.utterances ?? [];
    return {
      language: canned?.language_code ?? null,
      segments: utterances.map((u) => ({
        diarizationLabel: u.speaker ?? 'A',
        text: u.text,
        startMs: u.start ?? 0,
        endMs: u.end ?? 0,
        confidence: null,
      })),
    };
  }
}

class FakeSecretsService {
  async resolve() {
    return 'fake-assemblyai-key';
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

async function assertThrowsAsync(fn: () => Promise<unknown>, expectedType: any, message: string) {
  try {
    await fn();
    throw new Error(`FAIL: ${message} — expected to throw ${expectedType.name}, did not throw`);
  } catch (err: any) {
    if (!(err instanceof expectedType)) {
      throw new Error(`FAIL: ${message} — expected ${expectedType.name}, got ${err?.constructor?.name}: ${err?.message}`);
    }
  }
}

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';

function seedProject(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Просить ли о повышении?', goal: null });
}

async function run() {
  // Пункт 69 (§3.26 ТЗ) — submitVoiceReply() строит webhook URL из
  // этой переменной, тот же паттерн решения, что уже применялся в
  // conversations.service.spec.ts (там же найдена и задокументирована
  // причина: выставлять один раз до всех сценариев, не внутри
  // отдельного теста — порядок выполнения не должен влиять).
  process.env.API_PUBLIC_BASE_URL = 'https://api.example.com';

  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  // ── Пункт 69: выбор архетипа (§3.26 ТЗ) ──

  test('startSession() бросает BadRequestException при archetypeType=REAL_PERSON без targetPersonId', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    await assertThrowsAsync(
      () => svc.startSession(USER_ID, PROJECT_ID, undefined, undefined, 'REAL_PERSON' as any),
      BadRequestException,
      'startSession() REAL_PERSON без targetPersonId',
    );
  });

  test('startSession() бросает BadRequestException при archetypeType=CUSTOM без описания', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    await assertThrowsAsync(
      () => svc.startSession(USER_ID, PROJECT_ID, undefined, undefined, 'CUSTOM' as any),
      BadRequestException,
      'startSession() CUSTOM без customArchetypeDescription',
    );
  });

  test('startSession() подмешивает описание архетипа в промпт (например, TROUBLEMAKER)', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    const svc = new SparringService(prisma as any, fakeRouter as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    await svc.startSession(USER_ID, PROJECT_ID, undefined, undefined, 'TROUBLEMAKER' as any);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('скандалист'), true, 'описание архетипа TROUBLEMAKER попало в промпт');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: startSession() сохраняет archetypeType и снапшот voiceId на сессии', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    const session = await svc.startSession(USER_ID, PROJECT_ID, undefined, undefined, 'JEALOUS_SPOUSE' as any);
    assertEqual(session.archetypeType, 'JEALOUS_SPOUSE', 'архетип сохранён');
    assertEqual(typeof session.voiceId, 'string', 'voiceId проставлен (маппинг архетип→голос)');
  });

  test('startSession() с CUSTOM сохраняет customArchetypeDescription и подмешивает его в промпт', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    const svc = new SparringService(prisma as any, fakeRouter as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    const session = await svc.startSession(USER_ID, PROJECT_ID, undefined, undefined, 'CUSTOM' as any, 'Строгий начальник старой закалки');
    assertEqual(session.customArchetypeDescription, 'Строгий начальник старой закалки', 'кастомное описание сохранено');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Строгий начальник старой закалки'), true, 'кастомное описание попало в промпт');
  });

  test('startSession() без архетипа — обратная совместимость, archetypeType=null', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    const session = await svc.startSession(USER_ID, PROJECT_ID);
    assertEqual(session.archetypeType, null, 'без архетипа — null, старое поведение не сломано');
  });

  test('reply() подмешивает контекст архетипа во все последующие реплики, не только в первую', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    const svc = new SparringService(prisma as any, fakeRouter as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    const session = await svc.startSession(USER_ID, PROJECT_ID, undefined, undefined, 'LAWYER' as any);
    await svc.reply(USER_ID, session.id, 'Мой ответ оппоненту');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('юрист'), true, 'описание архетипа LAWYER попало в промпт reply(), не только startSession()');
  });

  // ── Пункт 69: голосовой ввод (§3.26 ТЗ) ──

  test('submitVoiceReply() бросает NotFoundException для чужой сессии', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, new FakeTranscriptionService() as any, new FakeSecretsService() as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    await assertThrowsAsync(
      () => svc.submitVoiceReply(USER_ID, 'nonexistent-session', 'https://fake/audio.mp3'),
      NotFoundException,
      'submitVoiceReply() на несуществующую/чужую сессию',
    );
  });

  test('КЛЮЧЕВОЙ ТЕСТ (повторный аудит 2026-08-30): голосовая реплика не уходит провайдеру без проверки согласий', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const calls: string[] = [];
    const consent = {
      assertAudioMayLeaveDevice: async () => {
        calls.push('checked');
        throw new ForbiddenException('Consent required: RECORDING');
      },
    };
    const transcription = { streamUpload: async () => { calls.push('UPLOADED'); return 'url'; } };
    const svc = new SparringService(
      prisma as any, new FakeAIRouterService() as any, transcription as any, {} as any,
      new FakeTextToSpeechService() as any, consent as any,
    );
    const session = await prisma.sparringSession.create({
      data: { projectId: PROJECT_ID, status: 'ACTIVE', archetypeType: 'TROUBLEMAKER' },
    });

    await assertThrowsAsync(
      () => svc.streamUploadVoiceReply(USER_ID, session.id, null as any),
      ForbiddenException,
      'streamUploadVoiceReply() без согласий',
    );
    // Проверка ДО отправки байтов, а не после: иначе аудио уже у
    // провайдера к моменту отказа — ровно та ошибка, которую аудит
    // нашёл в ConversationsService.streamUploadAudio().
    assertEqual(calls, ['checked'], 'ни одной загрузки при отсутствии согласия');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: submitVoiceReply() запускает транскрибацию и создаёт PENDING job', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeTranscription = new FakeTranscriptionService();
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, fakeTranscription as any, new FakeSecretsService() as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    const session = await svc.startSession(USER_ID, PROJECT_ID);
    const job = await svc.submitVoiceReply(USER_ID, session.id, 'https://fake/audio.mp3');

    assertEqual(job.status, 'PENDING', 'job создан в статусе PENDING — транскрибация асинхронна, не мгновенна');
    assertEqual(fakeTranscription.submitJobCalled, true, 'AssemblyAI job реально запущен');
  });

  test('handleVoiceReplyWebhook() при успехе создаёт оба сообщения и переводит job в COMPLETED', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeTranscription = new FakeTranscriptionService();
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, fakeTranscription as any, new FakeSecretsService() as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    const session = await svc.startSession(USER_ID, PROJECT_ID);
    const job = await svc.submitVoiceReply(USER_ID, session.id, 'https://fake/audio.mp3');

    fakeTranscription.transcriptResultByJobId[fakeTranscription.externalJobId] = {
      status: 'completed',
      id: fakeTranscription.externalJobId,
      utterances: [{ speaker: 'A', text: 'Мой голосовой ответ', start: 0, end: 1000 }],
    };
    // Финальный аудит 2026-08-30: реальный вебхук несёт только transcript_id/status.
    await svc.handleVoiceReplyWebhook({ transcript_id: fakeTranscription.externalJobId, status: 'completed' } as any);

    const updatedJob = prisma._getVoiceReplyJobs().find((j: any) => j.id === job.id);
    assertEqual(updatedJob.status, 'COMPLETED', 'job переведён в COMPLETED');
    assertEqual(updatedJob.userMessageId !== null, true, 'ID сообщения пользователя сохранён');
    assertEqual(updatedJob.opponentMessageId !== null, true, 'ID ответа оппонента сохранён — reply() реально вызван из webhook');

    const messages = prisma._getMessages();
    const userMsg = messages.find((m: any) => m.id === updatedJob.userMessageId);
    assertEqual(userMsg.text, 'Мой голосовой ответ', 'транскрибированный текст стал текстом реплики пользователя');
  });

  test('РЕГРЕССИЯ (аудит 2026-09-02, STT): две ОДНОВРЕМЕННЫЕ доставки вебхука создают ОДНУ пару реплик — джобу забирает атомарный claim', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeTranscription = new FakeTranscriptionService();
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, fakeTranscription as any, new FakeSecretsService() as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    const session = await svc.startSession(USER_ID, PROJECT_ID);
    const job = await svc.submitVoiceReply(USER_ID, session.id, 'https://fake/audio.mp3');
    fakeTranscription.transcriptResultByJobId[fakeTranscription.externalJobId] = {
      status: 'completed',
      id: fakeTranscription.externalJobId,
      utterances: [{ speaker: 'A', text: 'Повторно доставленная реплика', start: 0, end: 1000 }],
    };
    const messagesBefore = prisma._getMessages().length;

    // Обе доставки стартуют до того, как первая дошла до записи статуса
    // — ровно ситуация «провайдер ретраит на таймаут нашего ответа».
    const payload = { transcript_id: fakeTranscription.externalJobId, status: 'completed' } as any;
    await Promise.all([svc.handleVoiceReplyWebhook(payload), svc.handleVoiceReplyWebhook(payload)]);

    const updatedJob = prisma._getVoiceReplyJobs().find((j: any) => j.id === job.id);
    assertEqual(updatedJob.status, 'COMPLETED', 'джоба завершена один раз');
    assertEqual(prisma._getMessages().length - messagesBefore, 2, 'ровно одна пара реплик (пользователь + оппонент), а не две');
  });

  test('РЕГРЕССИЯ (отставание миграции): база без значения PROCESSING — реплика всё равно обрабатывается, а не 500', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeTranscription = new FakeTranscriptionService();
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, fakeTranscription as any, new FakeSecretsService() as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    const session = await svc.startSession(USER_ID, PROJECT_ID);
    const job = await svc.submitVoiceReply(USER_ID, session.id, 'https://fake/audio.mp3');
    fakeTranscription.transcriptResultByJobId[fakeTranscription.externalJobId] = {
      status: 'completed', id: fakeTranscription.externalJobId,
      utterances: [{ speaker: 'A', text: 'реплика до миграции', start: 0, end: 1000 }],
    };
    // Postgres 22P02 — так падает updateMany с ещё не добавленным значением.
    prisma.sparringVoiceReplyJob.updateMany = async () => { throw new Error('invalid input value for enum "SparringVoiceReplyStatus": "PROCESSING"'); };

    await svc.handleVoiceReplyWebhook({ transcript_id: fakeTranscription.externalJobId, status: 'completed' } as any);

    const updated = prisma._getVoiceReplyJobs().find((j: any) => j.id === job.id);
    assertEqual(updated.status, 'COMPLETED', 'код впереди миграции — работаем в прежнем режиме, реплика создана');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: handleVoiceReplyWebhook() при ошибке AssemblyAI переводит job в FAILED, не создаёт сообщений', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeTranscription = new FakeTranscriptionService();
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, fakeTranscription as any, new FakeSecretsService() as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    const session = await svc.startSession(USER_ID, PROJECT_ID);
    const job = await svc.submitVoiceReply(USER_ID, session.id, 'https://fake/audio.mp3');
    const messagesBefore = prisma._getMessages().length;

    fakeTranscription.transcriptResultByJobId[fakeTranscription.externalJobId] = { error: 'audio too short' };
    await svc.handleVoiceReplyWebhook({ transcript_id: fakeTranscription.externalJobId, status: 'error' } as any);

    const updatedJob = prisma._getVoiceReplyJobs().find((j: any) => j.id === job.id);
    assertEqual(updatedJob.status, 'FAILED', 'job честно переведён в FAILED');
    assertEqual(updatedJob.errorMessage, 'audio too short', 'причина ошибки сохранена, не потеряна');
    assertEqual(prisma._getMessages().length, messagesBefore, 'ни одного сообщения не создано при ошибке транскрибации');
  });

  test('handleVoiceReplyWebhook() честно фейлит job при пустой транскрипции, не создаёт пустую реплику', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeTranscription = new FakeTranscriptionService();
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, fakeTranscription as any, new FakeSecretsService() as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    const session = await svc.startSession(USER_ID, PROJECT_ID);
    const job = await svc.submitVoiceReply(USER_ID, session.id, 'https://fake/audio.mp3');

    fakeTranscription.transcriptResultByJobId[fakeTranscription.externalJobId] = { status: 'completed', id: fakeTranscription.externalJobId, utterances: [] };
    await svc.handleVoiceReplyWebhook({ transcript_id: fakeTranscription.externalJobId, status: 'completed' } as any);

    const updatedJob = prisma._getVoiceReplyJobs().find((j: any) => j.id === job.id);
    assertEqual(updatedJob.status, 'FAILED', 'пустая транскрипция честно помечена FAILED, не создаёт пустую реплику');
  });

  test('handleVoiceReplyWebhook() молча игнорирует неизвестный externalTranscriptionJobId (не роняет обработчик)', async () => {
    const prisma = createFakePrisma();
    const stt = new FakeTranscriptionService();
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, stt as any, new FakeSecretsService() as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    // Не должно бросить исключение — AssemblyAI будет ретраить webhook на не-200, важно не падать на неизвестном job.
    await svc.handleVoiceReplyWebhook({ id: 'unknown-job-id', status: 'completed' } as any);
    // Аудит 2026-09-02 (продолжение): бесхозная задача убирается у
    // провайдера (форма { id } — Soniox).
    assertEqual(stt.discarded, ['soniox:unknown-job-id'], 'уборка бесхозной задачи у провайдера');
  });

  test('РЕГРЕСІЯ (фінальний аудит 2026-08-30): handleVoiceReplyWebhook() без transcript_id — не падає, GET до AssemblyAI не робиться', async () => {
    const prisma = createFakePrisma();
    const fakeTranscription = new FakeTranscriptionService();
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, fakeTranscription as any, new FakeSecretsService() as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    await svc.handleVoiceReplyWebhook({ status: 'completed' } as any);
    assertEqual(fakeTranscription.getResultCalls, [], 'без transcript_id зайвий зовнішній виклик не робиться');
  });

  test('getVoiceReplyStatus() бросает NotFoundException для job из другой сессии', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeTranscription = new FakeTranscriptionService();
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, fakeTranscription as any, new FakeSecretsService() as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    const sessionA = await svc.startSession(USER_ID, PROJECT_ID);
    const sessionB = await svc.startSession(USER_ID, PROJECT_ID);
    const job = await svc.submitVoiceReply(USER_ID, sessionA.id, 'https://fake/audio.mp3');

    await assertThrowsAsync(
      () => svc.getVoiceReplyStatus(USER_ID, sessionB.id, job.id),
      NotFoundException,
      'getVoiceReplyStatus() с job, принадлежащим другой сессии',
    );
  });

  test('startSession() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    await assertThrowsAsync(() => svc.startSession(USER_ID, PROJECT_ID), NotFoundException, 'startSession() на чужой проект');
  });

  test('startSession() без targetPersonId работает (общий оппонент)', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    const svc = new SparringService(prisma as any, fakeRouter as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    const session = await svc.startSession(USER_ID, PROJECT_ID);
    assertEqual(session.targetPersonId, null, 'общий оппонент без привязки к человеку');
    assertEqual(session.messages.length, 1, 'первое сообщение оппонента создано');
    assertEqual(session.messages[0].role, 'OPPONENT', 'первое сообщение — от оппонента');
  });

  test('startSession() с targetPersonId подмешивает коммуникационный профиль/связи/прецеденты в промпт', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedPerson({ id: 'person-1', displayName: 'Начальник Иван' });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: 'person-1' });
    prisma._seedTrait({ personId: 'person-1', traitType: 'RESPONDS_TO_DATA', value: 'Просит конкретные цифры' });
    prisma._seedRelationship({ personAId: 'person-1', personBId: 'other', label: 'муж финансового директора' });
    prisma._seedPrecedent({ personId: 'person-1', precedentDescription: 'В марте отказал без объяснений' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new SparringService(prisma as any, fakeRouter as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    await svc.startSession(USER_ID, PROJECT_ID, 'person-1');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Начальник Иван'), true, 'имя попало в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Просит конкретные цифры'), true, 'профиль попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('муж финансового директора'), true, 'связь попала в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('В марте отказал без объяснений'), true, 'прецедент попал в промпт');
  });

  test('startSession() бросает NotFoundException, если targetPersonId не привязан к проекту', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    await assertThrowsAsync(
      () => svc.startSession(USER_ID, PROJECT_ID, 'not-in-project'),
      NotFoundException,
      'startSession() с чужим/несуществующим targetPersonId',
    );
  });

  test('reply() бросает NotFoundException для чужой сессии', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    await prisma.sparringSession.create({ data: { projectId: PROJECT_ID } });
    const [session] = prisma._getSessions();
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    await assertThrowsAsync(() => svc.reply(USER_ID, session.id, 'x'), NotFoundException, 'reply() на чужую сессию');
  });

  test('reply() бросает BadRequestException для уже завершённой сессии', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    const session = await svc.startSession(USER_ID, PROJECT_ID);
    await svc.endSession(USER_ID, session.id);
    await assertThrowsAsync(() => svc.reply(USER_ID, session.id, 'x'), BadRequestException, 'reply() на завершённую сессию');
  });

  test('reply() бросает BadRequestException для пустого текста', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    const session = await svc.startSession(USER_ID, PROJECT_ID);
    await assertThrowsAsync(() => svc.reply(USER_ID, session.id, '   '), BadRequestException, 'reply() с пустым текстом');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: reply() передаёт ПОЛНУЮ историю сообщений в промпт, не только последнее', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeRouter = new FakeAIRouterService();
    const svc = new SparringService(prisma as any, fakeRouter as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    const session = await svc.startSession(USER_ID, PROJECT_ID); // первое сообщение оппонента
    await svc.reply(USER_ID, session.id, 'Мой первый ответ на возражение');
    await svc.reply(USER_ID, session.id, 'Мой второй ответ, уточняющий первый');

    // Промпт третьего вызова (второй reply) должен содержать ОБА
    // предыдущих ответа пользователя, не только последний.
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Мой первый ответ на возражение'), true, 'первый ответ пользователя виден оппоненту во втором reply()');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Мой второй ответ, уточняющий первый'), true, 'второй ответ тоже виден');
    assertEqual(fakeRouter.callCount, 3, 'три AI-вызова всего: старт + два reply');
  });

  test('reply() создаёт и USER-сообщение, и ответ OPPONENT', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    const session = await svc.startSession(USER_ID, PROJECT_ID);

    const [userMsg, opponentMsg] = await svc.reply(USER_ID, session.id, 'Мой ответ');
    assertEqual(userMsg.role, 'USER', 'первое — от пользователя');
    assertEqual(userMsg.text, 'Мой ответ', 'текст сохранён');
    assertEqual(opponentMsg.role, 'OPPONENT', 'второе — ответ оппонента');
  });

  test('reply() бросает BadRequestException при достижении лимита сообщений', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    const session = await svc.startSession(USER_ID, PROJECT_ID);

    // Досеиваем сообщения напрямую, чтобы не делать 40 реальных вызовов.
    for (let i = 0; i < 40; i++) {
      prisma._getMessages().push({ id: `msg-${i}`, sessionId: session.id, role: 'USER', text: 'x', createdAt: new Date() });
    }

    await assertThrowsAsync(() => svc.reply(USER_ID, session.id, 'ещё один ответ'), BadRequestException, 'reply() при достижении лимита сообщений');
  });

  test('endSession() проставляет status=ENDED и endedAt', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    const session = await svc.startSession(USER_ID, PROJECT_ID);

    const ended = await svc.endSession(USER_ID, session.id);
    assertEqual(ended.status, 'ENDED', 'статус изменён');
    assertEqual(ended.endedAt !== null, true, 'endedAt проставлен');
  });

  test('listSessions() возвращает сессии проекта', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    await svc.startSession(USER_ID, PROJECT_ID);
    await svc.startSession(USER_ID, PROJECT_ID);

    const list = await svc.listSessions(USER_ID, PROJECT_ID);
    assertEqual(list.length, 2, 'обе сессии видны');
  });

  test('getSession() возвращает сессию со всеми сообщениями по порядку', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    const session = await svc.startSession(USER_ID, PROJECT_ID);
    await svc.reply(USER_ID, session.id, 'Ответ пользователя');

    const full = await svc.getSession(USER_ID, session.id);
    assertEqual(full.messages.length, 3, 'старт + ответ пользователя + ответ оппонента = 3 сообщения');
  });

  test('callOpponent() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new SparringService(prisma as any, failingRouter as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    await assertThrowsAsync(() => svc.startSession(USER_ID, PROJECT_ID), BadGatewayException, 'startSession() при недоступности провайдера');
  });

  // ── Пункт 90 (§3.26 ТЗ): голосовой вывод + предзаготовка ──

  test('КЛЮЧЕВОЙ ТЕСТ: startSession() синтезирует и сохраняет аудио открывающей реплики', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeTts = new FakeTextToSpeechService();
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, fakeTts as any, fakeConsent() as any);

    const result = await svc.startSession(USER_ID, PROJECT_ID);
    assertEqual(result.messages[0].audioBase64, 'base64-audio-for::Опровержение оппонента', 'аудио реально синтезировано и сохранено на сообщении');
    assertEqual(fakeTts.synthesizeCalls.length, 1, 'synthesize() вызван ровно один раз для открывающей реплики');
  });

  test('startSession() честно сохраняет audioBase64=null, если синтез упал — диалог не блокируется', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeTts = new FakeTextToSpeechService();
    fakeTts.shouldFail = true;
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, fakeTts as any, fakeConsent() as any);

    const result = await svc.startSession(USER_ID, PROJECT_ID);
    assertEqual(result.messages[0].audioBase64, null, 'сбой синтеза — честный null, не исключение наружу');
    assertEqual(typeof result.messages[0].text, 'string', 'текст реплики всё равно доступен независимо от звука');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: reply() синтезирует аудио с voiceId именно этой сессии', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeTts = new FakeTextToSpeechService();
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, fakeTts as any, fakeConsent() as any);

    const started = await svc.startSession(USER_ID, PROJECT_ID);
    fakeTts.synthesizeCalls = []; // сбрасываем вызов из startSession(), интересует именно reply()
    await svc.reply(USER_ID, started.id, 'Мой ответ оппоненту');

    assertEqual(fakeTts.synthesizeCalls.length, 1, 'synthesize() вызван для реплики оппонента в reply()');
    assertEqual(fakeTts.synthesizeCalls[0].voiceId, started.voiceId, 'использован voiceId именно этой сессии (снапшот, не пересчитанный заново)');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: preGenerateSparringOpener() сохраняет текст и аудио на ScheduledConversation, не создаёт SparringSession', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedScheduledConversation({ id: 'sched-1', projectId: PROJECT_ID, personId: null, scheduledAt: new Date() });
    const fakeTts = new FakeTextToSpeechService();
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, fakeTts as any, fakeConsent() as any);

    await svc.preGenerateSparringOpener('sched-1', USER_ID);

    const updated = prisma._getScheduledConversation('sched-1');
    assertEqual(updated.preGeneratedSparringOpenerText, 'Опровержение оппонента', 'текст предзаготовлен и сохранён');
    assertEqual(updated.preGeneratedSparringOpenerAudio, 'base64-audio-for::Опровержение оппонента', 'аудио предзаготовлено и сохранено');
    assertEqual((await svc.listSessions(USER_ID, PROJECT_ID)).length, 0, 'предзаготовка НЕ создаёт реальную SparringSession — только кэш на встрече');
  });

  test('preGenerateSparringOpener() честно ничего не делает, если встречу удалили до обработки', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeTts = new FakeTextToSpeechService();
    const svc = new SparringService(prisma as any, new FakeAIRouterService() as any, {} as any, {} as any, fakeTts as any, fakeConsent() as any);

    await svc.preGenerateSparringOpener('nonexistent-sched', USER_ID); // не должно бросить исключение
    assertEqual(fakeTts.synthesizeCalls.length, 0, 'ни AI, ни TTS не вызваны для несуществующей встречи');
  });

  test('preGenerateSparringOpener() честно ничего не сохраняет, если сама генерация текста упала', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedScheduledConversation({ id: 'sched-1', projectId: PROJECT_ID, personId: null, scheduledAt: new Date() });
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const fakeTts = new FakeTextToSpeechService();
    const svc = new SparringService(prisma as any, failingRouter as any, {} as any, {} as any, fakeTts as any, fakeConsent() as any);

    await svc.preGenerateSparringOpener('sched-1', USER_ID); // не должно бросить исключение наружу
    const updated = prisma._getScheduledConversation('sched-1');
    assertEqual(updated.preGeneratedSparringOpenerText, undefined, 'без успешной генерации текста — ничего не сохранено, не мусорная частичная запись');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: startSession() переиспользует предзаготовленную реплику мгновенно, не делает повторный AI-вызов', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedScheduledConversation({
      id: 'sched-1',
      projectId: PROJECT_ID,
      personId: null,
      scheduledAt: new Date(),
      preGeneratedSparringOpenerText: 'Предзаготовленная реплика',
      preGeneratedSparringOpenerAudio: 'предзаготовленное-аудио',
    });
    const fakeRouter = new FakeAIRouterService();
    const fakeTts = new FakeTextToSpeechService();
    const svc = new SparringService(prisma as any, fakeRouter as any, {} as any, {} as any, fakeTts as any, fakeConsent() as any);

    const result = await svc.startSession(USER_ID, PROJECT_ID, undefined, undefined, undefined, undefined, 'sched-1');

    assertEqual(result.messages[0].text, 'Предзаготовленная реплика', 'использован закэшированный текст, не сгенерирован заново');
    assertEqual(result.messages[0].audioBase64, 'предзаготовленное-аудио', 'использовано закэшированное аудио, не синтезировано заново');
    assertEqual(fakeRouter.callCount, 0, 'AI НЕ вызывался — реальная экономия, не просто совпадение результата');
    assertEqual(fakeTts.synthesizeCalls.length, 0, 'TTS НЕ вызывался — аудио взято из кэша');
  });

  test('startSession() генерирует заново, если предзаготовки для scheduledConversationId нет', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedScheduledConversation({ id: 'sched-1', projectId: PROJECT_ID, personId: null, scheduledAt: new Date() }); // без preGeneratedSparringOpenerText
    const fakeRouter = new FakeAIRouterService();
    const svc = new SparringService(prisma as any, fakeRouter as any, {} as any, {} as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    await svc.startSession(USER_ID, PROJECT_ID, undefined, undefined, undefined, undefined, 'sched-1');
    assertEqual(fakeRouter.callCount, 1, 'без предзаготовки — обычная генерация, AI вызван как раньше');
  });

  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  const failed = results.filter((r) => r.error);
  console.log(`\nSparringService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  // Падение вне тела теста (в фейке, в модульном коде) — это
  // провал файла, а не тихий unhandled rejection.
  console.error(err);
  process.exit(1);
});

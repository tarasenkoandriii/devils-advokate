import { MaterialChatService } from '../material-chat/material-chat.service';
import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const materials = new Map<string, any>();
  const versions: any[] = [];
  const sessions: any[] = [];
  const messages: any[] = [];
  const voiceReplyJobs: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedMaterial(m: any) { materials.set(m.id, m); },
    _seedVersion(v: any) { versions.push({ id: v.id ?? nextId(), createdAt: new Date(), ...v }); },
    _getSessions() { return sessions; },
    _getMessages() { return messages; },
    _getVoiceReplyJobs() { return voiceReplyJobs; },
    _seedVoiceReplyJob(j: any) { voiceReplyJobs.push({ id: j.id ?? nextId(), status: 'PENDING', createdAt: new Date(), ...j }); },
    _seedSession(s: any) { sessions.push({ id: s.id ?? nextId(), status: 'ACTIVE', endedAt: null, refinedEditPrompt: null, createdAt: new Date(), ...s }); },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    workingMaterial: {
      findFirst: async ({ where }: any) => {
        const m = materials.get(where.id);
        if (!m || m.projectId !== where.projectId) return null;
        const materialVersions = versions.filter((v) => v.workingMaterialId === m.id).sort((a, b) => b.versionNumber - a.versionNumber).slice(0, 1);
        return { ...m, versions: materialVersions };
      },
      findUniqueOrThrow: async ({ where, include }: any) => {
        const m = materials.get(where.id);
        if (!m) throw new Error('not found');
        if (include?.versions) {
          const materialVersions = versions.filter((v) => v.workingMaterialId === m.id).sort((a, b) => b.versionNumber - a.versionNumber).slice(0, 1);
          return { ...m, versions: materialVersions };
        }
        return m;
      },
    },
    promptVersion: {
      findFirst: async () => null,
    },
    materialChatSession: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), status: 'ACTIVE', endedAt: null, refinedEditPrompt: null, createdAt: new Date(), ...data };
        sessions.push(s);
        return s;
      },
      findUnique: async ({ where, include }: any) => {
        const s = sessions.find((x) => x.id === where.id);
        if (!s) return null;
        if (include?.workingMaterial) {
          const m = materials.get(s.workingMaterialId);
          return { ...s, workingMaterial: { ...m, project: projects.get(m.projectId) } };
        }
        return s;
      },
      findMany: async ({ where }: any) => sessions.filter((s) => s.workingMaterialId === where.workingMaterialId).sort((a, b) => b.createdAt - a.createdAt),
      update: async ({ where, data }: any) => {
        const idx = sessions.findIndex((s) => s.id === where.id);
        sessions[idx] = { ...sessions[idx], ...data };
        return sessions[idx];
      },
      findUniqueOrThrow: async ({ where, include }: any) => {
        const s = sessions.find((x) => x.id === where.id);
        if (!s) throw new Error('not found');
        if (include?.workingMaterial) {
          const m = materials.get(s.workingMaterialId);
          return { ...s, workingMaterial: { ...m, project: projects.get(m.projectId) } };
        }
        return s;
      },
    },
    materialChatMessage: {
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
    materialChatVoiceReplyJob: {
      create: async ({ data }: any) => {
        const j = { id: nextId(), status: 'PENDING', createdAt: new Date(), ...data };
        voiceReplyJobs.push(j);
        return j;
      },
      findUnique: async ({ where }: any) => voiceReplyJobs.find((j) => (where.id ? j.id === where.id : j.externalTranscriptionJobId === where.externalTranscriptionJobId)) ?? null,
      // Пункт [stt-multi] 2026-09-02 — поиск по обоим написаниям id.
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
  };
}

class FakeAIRouterService {
  responseText = '{"message":"Уточните, пожалуйста, какой именно пункт вызывает беспокойство?","updatedEditPrompt":null}';
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
const MATERIAL_ID = 'material-1';

function seedBase(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
  prisma._seedMaterial({ id: MATERIAL_ID, projectId: PROJECT_ID, title: 'ТЗ для инвестора' });
}

// Аудит 2026-09-01 (тайпчек спек): MaterialChatService получил шестым
// аргументом ConsentService (голос уходит внешнему провайдеру), но
// спеки продолжали конструировать его пятью — спеки не были в
// тайпчеке, и рассинхрон был не виден. В сценариях согласие считается
// выданным; сама проверка живёт в consent.service.spec.ts, а факт
// вызова фиксирует ключевой тест ниже — по образцу sparring.
function fakeConsent(calls: string[] = []) {
  return {
    calls,
    assertAudioMayLeaveDevice: async (userId: string, projectId?: string) => {
      calls.push(`${userId}:${projectId ?? '-'}`);
    },
  };
}

function makeService(prisma: any, aiRouter: any = new FakeAIRouterService(), tts: any = new FakeTextToSpeechService()) {
  return new MaterialChatService(prisma, aiRouter, {} as any, {} as any, tts, fakeConsent() as any);
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('startSession() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    const svc = makeService(prisma);
    await assertThrowsAsync(() => svc.startSession(USER_ID, 'other-project', MATERIAL_ID), NotFoundException, 'startSession() на чужой проект');
  });

  test('startSession() бросает NotFoundException для несуществующего материала', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const svc = makeService(prisma);
    await assertThrowsAsync(() => svc.startSession(USER_ID, PROJECT_ID, 'nonexistent'), NotFoundException, 'startSession() на несуществующий материал');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: startSession() создаёт сессию с первым ASSISTANT-сообщением и его аудио', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    const fakeTts = new FakeTextToSpeechService();
    const svc = makeService(prisma, new FakeAIRouterService(), fakeTts);

    const result = await svc.startSession(USER_ID, PROJECT_ID, MATERIAL_ID);
    assertEqual(result.messages.length, 1, 'одно открывающее сообщение создано');
    assertEqual(result.messages[0].role, 'ASSISTANT', 'роль — ASSISTANT, не USER и не OPPONENT');
    assertEqual(result.messages[0].audioBase64, 'base64-audio-for::Уточните, пожалуйста, какой именно пункт вызывает беспокойство?', 'аудио синтезировано и сохранено');
  });

  test('startSession() подмешивает критику и editPrompt последней версии материала в промпт', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedVersion({ workingMaterialId: MATERIAL_ID, versionNumber: 1, extractedText: 'x', critique: 'Слабый аргумент в пункте 3', editPrompt: 'Усильте пункт 3' });
    const fakeRouter = new FakeAIRouterService();
    const svc = makeService(prisma, fakeRouter);

    await svc.startSession(USER_ID, PROJECT_ID, MATERIAL_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Слабый аргумент в пункте 3'), true, 'критика попала в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Усильте пункт 3'), true, 'editPrompt попал в промпт');
  });

  test('startSession() честно сохраняет audioBase64=null, если синтез упал', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    const fakeTts = new FakeTextToSpeechService();
    fakeTts.shouldFail = true;
    const svc = makeService(prisma, new FakeAIRouterService(), fakeTts);

    const result = await svc.startSession(USER_ID, PROJECT_ID, MATERIAL_ID);
    assertEqual(result.messages[0].audioBase64, null, 'сбой синтеза — честный null, диалог не блокируется');
  });

  test('reply() бросает NotFoundException для чужой сессии', async () => {
    const prisma = createFakePrisma();
    const svc = makeService(prisma);
    await assertThrowsAsync(() => svc.reply(USER_ID, 'nonexistent-session', 'текст'), NotFoundException, 'reply() на чужую сессию');
  });

  test('reply() бросает BadRequestException для пустого текста', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedSession({ id: 'sess-1', workingMaterialId: MATERIAL_ID });
    const svc = makeService(prisma);
    await assertThrowsAsync(() => svc.reply(USER_ID, 'sess-1', '   '), BadRequestException, 'reply() с пустым текстом');
  });

  test('reply() бросает BadRequestException для уже завершённой сессии', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedSession({ id: 'sess-1', workingMaterialId: MATERIAL_ID, status: 'ENDED' });
    const svc = makeService(prisma);
    await assertThrowsAsync(() => svc.reply(USER_ID, 'sess-1', 'текст'), BadRequestException, 'reply() на завершённую сессию');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: reply() создаёт и USER-, и ASSISTANT-сообщение', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedSession({ id: 'sess-1', workingMaterialId: MATERIAL_ID });
    const svc = makeService(prisma);

    const [userMessage, assistantReply] = await svc.reply(USER_ID, 'sess-1', 'Меня беспокоит пункт про сроки');
    assertEqual(userMessage.role, 'USER', 'первое сообщение — от пользователя');
    assertEqual(assistantReply.role, 'ASSISTANT', 'второе — от помощника');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: reply() передаёт ПОЛНУЮ историю сообщений в промпт', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedSession({ id: 'sess-1', workingMaterialId: MATERIAL_ID });
    prisma._seedMaterial({ id: MATERIAL_ID, projectId: PROJECT_ID, title: 'ТЗ' }); // без версий — ок
    const fakeRouter = new FakeAIRouterService();
    const svc = makeService(prisma, fakeRouter);

    await svc.reply(USER_ID, 'sess-1', 'Первое сообщение');
    await svc.reply(USER_ID, 'sess-1', 'Второе сообщение, уточняющее первое');

    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Первое сообщение'), true, 'история включает первое сообщение, не только последнее');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Второе сообщение'), true, 'и текущее тоже включено');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: reply() обновляет refinedEditPrompt на сессии, когда AI его вернул', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedSession({ id: 'sess-1', workingMaterialId: MATERIAL_ID });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '{"message":"Вот обновлённый промпт","updatedEditPrompt":"Усильте пункт про сроки, добавив конкретные даты"}';
    const svc = makeService(prisma, fakeRouter);

    await svc.reply(USER_ID, 'sess-1', 'Меня беспокоят сроки');

    const session = prisma._getSessions().find((s: any) => s.id === 'sess-1');
    assertEqual(session.refinedEditPrompt, 'Усильте пункт про сроки, добавив конкретные даты', 'черновик промпта реально обновлён на сессии');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: reply() НЕ сбрасывает refinedEditPrompt, если AI не вернул обновление на этом ходу', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedSession({ id: 'sess-1', workingMaterialId: MATERIAL_ID, refinedEditPrompt: 'Уже существующий черновик' });
    const fakeRouter = new FakeAIRouterService(); // responseText без updatedEditPrompt (null по умолчанию)
    const svc = makeService(prisma, fakeRouter);

    await svc.reply(USER_ID, 'sess-1', 'Ещё один уточняющий вопрос');

    const session = prisma._getSessions().find((s: any) => s.id === 'sess-1');
    assertEqual(session.refinedEditPrompt, 'Уже существующий черновик', 'черновик не сброшен и не перезаписан пустотой при отсутствии обновления');
  });

  test('reply() бросает BadRequestException при достижении лимита сообщений', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedSession({ id: 'sess-1', workingMaterialId: MATERIAL_ID });
    for (let i = 0; i < 40; i++) {
      await (prisma as any).materialChatMessage.create({ data: { sessionId: 'sess-1', role: i % 2 === 0 ? 'USER' : 'ASSISTANT', text: 'x' } });
    }
    const svc = makeService(prisma);
    await assertThrowsAsync(() => svc.reply(USER_ID, 'sess-1', 'ещё одно'), BadRequestException, 'reply() при достижении лимита 40 сообщений');
  });

  test('endSession() проставляет status=ENDED и endedAt', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedSession({ id: 'sess-1', workingMaterialId: MATERIAL_ID });
    const svc = makeService(prisma);

    const ended = await svc.endSession(USER_ID, 'sess-1');
    assertEqual(ended.status, 'ENDED', 'статус изменён');
    assertEqual(ended.endedAt !== null, true, 'endedAt проставлен');
  });

  test('listSessions() возвращает сессии материала', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedSession({ id: 'sess-1', workingMaterialId: MATERIAL_ID });
    prisma._seedSession({ id: 'sess-2', workingMaterialId: MATERIAL_ID });
    const svc = makeService(prisma);

    const list = await svc.listSessions(USER_ID, PROJECT_ID, MATERIAL_ID);
    assertEqual(list.length, 2, 'обе сессии материала видны');
  });

  test('getSession() возвращает сессию со всеми сообщениями по порядку', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedSession({ id: 'sess-1', workingMaterialId: MATERIAL_ID });
    const svc = makeService(prisma);

    await svc.reply(USER_ID, 'sess-1', 'Сообщение');
    const full = await svc.getSession(USER_ID, 'sess-1');
    assertEqual(full.messages.length, 2, 'оба сообщения (USER + ASSISTANT) видны');
  });

  test('callAssistant() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = makeService(prisma, failingRouter);
    await assertThrowsAsync(() => svc.startSession(USER_ID, PROJECT_ID, MATERIAL_ID), BadGatewayException, 'startSession() при недоступности AI-провайдера');
  });

  // ── Финальный аудит 2026-08-30 — handleVoiceReplyWebhook() не имел вообще
  // ── ни одного теста; заодно у него был тот же баг с полем payload.id/
  // ── payload.utterances, что в sparring/conversations (реальный вебхук
  // ── AssemblyAI несёт только transcript_id/status, не полный результат).

  // Пункт [stt-multi] 2026-09-02: сервис ходит в маршрутизатор STT, а
  // не в AssemblyAI напрямую. Фейк отдаёт уже разобранный транскрипт
  // (сегменты), как настоящий SttService.fetchResult.
  class FakeTranscriptionForWebhook {
    getResultCalls: string[] = [];
    transcriptResultByJobId: Record<string, any> = {};
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
  const fakeSecrets = { resolve: async () => 'fake-assemblyai-key' };

  test('handleVoiceReplyWebhook() при успехе создаёт USER+ASSISTANT сообщения и переводит job в COMPLETED', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedSession({ id: 'sess-1', workingMaterialId: MATERIAL_ID });
    prisma._seedVoiceReplyJob({ id: 'job-1', materialChatSessionId: 'sess-1', externalTranscriptionJobId: 'ext-1' });
    const fakeTranscription = new FakeTranscriptionForWebhook();
    fakeTranscription.transcriptResultByJobId['ext-1'] = {
      status: 'completed', id: 'ext-1',
      utterances: [{ speaker: 'A', text: 'Голосовой вопрос по материалу', start: 0, end: 1000 }],
    };
    const svc = new MaterialChatService(prisma as any, new FakeAIRouterService() as any, fakeTranscription as any, fakeSecrets as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    await svc.handleVoiceReplyWebhook({ transcript_id: 'ext-1', status: 'completed' } as any);

    assertEqual(fakeTranscription.getResultCalls, ['ext-1'], 'полный результат запрошен отдельным GET по transcript_id из вебхука');
    const updatedJob = prisma._getVoiceReplyJobs().find((j: any) => j.id === 'job-1');
    assertEqual(updatedJob.status, 'COMPLETED', 'job переведён в COMPLETED');
    const userMsg = prisma._getMessages().find((m: any) => m.id === updatedJob.userMessageId);
    assertEqual(userMsg.text, 'Голосовой вопрос по материалу', 'транскрибированный текст стал текстом сообщения пользователя');
  });

  test('РЕГРЕССИЯ (аудит 2026-09-02, STT): две одновременные доставки вебхука — одна пара сообщений, второй обработчик уходит по count=0', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedSession({ id: 'sess-1', workingMaterialId: MATERIAL_ID });
    prisma._seedVoiceReplyJob({ id: 'job-1', materialChatSessionId: 'sess-1', externalTranscriptionJobId: 'ext-1' });
    const fakeTranscription = new FakeTranscriptionForWebhook();
    fakeTranscription.transcriptResultByJobId['ext-1'] = {
      status: 'completed', id: 'ext-1',
      utterances: [{ speaker: 'A', text: 'Голосовой вопрос по материалу', start: 0, end: 1000 }],
    };
    const svc = new MaterialChatService(prisma as any, new FakeAIRouterService() as any, fakeTranscription as any, fakeSecrets as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    const messagesBefore = prisma._getMessages().length;

    const payload = { transcript_id: 'ext-1', status: 'completed' } as any;
    await Promise.all([svc.handleVoiceReplyWebhook(payload), svc.handleVoiceReplyWebhook(payload)]);

    const updatedJob = prisma._getVoiceReplyJobs().find((j: any) => j.id === 'job-1');
    assertEqual(updatedJob.status, 'COMPLETED', 'джоба завершена один раз');
    assertEqual(prisma._getMessages().length - messagesBefore, 2, 'ровно USER+ASSISTANT, не четыре сообщения');
  });

  test('handleVoiceReplyWebhook() при ошибке AssemblyAI переводит job в FAILED, текст ошибки сохранён', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedSession({ id: 'sess-1', workingMaterialId: MATERIAL_ID });
    prisma._seedVoiceReplyJob({ id: 'job-1', materialChatSessionId: 'sess-1', externalTranscriptionJobId: 'ext-2' });
    const fakeTranscription = new FakeTranscriptionForWebhook();
    fakeTranscription.transcriptResultByJobId['ext-2'] = { status: 'error', id: 'ext-2', error: 'audio too short' };
    const svc = new MaterialChatService(prisma as any, new FakeAIRouterService() as any, fakeTranscription as any, fakeSecrets as any, new FakeTextToSpeechService() as any, fakeConsent() as any);

    await svc.handleVoiceReplyWebhook({ transcript_id: 'ext-2', status: 'error' } as any);

    const updatedJob = prisma._getVoiceReplyJobs().find((j: any) => j.id === 'job-1');
    assertEqual(updatedJob.status, 'FAILED', 'job честно переведён в FAILED');
    assertEqual(updatedJob.errorMessage, 'audio too short', 'текст ошибки из GET-результата сохранён, не потерян');
  });

  test('РЕГРЕСІЯ (фінальний аудит 2026-08-30): handleVoiceReplyWebhook() без transcript_id — не падає, GET не робиться', async () => {
    const prisma = createFakePrisma();
    const fakeTranscription = new FakeTranscriptionForWebhook();
    const svc = new MaterialChatService(prisma as any, new FakeAIRouterService() as any, fakeTranscription as any, fakeSecrets as any, new FakeTextToSpeechService() as any, fakeConsent() as any);
    await svc.handleVoiceReplyWebhook({ status: 'completed' } as any);
    assertEqual(fakeTranscription.getResultCalls, [], 'без transcript_id зайвий зовнішній виклик не робиться');
  });

  test('КЛЮЧЕВОЙ ТЕСТ (аудит 2026-09-01): голосовая реплика к материалу не уходит провайдеру без проверки согласий', async () => {
    const prisma = createFakePrisma();
    seedBase(prisma);
    prisma._seedSession({ id: 'sess-1', workingMaterialId: MATERIAL_ID });
    const order: string[] = [];
    const consent = {
      assertAudioMayLeaveDevice: async () => {
        order.push('CONSENT_CHECKED');
        throw new ForbiddenException('Consent required: RECORDING');
      },
    };
    const transcription = { streamUpload: async () => { order.push('UPLOADED'); return 'url'; } };
    const svc = new MaterialChatService(
      prisma as any, new FakeAIRouterService() as any, transcription as any, fakeSecrets as any,
      new FakeTextToSpeechService() as any, consent as any,
    );

    await assertThrowsAsync(
      () => svc.streamUploadVoiceReply(USER_ID, 'sess-1', null as any),
      ForbiddenException,
      'streamUploadVoiceReply() без согласия',
    );
    assertEqual(order, ['CONSENT_CHECKED'], 'проверка согласия — до загрузки, ни одного байта провайдеру не ушло');
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
  console.log(`\nMaterialChatService: ${results.length - failed.length}/${results.length} passed\n`);
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

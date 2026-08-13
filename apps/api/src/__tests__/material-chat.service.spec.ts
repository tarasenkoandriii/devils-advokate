import { MaterialChatService } from '../material-chat/material-chat.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

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
    },
    materialChatVoiceReplyJob: {
      create: async ({ data }: any) => {
        const j = { id: nextId(), status: 'PENDING', createdAt: new Date(), ...data };
        voiceReplyJobs.push(j);
        return j;
      },
      findUnique: async ({ where }: any) => voiceReplyJobs.find((j) => (where.id ? j.id === where.id : j.externalTranscriptionJobId === where.externalTranscriptionJobId)) ?? null,
      update: async ({ where, data }: any) => {
        const idx = voiceReplyJobs.findIndex((j) => j.id === where.id);
        voiceReplyJobs[idx] = { ...voiceReplyJobs[idx], ...data };
        return voiceReplyJobs[idx];
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

function makeService(prisma: any, aiRouter: any = new FakeAIRouterService(), tts: any = new FakeTextToSpeechService()) {
  return new MaterialChatService(prisma, aiRouter, {} as any, {} as any, tts);
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

run();

import { CompromiseSheetService } from '../compromise-sheet/compromise-sheet.service';
import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const sessions = new Map<string, any>();
  const messages: any[] = [];
  const projectArguments: any[] = [];
  const motiveHypotheses: any[] = [];
  const sheets: any[] = [];
  const sheetItems: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedSession(s: any) { sessions.set(s.id, s); },
    _seedMessage(m: any) { messages.push({ id: nextId(), createdAt: new Date(), ...m }); },
    _seedArgument(a: any) { projectArguments.push({ id: a.id ?? nextId(), ...a }); },
    _seedMotiveHypothesis(m: any) { motiveHypotheses.push(m); },
    _getSheets() { return sheets; },
    _getSheetItems() { return sheetItems; },
    _getArguments() { return projectArguments; },

    sparringSession: {
      findUnique: async ({ where }: any) => {
        const s = sessions.get(where.id);
        if (!s) return null;
        return { ...s, project: projects.get(s.projectId) };
      },
    },
    argument: {
      findMany: async ({ where }: any) => {
        let result = projectArguments.filter((a) => a.projectId === where.projectId);
        if (where.targetPersonId === null) result = result.filter((a) => a.targetPersonId == null);
        if (where.stance?.in) result = result.filter((a) => where.stance.in.includes(a.stance));
        if (where.stance && typeof where.stance === 'string') result = result.filter((a) => a.stance === where.stance);
        return result;
      },
      create: async ({ data }: any) => {
        const a = { id: nextId(), createdAt: new Date(), ...data };
        projectArguments.push(a);
        return a;
      },
    },
    motiveHypothesis: {
      findMany: async ({ where }: any) => motiveHypotheses.filter((m) => m.projectId === where.projectId && m.personId === where.personId),
    },
    sparringMessage: {
      findMany: async ({ where }: any) => messages.filter((m) => m.sessionId === where.sessionId).sort((a, b) => a.createdAt - b.createdAt),
    },
    promptVersion: {
      findFirst: async () => null,
    },
    compromiseSheet: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), audioGenerated: false, audioSource: null, audioBase64: null, previewedByUser: false, sentToFigurant: false, createdAt: new Date(), ...data };
        sheets.push(s);
        return s;
      },
      findUnique: async ({ where }: any) => {
        const s = sheets.find((x) => x.id === where.id);
        if (!s) return null;
        return { ...s, items: sheetItems.filter((i) => i.compromiseSheetId === s.id).map((i) => ({ ...i, argument: projectArguments.find((a) => a.id === i.argumentId) })), sparringSession: { ...sessions.get(s.sparringSessionId), project: projects.get(sessions.get(s.sparringSessionId)?.projectId) } };
      },
      findUniqueOrThrow: async ({ where }: any) => {
        const s = sheets.find((x) => x.id === where.id);
        if (!s) throw new Error('not found');
        return { ...s, items: sheetItems.filter((i) => i.compromiseSheetId === s.id).map((i) => ({ ...i, argument: projectArguments.find((a) => a.id === i.argumentId) })) };
      },
      findMany: async ({ where }: any) =>
        sheets
          .filter((s) => s.sparringSessionId === where.sparringSessionId)
          .map((s) => ({ ...s, items: sheetItems.filter((i) => i.compromiseSheetId === s.id).map((i) => ({ ...i, argument: projectArguments.find((a) => a.id === i.argumentId) })) }))
          .sort((a, b) => b.createdAt - a.createdAt),
      update: async ({ where, data }: any) => {
        const idx = sheets.findIndex((s) => s.id === where.id);
        sheets[idx] = { ...sheets[idx], ...data };
        return sheets[idx];
      },
    },
    compromiseSheetItem: {
      create: async ({ data }: any) => {
        const i = { id: nextId(), createdAt: new Date(), ...data };
        sheetItems.push(i);
        return i;
      },
    },
  };
}

class FakeAIRouterService {
  responseText = '[{"text":"Компромисс: снизить сумму на 10%"},{"text":"Компромисс: продлить срок на неделю"}]';
  aiInferenceId = 'inference-1';
  lastRequest: any = null;

  async execute(request: any) {
    this.lastRequest = request;
    if (request.validateOutput && !request.validateOutput(this.responseText)) {
      throw new Error('validation failed in fake router');
    }
    return { aiInferenceId: this.aiInferenceId, jobId: 'job-1', text: this.responseText };
  }
}

class FakeTtsService {
  synthesizeCalled = false;
  async synthesize() {
    this.synthesizeCalled = true;
    return { audioBase64: 'ZmFrZS1hdWRpby1kYXRh', cached: false };
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
const SESSION_ID = 'sess-1';

function seedSession(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Раздел имущества при переезде' });
  prisma._seedSession({ id: SESSION_ID, projectId: PROJECT_ID, targetPersonId: null });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('generate() бросает NotFoundException для чужой сессии', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    prisma._seedSession({ id: SESSION_ID, projectId: PROJECT_ID });
    const svc = new CompromiseSheetService(prisma as any, new FakeAIRouterService() as any, new FakeTtsService() as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, SESSION_ID, 'BEFORE' as any), NotFoundException, 'generate() на чужую сессию');
  });

  test('generate() для phase=AFTER бросает BadRequestException без диалога', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    const svc = new CompromiseSheetService(prisma as any, new FakeAIRouterService() as any, new FakeTtsService() as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, SESSION_ID, 'AFTER' as any), BadRequestException, 'generate() AFTER без обмена репликами');
  });

  test('generate() для phase=BEFORE работает без единого сообщения (черновик до тренировки)', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    const svc = new CompromiseSheetService(prisma as any, new FakeAIRouterService() as any, new FakeTtsService() as any);

    const sheet = await svc.generate(USER_ID, SESSION_ID, 'BEFORE' as any);
    assertEqual(sheet.phase, 'BEFORE', 'фаза сохранена');
  });

  test('generate() подмешивает уже собранные аргументы, разбор мотивов и аргументы примирения в промпт', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    prisma._seedArgument({ projectId: PROJECT_ID, text: 'Аргумент за скорейший переезд', stance: 'PRO', targetPersonId: null });
    prisma._seedArgument({ projectId: PROJECT_ID, text: 'Не суди, да не судим будешь', stance: 'RECONCILIATION' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new CompromiseSheetService(prisma as any, fakeRouter as any, new FakeTtsService() as any);

    await svc.generate(USER_ID, SESSION_ID, 'BEFORE' as any);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Аргумент за скорейший переезд'), true, 'уже собранный аргумент попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Не суди, да не судим будешь'), true, 'аргумент примирения попал в промпт');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: generate() создаёт новые Argument(stance=COMPROMISE_PROPOSAL), items ссылаются именно на них', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    const svc = new CompromiseSheetService(prisma as any, new FakeAIRouterService() as any, new FakeTtsService() as any);

    const sheet = await svc.generate(USER_ID, SESSION_ID, 'BEFORE' as any);
    assertEqual(sheet.items.length, 2, 'оба пункта из ответа AI созданы');
    assertEqual(sheet.items[0].argument.stance, 'COMPROMISE_PROPOSAL', 'создан именно Argument с этим stance, не PersonFact и не что-то ещё');
    const allArgs = prisma._getArguments();
    assertEqual(allArgs.filter((a: any) => a.stance === 'COMPROMISE_PROPOSAL').length, 2, 'ровно два новых Argument реально появились в базе');
  });

  test('generate() для phase=AFTER подмешивает фрагмент диалога спарринга в промпт', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    prisma._seedMessage({ sessionId: SESSION_ID, role: 'OPPONENT', text: 'Первое возражение оппонента' });
    prisma._seedMessage({ sessionId: SESSION_ID, role: 'USER', text: 'Мой ответ на возражение' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new CompromiseSheetService(prisma as any, fakeRouter as any, new FakeTtsService() as any);

    await svc.generate(USER_ID, SESSION_ID, 'AFTER' as any);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Первое возражение оппонента'), true, 'реплика оппонента попала в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Мой ответ на возражение'), true, 'ответ пользователя попал в промпт');
  });

  test('generate() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new CompromiseSheetService(prisma as any, failingRouter as any, new FakeTtsService() as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, SESSION_ID, 'BEFORE' as any), BadGatewayException, 'generate() при недоступности провайдера');
  });

  test('generateVoiceOver() бросает BadRequestException для пустого листа', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    prisma._seedArgument({}); // не используется напрямую, просто заполняем массив
    const sheet = await prisma.compromiseSheet.create({ data: { sparringSessionId: SESSION_ID, phase: 'BEFORE' } });
    const svc = new CompromiseSheetService(prisma as any, new FakeAIRouterService() as any, new FakeTtsService() as any);
    await assertThrowsAsync(() => svc.generateVoiceOver(USER_ID, sheet.id), BadRequestException, 'generateVoiceOver() на пустой лист');
  });

  test('generateVoiceOver() переиспользует TextToSpeechService, сохраняет audioSource=ELEVENLABS', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    const fakeTts = new FakeTtsService();
    const svc = new CompromiseSheetService(prisma as any, new FakeAIRouterService() as any, fakeTts as any);

    const sheet = await svc.generate(USER_ID, SESSION_ID, 'BEFORE' as any);
    const updated = await svc.generateVoiceOver(USER_ID, sheet.id);
    assertEqual(fakeTts.synthesizeCalled, true, 'TextToSpeechService реально вызван, не задублирован');
    assertEqual(updated.audioGenerated, true, 'audioGenerated проставлен');
    assertEqual(updated.audioSource, 'ELEVENLABS', 'источник — ElevenLabs, не USER_VOICE (тот честно не реализован)');
  });

  test('markPreviewed() проставляет previewedByUser=true', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    const svc = new CompromiseSheetService(prisma as any, new FakeAIRouterService() as any, new FakeTtsService() as any);

    const sheet = await svc.generate(USER_ID, SESSION_ID, 'BEFORE' as any);
    const updated = await svc.markPreviewed(USER_ID, sheet.id);
    assertEqual(updated.previewedByUser, true, 'просмотр зафиксирован');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: markSentToFigurant() бросает ForbiddenException без предварительного markPreviewed()', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    const svc = new CompromiseSheetService(prisma as any, new FakeAIRouterService() as any, new FakeTtsService() as any);

    const sheet = await svc.generate(USER_ID, SESSION_ID, 'BEFORE' as any);
    await assertThrowsAsync(
      () => svc.markSentToFigurant(USER_ID, sheet.id),
      ForbiddenException,
      'markSentToFigurant() без previewedByUser=true — жёсткая бизнес-проверка, не только UI',
    );
  });

  test('markSentToFigurant() успешно срабатывает ПОСЛЕ markPreviewed()', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    const svc = new CompromiseSheetService(prisma as any, new FakeAIRouterService() as any, new FakeTtsService() as any);

    const sheet = await svc.generate(USER_ID, SESSION_ID, 'BEFORE' as any);
    await svc.markPreviewed(USER_ID, sheet.id);
    const updated = await svc.markSentToFigurant(USER_ID, sheet.id);
    assertEqual(updated.sentToFigurant, true, 'отправка зафиксирована после просмотра');
  });

  test('listForSession() возвращает оба листа сессии (до и после)', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    const svc = new CompromiseSheetService(prisma as any, new FakeAIRouterService() as any, new FakeTtsService() as any);

    await svc.generate(USER_ID, SESSION_ID, 'BEFORE' as any);
    prisma._seedMessage({ sessionId: SESSION_ID, role: 'OPPONENT', text: 'x' });
    prisma._seedMessage({ sessionId: SESSION_ID, role: 'USER', text: 'y' });
    await svc.generate(USER_ID, SESSION_ID, 'AFTER' as any);

    const list = await svc.listForSession(USER_ID, SESSION_ID);
    assertEqual(list.length, 2, 'оба листа видны — до и после');
  });

  // ── Пункт 71: собственный голос + пост-обработка (§3.41 ТЗ) ──

  test('submitUserVoiceRecording() бросает BadRequestException для пустого audioBase64', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    const svc = new CompromiseSheetService(prisma as any, new FakeAIRouterService() as any, new FakeTtsService() as any);
    const sheet = await svc.generate(USER_ID, SESSION_ID, 'BEFORE' as any);
    await assertThrowsAsync(
      () => svc.submitUserVoiceRecording(USER_ID, sheet.id, '   ', { normalizeVolume: false, removePauses: false, removeNoise: false }),
      BadRequestException,
      'submitUserVoiceRecording() с пустым audioBase64',
    );
  });

  test('КЛЮЧЕВОЙ ТЕСТ: submitUserVoiceRecording() сохраняет audioSource=USER_VOICE и все три флага пост-обработки раздельно', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    const svc = new CompromiseSheetService(prisma as any, new FakeAIRouterService() as any, new FakeTtsService() as any);
    const sheet = await svc.generate(USER_ID, SESSION_ID, 'BEFORE' as any);

    const updated = await svc.submitUserVoiceRecording(USER_ID, sheet.id, 'ZmFrZS1hdWRpbw==', {
      normalizeVolume: true,
      removePauses: false,
      removeNoise: true,
    });
    assertEqual(updated.audioSource, 'USER_VOICE', 'источник — собственный голос, не ElevenLabs');
    assertEqual(updated.audioGenerated, true, 'audioGenerated проставлен');
    assertEqual(updated.postProcessingNormalizeVolume, true, 'флаг нормализации сохранён как есть');
    assertEqual(updated.postProcessingRemovePauses, false, 'флаг удаления пауз сохранён как есть — не включён, если не выбран');
    assertEqual(updated.postProcessingRemoveNoise, true, 'флаг шумоподавления сохранён как есть');
  });

  test('submitUserVoiceRecording() не пересчитывает и не трогает обработку — сохраняет ровно то, что прислал клиент', async () => {
    const prisma = createFakePrisma();
    seedSession(prisma);
    const svc = new CompromiseSheetService(prisma as any, new FakeAIRouterService() as any, new FakeTtsService() as any);
    const sheet = await svc.generate(USER_ID, SESSION_ID, 'BEFORE' as any);

    const updated = await svc.submitUserVoiceRecording(USER_ID, sheet.id, 'dW5pcXVlLWF1ZGlvLWJhc2U2NA==', {
      normalizeVolume: false,
      removePauses: false,
      removeNoise: false,
    });
    assertEqual(updated.audioBase64, 'dW5pcXVlLWF1ZGlvLWJhc2U2NA==', 'сохранён именно тот base64, что прислал клиент, не изменён на сервере');
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
  console.log(`\nCompromiseSheetService: ${results.length - failed.length}/${results.length} passed\n`);
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

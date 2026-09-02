import { TurningPointsService } from '../turning-points/turning-points.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const conversations = new Map<string, any>();
  const transcripts = new Map<string, any>();
  const segments = new Map<string, any>();
  const participants = new Map<string, any>();
  const signals = new Map<string, any>();
  const evidence: any[] = [];
  const aiInferences = new Map<string, any>();
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedConversation(c: any) { conversations.set(c.id, c); },
    _seedTranscript(t: any) { transcripts.set(t.id, t); },
    _seedSegment(s: any) { segments.set(s.id, s); },
    _seedParticipant(p: any) { participants.set(p.id, p); },
    _seedAIInference(i: any) { aiInferences.set(i.id, i); },
    _getConversation(id: string) { return conversations.get(id); },
    _getSignals() { return [...signals.values()]; },
    _getEvidence() { return evidence; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    conversation: {
      findUnique: async ({ where }: any) => {
        const c = conversations.get(where.id);
        if (!c) return null;
        const project = projects.get(c.projectId);
        const transcript = [...transcripts.values()].find((t) => t.conversationId === c.id);
        const transcriptWithSegments = transcript
          ? {
              ...transcript,
              segments: [...segments.values()]
                .filter((s) => s.transcriptId === transcript.id)
                .map((s) => ({ ...s, participant: s.participantId ? participants.get(s.participantId) : null })),
            }
          : null;
        return { ...c, project, transcript: transcriptWithSegments };
      },
      update: async ({ where, data }: any) => {
        const merged = { ...conversations.get(where.id), ...data };
        conversations.set(where.id, merged);
        return merged;
      },
    },
    promptVersion: {
      findFirst: async () => null, // используем DEFAULT_SYSTEM_PROMPT из кода — тот же паттерн, что steelman/conversation-script
    },
    conversationSignal: {
      findMany: async ({ where }: any) => {
        let result = [...signals.values()];
        if (where.signalType?.in) result = result.filter((s) => where.signalType.in.includes(s.signalType));
        if (where.signalType && !where.signalType.in) result = result.filter((s) => s.signalType === where.signalType);
        if (where.transcriptSegmentId?.in)
          result = result.filter((s) => where.transcriptSegmentId.in.includes(s.transcriptSegmentId));
        return result;
      },
      create: async ({ data }: any) => {
        const s = { id: nextId(), disputed: false, createdAt: new Date(), ...data };
        signals.set(s.id, s);
        return s;
      },
    },
    conversationSignalEvidence: {
      create: async ({ data }: any) => {
        const e = { id: nextId(), createdAt: new Date(), ...data };
        evidence.push(e);
        return e;
      },
    },
  };
}

// Фейковый AIRouterService — не делает реальных HTTP-вызовов.
class FakeAIRouterService {
  responseText = '[]';
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

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

function assertThrowsAsync(fn: () => Promise<unknown>, expectedType: any, message: string) {
  return fn().then(
    () => { throw new Error(`FAIL: ${message} — expected to throw ${expectedType.name}, did not throw`); },
    (err) => {
      if (!(err instanceof expectedType)) {
        throw new Error(`FAIL: ${message} — expected ${expectedType.name}, got ${err?.constructor?.name}: ${err?.message}`);
      }
    },
  );
}

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';
const CONV_ID = 'conv-1';

function seedTranscribedConversation(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
  prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED' });
  prisma._seedTranscript({ id: 'transcript-1', conversationId: CONV_ID });
  prisma._seedParticipant({ id: 'part-a', diarizationLabel: 'A' });
  prisma._seedParticipant({ id: 'part-b', diarizationLabel: 'B' });
  prisma._seedSegment({ id: 'seg-1', transcriptId: 'transcript-1', participantId: 'part-a', text: 'Начнём с фактов.' });
  prisma._seedSegment({ id: 'seg-2', transcriptId: 'transcript-1', participantId: 'part-b', text: 'Хорошо, вы правы.' });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('detect() бросает BadRequestException, если статус не TRANSCRIBED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'UPLOADED' });
    const svc = new TurningPointsService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.detect(USER_ID, CONV_ID),
      BadRequestException,
      'detect() при статусе UPLOADED',
    );
  });

  test('detect() бросает NotFoundException для чужого разговора', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED' });
    const svc = new TurningPointsService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.detect(USER_ID, CONV_ID),
      NotFoundException,
      'detect() на чужой разговор',
    );
  });

  test('detect() создаёт ConversationSignal и ConversationSignalEvidence по ответу AI', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { segmentId: 'seg-2', signalType: 'ARGUMENT_ACCEPTANCE', description: 'Собеседник согласился.', confidence: 0.9 },
    ]);
    const svc = new TurningPointsService(prisma as any, fakeRouter as any);

    const created = await svc.detect(USER_ID, CONV_ID);
    assertEqual(created.length, 1, 'количество созданных точек');
    assertEqual(prisma._getSignals().length, 1, 'количество ConversationSignal в базе');
    assertEqual(prisma._getEvidence().length, 1, 'количество ConversationSignalEvidence в базе');
    assertEqual(prisma._getConversation(CONV_ID).status, 'ANALYZED', 'статус после успешной детекции');
  });

  test('detect() ставит confirmedGenuinely=false при совпадении с MANIPULATION_PATTERN на том же сегменте', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    // Заранее существующий сигнал манипуляции на seg-2
    await prisma.conversationSignal.create({
      data: { signalType: 'MANIPULATION_PATTERN', transcriptSegmentId: 'seg-2' },
    });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { segmentId: 'seg-2', signalType: 'ARGUMENT_ACCEPTANCE', description: 'Похоже на уступку под давлением.' },
    ]);
    const svc = new TurningPointsService(prisma as any, fakeRouter as any);

    await svc.detect(USER_ID, CONV_ID);
    const acceptanceSignal = prisma._getSignals().find((s: any) => s.signalType === 'ARGUMENT_ACCEPTANCE');
    assertEqual(acceptanceSignal.confirmedGenuinely, false, 'confirmedGenuinely при совпадении с манипуляцией');
  });

  test('detect() ставит confirmedGenuinely=true без манипуляции на сегменте', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { segmentId: 'seg-2', signalType: 'ARGUMENT_ACCEPTANCE', description: 'Искреннее согласие.' },
    ]);
    const svc = new TurningPointsService(prisma as any, fakeRouter as any);

    await svc.detect(USER_ID, CONV_ID);
    const acceptanceSignal = prisma._getSignals().find((s: any) => s.signalType === 'ARGUMENT_ACCEPTANCE');
    assertEqual(acceptanceSignal.confirmedGenuinely, true, 'confirmedGenuinely без манипуляции');
  });

  test('detect() пропускает точку со ссылкой на несуществующий segmentId, не падает целиком', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { segmentId: 'seg-does-not-exist', signalType: 'EMOTIONAL_SHIFT', description: 'x' },
      { segmentId: 'seg-1', signalType: 'EMOTIONAL_SHIFT', description: 'Реальная точка.' },
    ]);
    const svc = new TurningPointsService(prisma as any, fakeRouter as any);

    const created = await svc.detect(USER_ID, CONV_ID);
    assertEqual(created.length, 1, 'только валидная точка создана, невалидная пропущена без падения');
  });

  test('detect() откатывает статус на TRANSCRIBED и бросает BadGatewayException при ошибке AI', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new TurningPointsService(prisma as any, failingRouter as any);

    // Пункт 32 (расширенный аудит тестов) — раньше исключение
    // проглатывалось молча (bare catch {}), проверялся только откат
    // статуса, не тип ошибки — тест исполнял ветку кода, но не
    // проверял главное: что наружу уходит именно BadGatewayException,
    // не какая-то другая ошибка. Заменено на явную проверку типа.
    await assertThrowsAsync(
      () => svc.detect(USER_ID, CONV_ID),
      BadGatewayException,
      'detect() при недоступности провайдера',
    );
    assertEqual(prisma._getConversation(CONV_ID).status, 'TRANSCRIBED', 'статус откатился после ошибки AI');
  });

  test('list() восстанавливает description из общего AIInference и сортирует по порядку сегментов', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    prisma._seedAIInference({
      id: 'inference-shared',
      output: JSON.stringify([
        { segmentId: 'seg-1', signalType: 'EMOTIONAL_SHIFT', description: 'Первая точка.' },
        { segmentId: 'seg-2', signalType: 'ARGUMENT_ACCEPTANCE', description: 'Вторая точка.' },
      ]),
    });
    // Создаём сигналы в ОБРАТНОМ порядке сегментов — проверяем сортировку list()
    const sig2 = await prisma.conversationSignal.create({
      data: { signalType: 'ARGUMENT_ACCEPTANCE', transcriptSegmentId: 'seg-2' },
    });
    await prisma.conversationSignalEvidence.create({ data: { conversationSignalId: sig2.id, aiInferenceId: 'inference-shared' } });
    const sig1 = await prisma.conversationSignal.create({
      data: { signalType: 'EMOTIONAL_SHIFT', transcriptSegmentId: 'seg-1' },
    });
    await prisma.conversationSignalEvidence.create({ data: { conversationSignalId: sig1.id, aiInferenceId: 'inference-shared' } });

    // list() читает через include (не через плоские Map) — расширим фейковый prisma.conversationSignal.findMany под include
    (prisma.conversationSignal as any).findMany = async ({ where }: any) => {
      let result = prisma._getSignals();
      if (where.transcriptSegmentId?.in)
        result = result.filter((s: any) => where.transcriptSegmentId.in.includes(s.transcriptSegmentId));
      if (where.signalType?.in) result = result.filter((s: any) => where.signalType.in.includes(s.signalType));
      return result.map((s: any) => ({
        ...s,
        transcriptSegment: { id: s.transcriptSegmentId },
        evidence: prisma
          ._getEvidence()
          .filter((e: any) => e.conversationSignalId === s.id)
          .map((e: any) => ({ aiInference: e.aiInferenceId ? { output: (prisma as any)._getAIInferenceOutput?.(e.aiInferenceId) ?? JSON.stringify([{ segmentId: 'seg-1', signalType: 'EMOTIONAL_SHIFT', description: 'Первая точка.' }, { segmentId: 'seg-2', signalType: 'ARGUMENT_ACCEPTANCE', description: 'Вторая точка.' }]) } : null })),
      }));
    };

    const svc = new TurningPointsService(prisma as any, new FakeAIRouterService() as any);
    const list = await svc.list(USER_ID, CONV_ID);

    assertEqual(list.length, 2, 'количество точек в list()');
    assertEqual((list[0] as any).transcriptSegmentId, 'seg-1', 'сортировка — seg-1 первым, несмотря на порядок создания');
    assertEqual((list[0] as any).description, 'Первая точка.', 'description восстановлен для первой точки');
    assertEqual((list[1] as any).description, 'Вторая точка.', 'description восстановлен для второй точки');
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
  console.log(`\nTurningPointsService: ${results.length - failed.length}/${results.length} passed\n`);
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

import { DoNotSayService } from '../do-not-say/do-not-say.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const conversations = new Map<string, any>();
  const transcripts = new Map<string, any>();
  const segments = new Map<string, any>();
  const participants = new Map<string, any>();
  const signals = new Map<string, any>();
  const evidence: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedConversation(c: any) { conversations.set(c.id, c); },
    _seedTranscript(t: any) { transcripts.set(t.id, t); },
    _seedSegment(s: any) { segments.set(s.id, s); },
    _seedParticipant(p: any) { participants.set(p.id, p); },
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
    },
    transcriptSegment: {
      findMany: async ({ where }: any) => {
        const projectId = where.transcript.conversation.projectId;
        const projConversationIds = [...conversations.values()].filter((c) => c.projectId === projectId).map((c) => c.id);
        const projTranscriptIds = [...transcripts.values()].filter((t) => projConversationIds.includes(t.conversationId)).map((t) => t.id);
        return [...segments.values()].filter((s) => projTranscriptIds.includes(s.transcriptId)).map((s) => ({ id: s.id }));
      },
    },
    promptVersion: {
      findFirst: async () => null,
    },
    conversationSignal: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), disputed: false, confidence: null, createdAt: new Date(), ...data };
        signals.set(s.id, s);
        return s;
      },
      findMany: async ({ where }: any) => {
        let result = [...signals.values()];
        if (where.signalType) result = result.filter((s) => s.signalType === where.signalType);
        if (where.transcriptSegmentId?.in)
          result = result.filter((s) => where.transcriptSegmentId.in.includes(s.transcriptSegmentId));
        return result.map((s) => ({
          ...s,
          transcriptSegment: { id: s.transcriptSegmentId },
          evidence: evidence
            .filter((e) => e.conversationSignalId === s.id)
            .map((e) => ({ aiInference: e.aiInference })),
        }));
      },
    },
    conversationSignalEvidence: {
      create: async ({ data }: any) => {
        const e = {
          id: nextId(), createdAt: new Date(), ...data,
          aiInference: (globalThis as any).__fakeInferenceOutput
            ? { output: (globalThis as any).__fakeInferenceOutput }
            : null,
        };
        evidence.push(e);
        return e;
      },
    },
  };
}

class FakeAIRouterService {
  responseText = '[]';
  aiInferenceId = 'inference-1';

  async execute(request: any) {
    (globalThis as any).__fakeInferenceOutput = this.responseText;
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
  prisma._seedParticipant({ id: 'part-self', diarizationLabel: 'A', isSelf: true });
  prisma._seedParticipant({ id: 'part-other', diarizationLabel: 'B', isSelf: false });
  prisma._seedSegment({ id: 'seg-self-1', transcriptId: 'transcript-1', participantId: 'part-self', text: 'Я уже говорил тебе, что не буду это терпеть.' });
  prisma._seedSegment({ id: 'seg-other-1', transcriptId: 'transcript-1', participantId: 'part-other', text: 'Хорошо, я подумаю.' });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('detect() бросает BadRequestException, если статус не TRANSCRIBED/ANALYZED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'UPLOADED' });
    const svc = new DoNotSayService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.detect(USER_ID, CONV_ID), BadRequestException, 'detect() при статусе UPLOADED');
  });

  test('detect() бросает NotFoundException для чужого разговора', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED' });
    const svc = new DoNotSayService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.detect(USER_ID, CONV_ID), NotFoundException, 'detect() на чужой разговор');
  });

  test('detect() бросает BadRequestException, если нет сегментов от isSelf-участника', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED' });
    prisma._seedTranscript({ id: 'transcript-1', conversationId: CONV_ID });
    prisma._seedParticipant({ id: 'part-other', diarizationLabel: 'B', isSelf: false });
    prisma._seedSegment({ id: 'seg-1', transcriptId: 'transcript-1', participantId: 'part-other', text: 'x' });
    const svc = new DoNotSayService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.detect(USER_ID, CONV_ID), BadRequestException, 'detect() без isSelf-сегментов');
  });

  test('detect() анализирует ТОЛЬКО сегменты isSelf-участника, не собеседника', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    let capturedPrompt = '';
    const originalExecute = fakeRouter.execute.bind(fakeRouter);
    fakeRouter.execute = async (req: any) => {
      capturedPrompt = req.userPrompt;
      return originalExecute(req);
    };
    fakeRouter.responseText = '[]';
    const svc = new DoNotSayService(prisma as any, fakeRouter as any);
    await svc.detect(USER_ID, CONV_ID);
    assertEqual(capturedPrompt.includes('seg-self-1'), true, 'промпт содержит реплику самого пользователя');
    assertEqual(capturedPrompt.includes('seg-other-1'), false, 'промпт НЕ содержит реплику собеседника');
  });

  test('detect() создаёт ConversationSignal(SELF_RISK) с riskCategory из ответа AI', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { segmentId: 'seg-self-1', riskCategory: 'LEVERAGE', why: 'Можно использовать как рычаг давления.', saferAlternative: 'Я бы хотел обсудить это конструктивно.' },
    ]);
    const svc = new DoNotSayService(prisma as any, fakeRouter as any);

    const created = await svc.detect(USER_ID, CONV_ID);
    assertEqual(created.length, 1, 'количество созданных предупреждений');
    assertEqual(prisma._getSignals()[0].signalType, 'SELF_RISK', 'signalType создан правильный');
    assertEqual(prisma._getSignals()[0].riskCategory, 'LEVERAGE', 'riskCategory сохранён');
  });

  test('list() восстанавливает why/saferAlternative из общего AIInference', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { segmentId: 'seg-self-1', riskCategory: 'ESCALATION', why: 'Может обостриться при повторении.', saferAlternative: 'Мне важно, чтобы это больше не повторялось.' },
    ]);
    const svc = new DoNotSayService(prisma as any, fakeRouter as any);
    await svc.detect(USER_ID, CONV_ID);

    const list = await svc.list(USER_ID, CONV_ID);
    assertEqual(list.length, 1, 'количество в list()');
    assertEqual((list[0] as any).why, 'Может обостриться при повторении.', 'why восстановлен');
    assertEqual((list[0] as any).saferAlternative, 'Мне важно, чтобы это больше не повторялось.', 'saferAlternative восстановлен');
  });

  test('listForProject() агрегирует SELF_RISK по всем разговорам проекта', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    prisma._seedConversation({ id: 'conv-2', projectId: PROJECT_ID, status: 'TRANSCRIBED' });
    prisma._seedTranscript({ id: 'transcript-2', conversationId: 'conv-2' });
    prisma._seedParticipant({ id: 'part-self-2', diarizationLabel: 'A', isSelf: true });
    prisma._seedSegment({ id: 'seg-self-2', transcriptId: 'transcript-2', participantId: 'part-self-2', text: 'Ещё одна рискованная фраза.' });

    const fakeRouter = new FakeAIRouterService();
    const svc = new DoNotSayService(prisma as any, fakeRouter as any);

    fakeRouter.responseText = JSON.stringify([{ segmentId: 'seg-self-1', riskCategory: 'LEVERAGE', why: 'x', saferAlternative: 'y' }]);
    await svc.detect(USER_ID, CONV_ID);
    fakeRouter.responseText = JSON.stringify([{ segmentId: 'seg-self-2', riskCategory: 'ESCALATION', why: 'x2', saferAlternative: 'y2' }]);
    await svc.detect(USER_ID, 'conv-2');

    const aggregated = await svc.listForProject(USER_ID, PROJECT_ID);
    assertEqual(aggregated.length, 2, 'агрегация видит предупреждения из ОБОИХ разговоров проекта');
  });

  // Пункт 32 (расширенный аудит тестов) — ветка BadGatewayException в
  // detect() не тестировалась ни разу.
  test('detect() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.execute = async () => { throw new Error('provider timeout'); };
    const svc = new DoNotSayService(prisma as any, fakeRouter as any);
    await assertThrowsAsync(
      () => svc.detect(USER_ID, CONV_ID),
      BadGatewayException,
      'detect() при недоступности провайдера',
    );
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
  console.log(`\nDoNotSayService: ${results.length - failed.length}/${results.length} passed\n`);
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

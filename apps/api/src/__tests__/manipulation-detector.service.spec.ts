import { ManipulationDetectorService } from '../manipulation-detector/manipulation-detector.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const conversations = new Map<string, any>();
  const transcripts = new Map<string, any>();
  const segments = new Map<string, any>();
  const participants = new Map<string, any>();
  const signals: any[] = [];
  const evidences: any[] = [];
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
    _getSignals() { return signals; },

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
    promptVersion: {
      findFirst: async () => null,
    },
    conversationSignal: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), disputed: false, createdAt: new Date(), ...data };
        signals.push(s);
        return s;
      },
      findMany: async ({ where, include }: any) => {
        let result = signals.filter(
          (s) => s.signalType === where.signalType && where.transcriptSegmentId.in.includes(s.transcriptSegmentId),
        );
        if (include?.transcriptSegment) {
          result = result.map((s) => ({ ...s, transcriptSegment: segments.get(s.transcriptSegmentId) }));
        }
        if (include?.evidence) {
          result = result.map((s) => ({
            ...s,
            evidence: evidences
              .filter((e) => e.conversationSignalId === s.id)
              .map((e) => ({
                ...e,
                aiInference: aiInferences.get(e.aiInferenceId) ?? null,
              })),
          }));
        }
        return result;
      },
    },
    conversationSignalEvidence: {
      create: async ({ data }: any) => {
        const e = { id: nextId(), ...data };
        evidences.push(e);
        return e;
      },
    },
  };
}

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

function seedTwoSpeakerConversation(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
  prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED' });
  prisma._seedTranscript({ id: 'transcript-1', conversationId: CONV_ID });
  prisma._seedParticipant({ id: 'part-self', diarizationLabel: 'A', isSelf: true });
  prisma._seedParticipant({ id: 'part-other', diarizationLabel: 'B', isSelf: false });
  prisma._seedSegment({ id: 'seg-self', transcriptId: 'transcript-1', participantId: 'part-self', text: 'Ты вообще никогда меня не слушаешь.' });
  prisma._seedSegment({ id: 'seg-other', transcriptId: 'transcript-1', participantId: 'part-other', text: 'А ты сама постоянно опаздываешь, между прочим!' });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('detect() бросает BadRequestException, если статус не TRANSCRIBED/ANALYZED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'UPLOADED' });
    const svc = new ManipulationDetectorService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.detect(USER_ID, CONV_ID), BadRequestException, 'detect() при статусе UPLOADED');
  });

  test('detect() бросает NotFoundException для чужого разговора', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED' });
    const svc = new ManipulationDetectorService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.detect(USER_ID, CONV_ID), NotFoundException, 'detect() на чужой разговор');
  });

  test('detect() анализирует ОБЕИХ говорящих, не только isSelf (ключевое отличие от Do Not Say)', async () => {
    const prisma = createFakePrisma();
    seedTwoSpeakerConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    await new ManipulationDetectorService(prisma as any, fakeRouter as any).detect(USER_ID, CONV_ID);

    assertEqual(
      fakeRouter.lastRequest.userPrompt.includes('Ты вообще никогда меня не слушаешь') &&
        fakeRouter.lastRequest.userPrompt.includes('А ты сама постоянно опаздываешь'),
      true,
      'реплики ОБОИХ участников попали в промпт, не только isSelf-участника',
    );
  });

  test('detect() создаёт ConversationSignal(MANIPULATION_PATTERN) с provenance на AIInference', async () => {
    const prisma = createFakePrisma();
    seedTwoSpeakerConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { segmentId: 'seg-other', technique: 'whataboutism', description: 'Переводит разговор на чужой недостаток вместо ответа по существу', confidence: 0.85 },
    ]);
    const svc = new ManipulationDetectorService(prisma as any, fakeRouter as any);

    const created = await svc.detect(USER_ID, CONV_ID);
    assertEqual(created.length, 1, 'один сигнал создан');
    assertEqual(created[0].signalType, 'MANIPULATION_PATTERN', 'signalType корректный');
    assertEqual(created[0].technique, 'whataboutism', 'technique из ответа AI');
    assertEqual(prisma._getSignals()[0].transcriptSegmentId, 'seg-other', 'привязан к правильному сегменту');
  });

  test('detect() пропускает точку со ссылкой на несуществующий segmentId, не падает целиком', async () => {
    const prisma = createFakePrisma();
    seedTwoSpeakerConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { segmentId: 'does-not-exist', technique: 'x', description: 'y' },
      { segmentId: 'seg-self', technique: 'ложная дилемма', description: 'реальная точка' },
    ]);
    const svc = new ManipulationDetectorService(prisma as any, fakeRouter as any);

    const created = await svc.detect(USER_ID, CONV_ID);
    assertEqual(created.length, 1, 'только валидная точка создана');
  });

  test('detect() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedTwoSpeakerConversation(prisma);
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new ManipulationDetectorService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.detect(USER_ID, CONV_ID), BadGatewayException, 'detect() при недоступности провайдера');
  });

  test('list() восстанавливает technique/description из AIInference и сортирует по порядку сегментов', async () => {
    const prisma = createFakePrisma();
    seedTwoSpeakerConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { segmentId: 'seg-self', technique: 'переход на личности', description: 'x' },
      { segmentId: 'seg-other', technique: 'whataboutism', description: 'y' },
    ]);
    const svc = new ManipulationDetectorService(prisma as any, fakeRouter as any);
    await svc.detect(USER_ID, CONV_ID);
    // FakeAIRouterService не создаёт реальную запись AIInference (в
    // отличие от настоящего AIRouterService) — засеиваем её вручную с
    // тем же output, что вернул фейковый роутер, иначе
    // resolveTechniqueAndDescription() не найдёт, что резолвить.
    prisma._seedAIInference({ id: fakeRouter.aiInferenceId, output: fakeRouter.responseText });

    const list = await svc.list(USER_ID, CONV_ID);
    assertEqual(list.length, 2, 'оба сигнала видны через list() без нового AI-вызова');
    assertEqual(list[0].technique, 'переход на личности', 'technique восстановлен для первого по порядку сегмента');
    assertEqual(list[1].technique, 'whataboutism', 'technique восстановлен для второго');
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
  console.log(`\nManipulationDetectorService: ${results.length - failed.length}/${results.length} passed\n`);
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

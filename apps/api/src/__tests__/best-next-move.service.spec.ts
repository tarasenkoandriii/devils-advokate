import { BestNextMoveService } from '../best-next-move/best-next-move.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const conversations = new Map<string, any>();
  const transcripts = new Map<string, any>();
  const segments = new Map<string, any>();
  const participants = new Map<string, any>();
  const objectives = new Map<string, any>();
  const recommendations: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedConversation(c: any) { conversations.set(c.id, c); },
    _seedTranscript(t: any) { transcripts.set(t.id, t); },
    _seedSegment(s: any) { segments.set(s.id, s); },
    _seedParticipant(p: any) { participants.set(p.id, p); },
    _seedObjective(projectId: string, o: any) { objectives.set(projectId, o); },
    _getRecommendations() { return recommendations; },

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
    decisionObjective: {
      findUnique: async ({ where }: any) => objectives.get(where.projectId) ?? null,
    },
    promptVersion: {
      findFirst: async () => null,
    },
    bestNextMoveRecommendation: {
      create: async ({ data }: any) => {
        const r = { id: nextId(), createdAt: new Date(), ...data };
        recommendations.push(r);
        return r;
      },
      findFirst: async ({ where, orderBy }: any) => {
        const matching = recommendations.filter((r) => r.conversationId === where.conversationId);
        if (matching.length === 0) return null;
        if (orderBy?.createdAt === 'desc') {
          return matching.reduce((latest, r) => (r.createdAt > latest.createdAt ? r : latest));
        }
        return matching[0];
      },
    },
  };
}

class FakeAIRouterService {
  responseText = '{}';
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
  prisma._seedSegment({ id: 'seg-1', transcriptId: 'transcript-1', participantId: 'part-a', text: 'Мы почти договорились.' });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('detect() бросает BadRequestException, если статус не TRANSCRIBED/ANALYZED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'UPLOADED' });
    const svc = new BestNextMoveService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.detect(USER_ID, CONV_ID), BadRequestException, 'detect() при статусе UPLOADED');
  });

  test('detect() бросает NotFoundException для чужого разговора', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED' });
    const svc = new BestNextMoveService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.detect(USER_ID, CONV_ID), NotFoundException, 'detect() на чужой разговор');
  });

  test('detect() бросает BadRequestException, если нет сегментов транскрипта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID, status: 'TRANSCRIBED' });
    prisma._seedTranscript({ id: 'transcript-1', conversationId: CONV_ID });
    const svc = new BestNextMoveService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.detect(USER_ID, CONV_ID), BadRequestException, 'detect() без сегментов');
  });

  test('detect() создаёт рекомендацию с 4 базовыми полями + whyNotAlternative/whatCouldChange (§3.55)', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({
      bestAction: 'Написать письмо с подтверждением договорённостей.',
      alternative: 'Позвонить и обсудить устно.',
      avoid: 'Не откладывать более чем на 2 дня.',
      why: 'Пока детали свежи в памяти обеих сторон.',
      whyNotAlternative: 'Устный разговор не оставляет документального следа для обеих сторон.',
      whatCouldChange: 'Если собеседник явно предпочитает звонки — стоит начать со звонка.',
    });
    const svc = new BestNextMoveService(prisma as any, fakeRouter as any);

    const rec = await svc.detect(USER_ID, CONV_ID);
    assertEqual(rec.bestAction, 'Написать письмо с подтверждением договорённостей.', 'bestAction сохранён');
    assertEqual(rec.alternative, 'Позвонить и обсудить устно.', 'alternative сохранён');
    assertEqual(rec.avoid, 'Не откладывать более чем на 2 дня.', 'avoid сохранён');
    assertEqual(rec.why, 'Пока детали свежи в памяти обеих сторон.', 'why сохранён');
    assertEqual(
      rec.whyNotAlternative,
      'Устный разговор не оставляет документального следа для обеих сторон.',
      'whyNotAlternative сохранён (§3.55)',
    );
    assertEqual(
      rec.whatCouldChange,
      'Если собеседник явно предпочитает звонки — стоит начать со звонка.',
      'whatCouldChange сохранён (§3.55)',
    );
    assertEqual(rec.generatedByInferenceId, 'inference-1', 'provenance сохранён');
  });

  test('detect() не падает, если AI не прислал whyNotAlternative/whatCouldChange (backward-совместимость §3.55)', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    // Ответ в старом формате (только 4 обязательных поля, без §3.55) —
    // isValidRecommendationPayload() их не требует специально для этого.
    fakeRouter.responseText = JSON.stringify({ bestAction: 'x', alternative: 'y', avoid: 'z', why: 'w' });
    const svc = new BestNextMoveService(prisma as any, fakeRouter as any);

    const rec = await svc.detect(USER_ID, CONV_ID);
    assertEqual(rec.whyNotAlternative, null, 'whyNotAlternative=null, если AI не прислал (не падаем)');
    assertEqual(rec.whatCouldChange, null, 'whatCouldChange=null, если AI не прислал (не падаем)');
  });

  test('detect() подмешивает DecisionObjective.desiredOutcome в промпт, если он есть', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    prisma._seedObjective(PROJECT_ID, { desiredOutcome: 'Получить согласие на удалённую работу' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ bestAction: 'x', alternative: 'y', avoid: 'z', why: 'w' });
    const svc = new BestNextMoveService(prisma as any, fakeRouter as any);

    await svc.detect(USER_ID, CONV_ID);
    assertEqual(
      fakeRouter.lastRequest.userPrompt.includes('Получить согласие на удалённую работу'),
      true,
      'цель разговора попала в промпт',
    );
  });

  test('detect() не падает, если DecisionObjective ещё не заполнен', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma); // объективы не засеяны
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify({ bestAction: 'x', alternative: 'y', avoid: 'z', why: 'w' });
    const svc = new BestNextMoveService(prisma as any, fakeRouter as any);

    const rec = await svc.detect(USER_ID, CONV_ID);
    assertEqual(rec.bestAction, 'x', 'детекция работает без DecisionObjective');
  });

  test('getLatest() возвращает самую свежую рекомендацию, не первую созданную', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    const svc = new BestNextMoveService(prisma as any, fakeRouter as any);

    fakeRouter.responseText = JSON.stringify({ bestAction: 'Старая рекомендация', alternative: 'a', avoid: 'b', why: 'c' });
    await svc.detect(USER_ID, CONV_ID);
    await new Promise((r) => setTimeout(r, 5));
    fakeRouter.responseText = JSON.stringify({ bestAction: 'Новая рекомендация', alternative: 'a', avoid: 'b', why: 'c' });
    await svc.detect(USER_ID, CONV_ID);

    const latest = await svc.getLatest(USER_ID, CONV_ID);
    assertEqual(latest?.bestAction, 'Новая рекомендация', 'возвращена именно последняя по времени');
    assertEqual(prisma._getRecommendations().length, 2, 'старая рекомендация не удалена, сохранена рядом');
  });

  test('getLatest() возвращает null, если рекомендаций ещё не было', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    const svc = new BestNextMoveService(prisma as any, new FakeAIRouterService() as any);
    const latest = await svc.getLatest(USER_ID, CONV_ID);
    assertEqual(latest, null, 'null при отсутствии рекомендаций');
  });

  // Пункт 32 (расширенный аудит тестов) — ветка BadGatewayException в
  // detect() не тестировалась ни разу, найдено систематической сверкой
  // всех throw new в сервисах против тестовых файлов.
  test('detect() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedTranscribedConversation(prisma);
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.execute = async () => { throw new Error('provider timeout'); };
    const svc = new BestNextMoveService(prisma as any, fakeRouter as any);
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
  console.log(`\nBestNextMoveService: ${results.length - failed.length}/${results.length} passed\n`);
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

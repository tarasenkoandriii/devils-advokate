// Пункт [multimodal] §7, фаза E — паралингвистика.
//
// Два самых важных теста здесь — про ГРАНИЦЫ:
//  • §7.4 — «детекция лжи» проваливает валидацию, а не пишется в БД;
//  • §8.2 — выдуманный моделью segmentId не порождает сигнала.
// Жизненный цикл файла (blob не удаляется до нуля потребителей)
// проверяется в conversations.service.spec.ts, сторожевая — здесь.

import {
  ParalinguisticsService,
  parseParalinguisticsOutput,
  DEFAULT_PARALINGUISTICS_PROMPT,
} from '../conversations/paralinguistics.service';

const VALID_OUTPUT = JSON.stringify({
  segments: [
    {
      segmentId: 'seg-1',
      delivery: 'пауза 1.5с перед ответом, падение темпа',
      signals: [{ type: 'DELIVERY_INCONGRUENCE', channel: 'pause', confidence: 0.6, rationale: 'согласие произнесено неуверенно' }],
    },
  ],
});

describe('parseParalinguisticsOutput — §7.4, запрет выводов о личности', () => {
  it('валидный выход с DELIVERY_INCONGRUENCE разбирается; пустой список сегментов валиден', () => {
    expect(parseParalinguisticsOutput(VALID_OUTPUT)).not.toBeNull();
    expect(parseParalinguisticsOutput('{"segments":[]}')).not.toBeNull();
  });

  it('КЛЮЧЕВОЙ ТЕСТ §7.4: «детекция лжи» в выходе — провал валидации, не запись', () => {
    const lying = VALID_OUTPUT.replace('согласие произнесено неуверенно', 'говорящий явно лжёт');
    expect(parseParalinguisticsOutput(lying)).toBeNull();
    const englishLiar = VALID_OUTPUT.replace('согласие произнесено неуверенно', 'the speaker is lying');
    expect(parseParalinguisticsOutput(englishLiar)).toBeNull();
  });

  it('типы сигналов вне белого списка (даже валидные для БД, как MANIPULATION_PATTERN) — провал: паралингвистика пишет только свои два', () => {
    const wrongType = VALID_OUTPUT.replace('DELIVERY_INCONGRUENCE', 'MANIPULATION_PATTERN');
    expect(parseParalinguisticsOutput(wrongType)).toBeNull();
  });

  it('промпт по умолчанию содержит запреты §7.4 дословно', () => {
    expect(DEFAULT_PARALINGUISTICS_PROMPT).toContain('ЗАПРЕЩЕНЫ');
    expect(DEFAULT_PARALINGUISTICS_PROMPT).toContain('детекция лжи');
    expect(DEFAULT_PARALINGUISTICS_PROMPT).toContain('не выдумывай сегменты');
  });
});

function makeDeps(segments: Array<{ id: string; participantId: string | null }>) {
  const signals: any[] = [];
  const evidence: any[] = [];
  const updates: any[] = [];
  const prisma: any = {
    _signals: signals,
    _evidence: evidence,
    _updates: updates,
    conversation: {
      findFirst: async () => ({
        id: 'conv-1',
        paralinguisticsJobId: 'job-1',
        transcript: { segments },
      }),
      findUniqueOrThrow: async () => ({
        id: 'conv-1',
        audioBlobPathname: 'conversation-audio/c/f.m4a',
        audioBlobContentType: 'audio/mp4',
        project: { id: 'p1', ownerId: 'user-1' },
        transcript: { segments: segments.map((s) => ({ ...s, startMs: 0, endMs: 1000, text: 'реплика' })) },
      }),
      update: async ({ data }: any) => {
        updates.push(data);
        return {};
      },
    },
    conversationSignal: {
      create: async ({ data }: any) => {
        signals.push(data);
        return { id: `sig-${signals.length}`, ...data };
      },
    },
    conversationSignalEvidence: {
      create: async ({ data }: any) => {
        evidence.push(data);
        return data;
      },
    },
    aIInference: { findUniqueOrThrow: async () => ({ id: 'inf-1', output: prisma._output }) },
    promptVersion: { findFirst: async () => null },
    $transaction: async (fn: (tx: unknown) => Promise<void>) => fn(prisma),
  };
  const aiRouter: any = {
    handlers: new Map<string, (o: unknown) => Promise<void>>(),
    registerOutputValidator: jest.fn(),
    registerCompletionHandler(taskType: string, handler: (o: unknown) => Promise<void>) {
      this.handlers.set(taskType, handler);
    },
    enqueue: jest.fn(async (_req: any) => ({ jobId: 'job-1' })),
  };
  return { prisma, aiRouter };
}

describe('ParalinguisticsService — персистенс и жизненный цикл', () => {
  it('КЛЮЧЕВОЙ ТЕСТ §8.2: выдуманный segmentId пропускается, валидные сигналы записываются с провенансом', async () => {
    const deps = makeDeps([{ id: 'seg-1', participantId: 'part-1' }]);
    deps.prisma._output = JSON.stringify({
      segments: [
        { segmentId: 'seg-1', signals: [{ type: 'DELIVERY_INCONGRUENCE', channel: 'prosody' }] },
        { segmentId: 'seg-INVENTED', signals: [{ type: 'EMOTIONAL_SHIFT' }] },
      ],
    });
    const svc = new ParalinguisticsService(deps.prisma, deps.aiRouter);
    svc.onModuleInit();
    const released: number[] = [];
    svc.wireRelease(async (_id, count) => {
      released.push(count ?? 1);
    });

    const handler = deps.aiRouter.handlers.get('conversation-paralinguistics');
    await handler({ kind: 'completed', jobId: 'job-1', aiInferenceId: 'inf-1' });

    expect(deps.prisma._signals).toHaveLength(1);
    expect(deps.prisma._signals[0].transcriptSegmentId).toBe('seg-1');
    expect(deps.prisma._signals[0].participantId).toBe('part-1');
    expect(deps.prisma._signals[0].paralinguisticChannel).toBe('prosody');
    expect(deps.prisma._evidence[0].aiInferenceId).toBe('inf-1');
    // Потребитель файла освобождён после персистенса.
    expect(released).toEqual([1]);
  });

  it('failed-исход тоже освобождает потребителя файла — иначе blob висит до сторожевой', async () => {
    const deps = makeDeps([{ id: 'seg-1', participantId: null }]);
    const svc = new ParalinguisticsService(deps.prisma, deps.aiRouter);
    svc.onModuleInit();
    const released: number[] = [];
    svc.wireRelease(async (_id, count) => {
      released.push(count ?? 1);
    });

    const handler = deps.aiRouter.handlers.get('conversation-paralinguistics');
    await handler({ kind: 'failed', jobId: 'job-1', reason: 'budget_exceeded' });

    expect(deps.prisma._signals).toHaveLength(0);
    expect(released).toEqual([1]);
  });

  it('enqueueForConversation: сегменты уходят в текстовую часть промпта, медиа-блок ПЕРВЫМ с mime-типом из БД', async () => {
    const deps = makeDeps([{ id: 'seg-1', participantId: null }]);
    const svc = new ParalinguisticsService(deps.prisma, deps.aiRouter);

    await svc.enqueueForConversation('conv-1');

    const req = deps.aiRouter.enqueue.mock.calls[0][0];
    expect(req.taskType).toBe('conversation-paralinguistics');
    expect(req.userId).toBe('user-1'); // владелец проекта, не аноним
    expect(req.userPrompt[0].type).toBe('media');
    expect(req.userPrompt[0].ref).toEqual({
      source: 'blob',
      pathname: 'conversation-audio/c/f.m4a',
      mimeType: 'audio/mp4',
    });
    expect(req.userPrompt[1].text).toContain('"segmentId":"seg-1"');
    // Джоба привязана к разговору — по ней обработчик найдёт его.
    expect(deps.prisma._updates.some((u: any) => u.paralinguisticsJobId === 'job-1')).toBe(true);
  });
});

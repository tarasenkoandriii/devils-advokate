// Пункт [multimodal] §6, фаза D — автоматика media-review.
//
// Обязательный тест ТЗ — СКВОЗНОЙ: «getSummary() видит сигналы
// автоматического разбора». Он проверяет цепочку персистенса целиком
// (участники → транскрипт → сегменты → сигналы → сводка), а не
// отдельные шаги: именно разрыв этой цепочки дал бы тихо пустую фичу
// (сводка считает сигналы ЧЕРЕЗ сегменты — §6.2).

import {
  MediaReviewAutoService,
  parseMediaReviewOutput,
  timecodeToMs,
  MEDIA_REVIEW_MAX_DURATION_SECONDS,
} from '../media-review/media-review-auto.service';
import { MediaReviewService } from '../media-review/media-review.service';

// ── фейковый Prisma с достаточной для сквозного теста поверхностью ──
function makeFakePrisma() {
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const store = {
    items: new Map<string, any>(),
    queues: new Map<string, any>(),
    jobs: new Map<string, any>(),
    conversations: new Map<string, any>(),
    participants: new Map<string, any>(),
    transcripts: new Map<string, any>(),
    segments: new Map<string, any>(),
    signals: new Map<string, any>(),
    evidence: [] as any[],
    inferences: new Map<string, any>(),
  };
  const prisma: any = {
    _store: store,
    mediaReviewQueue: {
      findUniqueOrThrow: async ({ where }: any) => store.queues.get(where.id),
      findUnique: async ({ where }: any) => store.queues.get(where.id) ?? null,
    },
    mediaReviewQueueItem: {
      findFirst: async ({ where }: any) => {
        if (where.aiJobId) {
          return [...store.items.values()].find((i) => i.aiJobId === where.aiJobId) ?? null;
        }
        // retryAnalysis: поиск по id с проверкой владельца через queue
        if (where.id) {
          const item = store.items.get(where.id);
          if (!item) return null;
          const queue = store.queues.get(item.queueId);
          if (where.queue?.userId && queue?.userId !== where.queue.userId) return null;
          return { ...item, queue: queue ? { id: queue.id, projectId: queue.projectId } : undefined };
        }
        return null;
      },
      findUniqueOrThrow: async ({ where }: any) => store.items.get(where.id),
      update: async ({ where, data }: any) => {
        const item = { ...store.items.get(where.id), ...data };
        store.items.set(where.id, item);
        return item;
      },
      findMany: async ({ where }: any) =>
        [...store.items.values()].filter(
          (i) => i.queueId === where.queueId && (!where.conversationId || i.conversationId !== null),
        ),
      aggregate: async () => ({ _max: { orderIndex: 0 } }),
    },
    conversation: {
      create: async ({ data }: any) => {
        const c = { id: id('conv'), ...data };
        store.conversations.set(c.id, c);
        return c;
      },
      update: async ({ where, data }: any) => {
        const c = { ...store.conversations.get(where.id), ...data };
        store.conversations.set(where.id, c);
        return c;
      },
    },
    conversationParticipant: {
      upsert: async ({ where, create }: any) => {
        const key = `${where.conversationId_diarizationLabel.conversationId}:${where.conversationId_diarizationLabel.diarizationLabel}`;
        if (store.participants.has(key)) return store.participants.get(key);
        const p = { id: id('part'), ...create };
        store.participants.set(key, p);
        return p;
      },
    },
    transcript: {
      upsert: async ({ where, create, update }: any) => {
        const existing = [...store.transcripts.values()].find((t) => t.conversationId === where.conversationId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const t = { id: id('tr'), ...create };
        store.transcripts.set(t.id, t);
        return t;
      },
    },
    transcriptSegment: {
      create: async ({ data }: any) => {
        const s = { id: id('seg'), ...data };
        store.segments.set(s.id, s);
        return s;
      },
      deleteMany: async ({ where }: any) => {
        for (const [k, v] of [...store.segments]) if (v.transcriptId === where.transcriptId) store.segments.delete(k);
        return { count: 0 };
      },
      findMany: async ({ where }: any) => {
        // getSummary: where: { transcript: { conversationId: { in: [...] } } }
        const convIds: string[] = where.transcript.conversationId.in;
        const trIds = [...store.transcripts.values()]
          .filter((t) => convIds.includes(t.conversationId))
          .map((t) => t.id);
        return [...store.segments.values()].filter((s) => trIds.includes(s.transcriptId)).map((s) => ({ id: s.id }));
      },
    },
    conversationSignal: {
      create: async ({ data }: any) => {
        const s = { id: id('sig'), ...data };
        store.signals.set(s.id, s);
        return s;
      },
      deleteMany: async ({ where }: any) => {
        const trId = [...store.transcripts.values()][0]?.id;
        void where;
        void trId;
        return { count: 0 };
      },
      count: async ({ where }: any) =>
        [...store.signals.values()].filter(
          (s) => s.signalType === where.signalType && where.transcriptSegmentId.in.includes(s.transcriptSegmentId),
        ).length,
    },
    conversationSignalEvidence: {
      create: async ({ data }: any) => {
        store.evidence.push(data);
        return data;
      },
    },
    aIInference: {
      findUniqueOrThrow: async ({ where }: any) => store.inferences.get(where.id),
    },
    aIJob: {
      findUnique: async ({ where }: any) => (store as any).jobs?.get(where.id) ?? null,
    },
    promptVersion: { findFirst: async () => null },
    $transaction: async (fn: (tx: unknown) => Promise<void>) => fn(prisma),
  };
  return prisma;
}

const MODEL_OUTPUT = JSON.stringify({
  language: 'ru',
  segments: [
    {
      start: '0:05', end: '0:12', speakerLabel: 'SPEAKER_00',
      text: 'Мы никогда этого не обещали.',
      delivery: 'ускорение темпа, пауза перед «никогда»',
      signals: [{ type: 'MANIPULATION_PATTERN', channel: 'prosody', confidence: 0.7, rationale: 'газлайтинг-паттерн' }],
    },
    {
      start: '0:13', end: '0:20', speakerLabel: 'SPEAKER_01',
      text: 'Вот запись, где вы это говорите.',
      signals: [],
    },
  ],
});

describe('timecodeToMs / parseMediaReviewOutput', () => {
  it('MM:SS и H:MM:SS конвертируются на нашей стороне; числа принимаются как готовые мс', () => {
    expect(timecodeToMs('0:05')).toBe(5000);
    expect(timecodeToMs('12:34')).toBe(754000);
    expect(timecodeToMs('1:02:03')).toBe(3723000);
    expect(timecodeToMs(1500)).toBe(1500);
    expect(timecodeToMs('mm:ss')).toBeNull();
  });

  it('валидный выход разбирается; сигнал вне белого списка типов — провал целиком', () => {
    expect(parseMediaReviewOutput(MODEL_OUTPUT)).not.toBeNull();
    const bad = MODEL_OUTPUT.replace('MANIPULATION_PATTERN', 'LIE_DETECTED');
    expect(parseMediaReviewOutput(bad)).toBeNull();
  });

  it('```-заборы вокруг JSON снимаются; мусор вместо JSON — null', () => {
    expect(parseMediaReviewOutput('```json\n' + MODEL_OUTPUT + '\n```')).not.toBeNull();
    expect(parseMediaReviewOutput('просто текст')).toBeNull();
    expect(parseMediaReviewOutput('{"segments":[]}')).toBeNull(); // пустой разбор — не разбор
  });
});

describe('tryEnqueueAnalysis — лимит длительности (§6.5)', () => {
  it('ролик длиннее 20 минут получает отказ ДО вызова провайдера, элемент остаётся на ручном пути', async () => {
    const prisma = makeFakePrisma();
    const aiRouter = { enqueue: jest.fn(), registerOutputValidator: jest.fn(), registerCompletionHandler: jest.fn() };
    const svc = new MediaReviewAutoService(prisma as any, aiRouter as any);
    prisma._store.items.set('item-1', { id: 'item-1' });

    await svc.tryEnqueueAnalysis(
      'user-1',
      { id: 'q1', projectId: 'p1' },
      { id: 'item-1', youtubeVideoId: 'v', title: 't', durationSeconds: MEDIA_REVIEW_MAX_DURATION_SECONDS + 1, publishedAt: null, createdAt: new Date() },
    );

    expect(aiRouter.enqueue).not.toHaveBeenCalled();
    expect(prisma._store.items.get('item-1').autoAnalysisError).toContain('минут');
  });

  it('неизвестная длительность — тоже отказ: лимит стоимости проверить нечем', async () => {
    const prisma = makeFakePrisma();
    const aiRouter = { enqueue: jest.fn(), registerOutputValidator: jest.fn(), registerCompletionHandler: jest.fn() };
    const svc = new MediaReviewAutoService(prisma as any, aiRouter as any);
    prisma._store.items.set('item-1', { id: 'item-1' });

    await svc.tryEnqueueAnalysis(
      'user-1',
      { id: 'q1', projectId: 'p1' },
      { id: 'item-1', youtubeVideoId: 'v', title: 't', durationSeconds: null, publishedAt: null, createdAt: new Date() },
    );

    expect(aiRouter.enqueue).not.toHaveBeenCalled();
    expect(prisma._store.items.get('item-1').autoAnalysisError).toContain('неизвестна');
  });

  it('успешная постановка: Conversation(PUBLIC_VIDEO_URI, ANALYZING), медиа-блок ПЕРВЫМ, occurredAt из publishedAt', async () => {
    const prisma = makeFakePrisma();
    const aiRouter = {
      enqueue: jest.fn(async (_req: any) => ({ jobId: 'job-1' })),
      registerOutputValidator: jest.fn(),
      registerCompletionHandler: jest.fn(),
    };
    const svc = new MediaReviewAutoService(prisma as any, aiRouter as any);
    prisma._store.items.set('item-1', { id: 'item-1' });
    const publishedAt = new Date('2026-01-15T10:00:00Z');

    await svc.tryEnqueueAnalysis(
      'user-1',
      { id: 'q1', projectId: 'p1' },
      { id: 'item-1', youtubeVideoId: 'abc', title: 't', durationSeconds: 300, publishedAt, createdAt: new Date() },
    );

    const conv = [...prisma._store.conversations.values()][0];
    expect(conv.sourceType).toBe('PUBLIC_VIDEO_URI');
    expect(conv.status).toBe('ANALYZING');
    expect(conv.occurredAt).toBe(publishedAt);
    expect(conv.rawFileRef).toBe('https://www.youtube.com/watch?v=abc');

    const req = aiRouter.enqueue.mock.calls[0][0];
    expect(req.userPrompt[0].type).toBe('media'); // медиа первым (§5)
    expect(req.userPrompt[0].ref).toEqual({ source: 'youtube', videoId: 'abc' });
    expect(prisma._store.items.get('item-1').status).toBe('PROCESSING');
    expect(prisma._store.items.get('item-1').aiJobId).toBe('job-1');
  });
});

describe('retryAnalysis — повторный запуск после 429/сбоя (кнопка «Повторить»)', () => {
  function seedFailedItem(prisma: any) {
    prisma._store.queues.set('q1', { id: 'q1', userId: 'user-1', projectId: 'p1' });
    prisma._store.conversations.set('conv-1', { id: 'conv-1', projectId: 'p1', status: 'FAILED' });
    prisma._store.items.set('item-1', {
      id: 'item-1', queueId: 'q1', youtubeVideoId: 'abc', title: 't',
      durationSeconds: 300, publishedAt: null, createdAt: new Date(),
      status: 'AWAITING_UPLOAD', conversationId: 'conv-1', aiJobId: 'job-old',
      autoAnalysisError: 'провайдер отверг опрос задачи (HTTP 429 …)',
    });
    prisma._store.jobs.set('job-old', { id: 'job-old', status: 'FAILED' });
  }

  it('КЛЮЧЕВОЙ ТЕСТ: разговор ПЕРЕИСПОЛЬЗУЕТСЯ (ANALYZING, без дубликата), новая джоба, ошибка очищена', async () => {
    const prisma = makeFakePrisma();
    const aiRouter = {
      enqueue: jest.fn(async () => ({ jobId: 'job-new' })),
      registerOutputValidator: jest.fn(),
      registerCompletionHandler: jest.fn(),
    };
    const svc = new MediaReviewAutoService(prisma as any, aiRouter as any);
    seedFailedItem(prisma);

    const res = await svc.retryAnalysis('user-1', 'item-1');

    expect(aiRouter.enqueue).toHaveBeenCalledTimes(1);
    // Дубликат Conversation не создан — §6.1: один разговор на элемент.
    expect(prisma._store.conversations.size).toBe(1);
    expect(prisma._store.conversations.get('conv-1').status).toBe('ANALYZING');
    const item = prisma._store.items.get('item-1');
    expect(item.status).toBe('PROCESSING');
    expect(item.aiJobId).toBe('job-new');
    expect(item.autoAnalysisError).toBeNull();
    expect(res.status).toBe('PROCESSING');
  });

  it('активная джоба (QUEUED/RUNNING) → отказ: двойная постановка = двойной счёт провайдеру', async () => {
    const prisma = makeFakePrisma();
    const aiRouter = { enqueue: jest.fn(), registerOutputValidator: jest.fn(), registerCompletionHandler: jest.fn() };
    const svc = new MediaReviewAutoService(prisma as any, aiRouter as any);
    seedFailedItem(prisma);
    prisma._store.jobs.set('job-old', { id: 'job-old', status: 'RUNNING' });

    await expect(svc.retryAnalysis('user-1', 'item-1')).rejects.toThrow(/выполняется/);
    expect(aiRouter.enqueue).not.toHaveBeenCalled();
  });

  it('чужой элемент неотличим от несуществующего; DONE не перезапускается', async () => {
    const prisma = makeFakePrisma();
    const aiRouter = { enqueue: jest.fn(), registerOutputValidator: jest.fn(), registerCompletionHandler: jest.fn() };
    const svc = new MediaReviewAutoService(prisma as any, aiRouter as any);
    seedFailedItem(prisma);

    await expect(svc.retryAnalysis('someone-else', 'item-1')).rejects.toThrow(/не найден/);

    prisma._store.items.get('item-1').status = 'DONE';
    await expect(svc.retryAnalysis('user-1', 'item-1')).rejects.toThrow(/уже разобран/);
    expect(aiRouter.enqueue).not.toHaveBeenCalled();
  });
});

describe('СКВОЗНОЙ ОБЯЗАТЕЛЬНЫЙ ТЕСТ ТЗ: getSummary() видит сигналы автоматического разбора', () => {
  it('персистенс §6.2 → сводка очереди считает сигналы через сегменты', async () => {
    const prisma = makeFakePrisma();
    const aiRouter = { enqueue: jest.fn(), registerOutputValidator: jest.fn(), registerCompletionHandler: jest.fn() };
    const autoSvc = new MediaReviewAutoService(prisma as any, aiRouter as any);

    // Состояние «джоба завершилась»: элемент PROCESSING с разговором.
    prisma._store.queues.set('q1', { id: 'q1', userId: 'user-1', projectId: 'p1' });
    const conv = await prisma.conversation.create({ data: { projectId: 'p1', status: 'ANALYZING' } });
    prisma._store.items.set('item-1', {
      id: 'item-1', queueId: 'q1', aiJobId: 'job-1', conversationId: conv.id, status: 'PROCESSING',
    });
    prisma._store.inferences.set('inf-1', { id: 'inf-1', output: MODEL_OUTPUT });

    await autoSvc.persistAnalysis('item-1', 'inf-1');

    // Всё, что обещает §6.2, на месте:
    const participants = [...prisma._store.participants.values()];
    expect(participants).toHaveLength(2);
    expect(participants.every((p) => !p.isSelf)).toBe(true); // наблюдатель, не участник
    const segments = [...prisma._store.segments.values()];
    expect(segments).toHaveLength(2);
    expect(segments[0].startMs).toBe(5000); // MM:SS сконвертирован
    expect(prisma._store.conversations.get(conv.id).status).toBe('ANALYZED');
    expect(prisma._store.items.get('item-1').status).toBe('DONE');
    // Провенанс: каждый сигнал ссылается на AIInference.
    expect(prisma._store.evidence.every((e: any) => e.aiInferenceId === 'inf-1')).toBe(true);

    // И САМА СВОДКА — через настоящий MediaReviewService.getSummary().
    const mediaReview = new MediaReviewService(prisma as any, { tryEnqueueAnalysis: async () => undefined } as any);
    const summary = await mediaReview.getSummary('user-1', 'q1');
    expect(summary.manipulationSignals).toBe(1);
    expect(summary.doneItems).toBe(1);
  });
});

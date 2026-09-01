import { NotFoundException } from '@nestjs/common';
import { MediaReviewService } from '../media-review/media-review.service';

function createFakePrisma() {
  const queues = new Map<string, any>();
  const items = new Map<string, any>();
  const conversations = new Map<string, any>();
  const jobs = new Map<string, any>();
  const segments: any[] = [];
  const signals: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedQueue(q: any) {
      const queue = { id: nextId(), ...q };
      queues.set(queue.id, queue);
      return queue;
    },
    _seedItem(i: any) {
      const item = { id: nextId(), status: 'AWAITING_UPLOAD', conversationId: null, ...i };
      items.set(item.id, item);
      return item;
    },
    _seedConversation(c: any) {
      const conv = { id: nextId(), status: 'UPLOADED', ...c };
      conversations.set(conv.id, conv);
      return conv;
    },
    _seedSegment(s: any) {
      segments.push({ id: nextId(), ...s });
      return segments[segments.length - 1];
    },
    _seedSignal(s: any) {
      signals.push({ id: nextId(), ...s });
    },
    _setConversationStatus(id: string, status: string) {
      conversations.get(id).status = status;
    },

    mediaReviewQueue: {
      findUniqueOrThrow: async ({ where }: any) => {
        const q = queues.get(where.id);
        if (!q) throw new Error('queue not found');
        return q;
      },
      findUnique: async ({ where }: any) => queues.get(where.id) ?? null,
      findMany: async ({ where }: any) =>
        Array.from(queues.values())
          .filter((q) => q.userId === where.userId)
          .map((q) => ({ ...q, _count: { items: Array.from(items.values()).filter((i) => i.queueId === q.id).length } })),
      create: async ({ data }: any) => {
        const q = { id: nextId(), ...data };
        queues.set(q.id, q);
        return q;
      },
    },
    mediaReviewQueueItem: {
      findUniqueOrThrow: async ({ where }: any) => {
        const it = items.get(where.id);
        if (!it) throw new Error('item not found');
        return it;
      },
      findUnique: async ({ where, include }: any) => {
        const item = items.get(where.id);
        if (!item) return null;
        if (include?.queue) return { ...item, queue: queues.get(item.queueId) };
        return item;
      },
      findMany: async ({ where, include, orderBy, select }: any) => {
        let rows = [...items.values()].filter((i) => i.queueId === where.queueId);
        if (where?.conversationId?.not === null) rows = rows.filter((i) => i.conversationId != null);
        if (orderBy?.orderIndex) rows = rows.sort((a, b) => a.orderIndex - b.orderIndex);
        if (include?.conversation) {
          rows = rows.map((i) => ({ ...i, conversation: i.conversationId ? { status: conversations.get(i.conversationId).status } : null }));
        }
        if (select) {
          rows = rows.map((i) => {
            const out: any = {};
            for (const k of Object.keys(select)) out[k] = i[k];
            return out;
          });
        }
        return rows;
      },
      aggregate: async ({ where }: any) => {
        const rows = [...items.values()].filter((i) => i.queueId === where.queueId);
        const max = rows.length > 0 ? Math.max(...rows.map((r) => r.orderIndex)) : null;
        return { _max: { orderIndex: max } };
      },
      create: async ({ data }: any) => {
        const item = { id: nextId(), status: 'AWAITING_UPLOAD', conversationId: null, ...data };
        items.set(item.id, item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = items.get(where.id);
        Object.assign(item, data);
        return item;
      },
    },
    conversation: {
      findUnique: async ({ where, include }: any) => {
        const conv = conversations.get(where.id);
        if (!conv) return null;
        if (include?.project) return { ...conv, project: { ownerId: conv.ownerId } };
        return conv;
      },
      update: async ({ where, data }: any) => {
        const conv = conversations.get(where.id);
        Object.assign(conv, data);
        return conv;
      },
    },
    aIJob: {
      findUnique: async ({ where }: any) => jobs.get(where.id) ?? null,
    },
    _seedJob(j: any) {
      const job = { id: nextId(), ...j };
      jobs.set(job.id, job);
      return job;
    },
    $transaction: async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops(undefined)),
    transcriptSegment: {
      findMany: async ({ where }: any) => {
        const convIds: string[] = where.transcript.conversationId.in;
        return segments.filter((s) => convIds.includes(s.conversationId)).map((s) => ({ id: s.id }));
      },
    },
    conversationSignal: {
      count: async ({ where }: any) => {
        return signals.filter(
          (s) => s.signalType === where.signalType && where.transcriptSegmentId.in.includes(s.transcriptSegmentId),
        ).length;
      },
    },
  };
}

function makeService(prisma: any) {
  return new MediaReviewService(prisma as any, {
    // Пункт [multimodal]: авто-разбор в этих юнит-тестах не запускается
    // — они проверяют очередь как таковую. tryEnqueueAnalysis — no-op.
    tryEnqueueAnalysis: async () => undefined,
  } as any);
}

describe('MediaReviewService', () => {
  it('acceptance-тест §6: додавання 3 відео в чергу дає AWAITING_UPLOAD з orderIndex 0/1/2', async () => {
    const prisma = createFakePrisma();
    const queue = prisma._seedQueue({ userId: 'u1', title: 'Test queue' });
    const service = makeService(prisma);

    for (let i = 0; i < 3; i++) {
      await service.addItem('u1', queue.id, {
        youtubeVideoId: `v${i}`,
        title: `Video ${i}`,
        channelName: 'Channel',
        thumbnailUrl: 'https://x.com/t.jpg',
      });
    }

    const result = await service.getQueue('u1', queue.id);
    expect(result.items.map((i: any) => i.status)).toEqual(['AWAITING_UPLOAD', 'AWAITING_UPLOAD', 'AWAITING_UPLOAD']);
    expect(result.items.map((i: any) => i.orderIndex)).toEqual([0, 1, 2]);
  });

  it('чужа черга дає NotFoundException, не витік даних іншого користувача', async () => {
    const prisma = createFakePrisma();
    const queue = prisma._seedQueue({ userId: 'owner', title: 'Private' });
    const service = makeService(prisma);

    await expect(service.getQueue('attacker', queue.id)).rejects.toThrow(NotFoundException);
  });

  it('acceptance-тест §6: linkConversation переводить елемент у READY тільки для власної Conversation', async () => {
    const prisma = createFakePrisma();
    const queue = prisma._seedQueue({ userId: 'u1', title: 'Q' });
    const item = prisma._seedItem({ queueId: queue.id, orderIndex: 0 });
    const conv = prisma._seedConversation({ ownerId: 'u1' });
    const service = makeService(prisma);

    const updated = await service.linkConversation('u1', item.id, conv.id);

    expect(updated.status).toBe('READY');
    expect(updated.conversationId).toBe(conv.id);
  });

  it('linkConversation відхиляє чужу Conversation', async () => {
    const prisma = createFakePrisma();
    const queue = prisma._seedQueue({ userId: 'u1', title: 'Q' });
    const item = prisma._seedItem({ queueId: queue.id, orderIndex: 0 });
    const conv = prisma._seedConversation({ ownerId: 'someone-else' });
    const service = makeService(prisma);

    await expect(service.linkConversation('u1', item.id, conv.id)).rejects.toThrow(NotFoundException);
  });

  it('acceptance-тест §6: READY стає DONE після завершення аналізу (Conversation.status=ANALYZED)', async () => {
    const prisma = createFakePrisma();
    const queue = prisma._seedQueue({ userId: 'u1', title: 'Q' });
    const conv = prisma._seedConversation({ ownerId: 'u1', status: 'ANALYZED' });
    prisma._seedItem({ queueId: queue.id, orderIndex: 0, status: 'READY', conversationId: conv.id });
    const service = makeService(prisma);

    const result = await service.getQueue('u1', queue.id);

    expect(result.items[0].status).toBe('DONE');
  });

  it('READY лишається PROCESSING, поки Conversation.status не ANALYZED', async () => {
    const prisma = createFakePrisma();
    const queue = prisma._seedQueue({ userId: 'u1', title: 'Q' });
    const conv = prisma._seedConversation({ ownerId: 'u1', status: 'TRANSCRIBING' });
    prisma._seedItem({ queueId: queue.id, orderIndex: 0, status: 'READY', conversationId: conv.id });
    const service = makeService(prisma);

    const result = await service.getQueue('u1', queue.id);

    expect(result.items[0].status).toBe('PROCESSING');
  });

  it('[multimodal] §6.4 КЛЮЧЕВОЙ ТЕСТ: Conversation.status=FAILED переводит элемент в AWAITING_UPLOAD, а не оставляет в PROCESSING навсегда', async () => {
    const prisma = createFakePrisma();
    const queue = prisma._seedQueue({ userId: 'u1', title: 'q' });
    const conv = prisma._seedConversation({ status: 'FAILED' });
    prisma._seedItem({ queueId: queue.id, conversationId: conv.id, status: 'PROCESSING' });
    const svc = makeService(prisma);

    const result = await svc.getQueue('u1', queue.id);

    // Без правки §6.4 общий маппинг свёл бы FAILED в PROCESSING — тот
    // самый «елемент назавжди застряг», уже однажды найденный аудитом.
    expect(result.items[0].status).toBe('AWAITING_UPLOAD');
    expect(result.items[0].autoAnalysisError).toBeTruthy();
  });

  it('КЛЮЧЕВОЙ ТЕСТ (живой прогон 2026-08-31): джоба FAILED мимо обработчика при Conversation=ANALYZING → элемент выходит из PROCESSING с причиной из джобы', async () => {
    const prisma = createFakePrisma();
    const queue = prisma._seedQueue({ userId: 'u1', title: 'q' });
    // Ручной SQL-UPDATE закрыл джобу, обработчик завершения не вызывался:
    // джоба FAILED, разговор так и остался ANALYZING.
    const conv = prisma._seedConversation({ status: 'ANALYZING' });
    const job = prisma._seedJob({ status: 'FAILED', partialResult: 'закрыто вручную при расчистке' });
    prisma._seedItem({ queueId: queue.id, conversationId: conv.id, status: 'PROCESSING', aiJobId: job.id });
    const svc = makeService(prisma);

    const result = await svc.getQueue('u1', queue.id);

    // До правки синк смотрел только на Conversation → вечный PROCESSING
    // без кнопки «Повторить». Теперь: откат + причина + разговор FAILED.
    expect(result.items[0].status).toBe('AWAITING_UPLOAD');
    expect(result.items[0].autoAnalysisError).toContain('вручную');
    expect(conv.status).toBe('FAILED');
  });

  it('фаза C: listQueues повертає лише свої черги з кількістю елементів', async () => {
    const prisma = createFakePrisma();
    const mine = prisma._seedQueue({ userId: 'u1', title: 'mine' });
    prisma._seedQueue({ userId: 'u2', title: 'other' });
    prisma._seedItem({ queueId: mine.id, orderIndex: 0, status: 'PENDING' });
    const service = makeService(prisma);
    const res = await service.listQueues('u1');
    expect(res.map((q: any) => q.title)).toEqual(['mine']);
    expect(res[0]._count.items).toBe(1);
  });

  it('РЕГРЕСІЯ (аудит): елемент, що вже перейшов у PROCESSING, стає DONE на наступному GET, коли Conversation.status=ANALYZED', async () => {
    // Раніше синхронізувався лише READY — елемент назавжди застрягав у PROCESSING.
    const prisma = createFakePrisma();
    const queue = prisma._seedQueue({ userId: 'u1', title: 'Q' });
    const conv = prisma._seedConversation({ ownerId: 'u1', status: 'TRANSCRIBING' });
    prisma._seedItem({ queueId: queue.id, orderIndex: 0, status: 'READY', conversationId: conv.id });
    const service = makeService(prisma);

    const first = await service.getQueue('u1', queue.id);
    expect(first.items[0].status).toBe('PROCESSING');

    conv.status = 'ANALYZED';
    const second = await service.getQueue('u1', queue.id);
    expect(second.items[0].status).toBe('DONE');
  });

  it('getSummary агрегує вже наявні ConversationSignal по всіх розмовах черги (§2.3 ТЗ, п.5)', async () => {
    const prisma = createFakePrisma();
    const queue = prisma._seedQueue({ userId: 'u1', title: 'Q' });
    const conv1 = prisma._seedConversation({ ownerId: 'u1', status: 'ANALYZED' });
    const conv2 = prisma._seedConversation({ ownerId: 'u1', status: 'ANALYZED' });
    prisma._seedItem({ queueId: queue.id, orderIndex: 0, status: 'DONE', conversationId: conv1.id });
    prisma._seedItem({ queueId: queue.id, orderIndex: 1, status: 'DONE', conversationId: conv2.id });

    const seg1 = prisma._seedSegment({ conversationId: conv1.id });
    const seg2 = prisma._seedSegment({ conversationId: conv2.id });
    prisma._seedSignal({ signalType: 'MANIPULATION_PATTERN', transcriptSegmentId: seg1.id });
    prisma._seedSignal({ signalType: 'MANIPULATION_PATTERN', transcriptSegmentId: seg2.id });
    prisma._seedSignal({ signalType: 'FACTUAL_DISCREPANCY', transcriptSegmentId: seg1.id });

    const service = makeService(prisma);
    const summary = await service.getSummary('u1', queue.id);

    expect(summary.totalItems).toBe(2);
    expect(summary.doneItems).toBe(2);
    expect(summary.manipulationSignals).toBe(2);
    expect(summary.discrepancySignals).toBe(1);
  });

  it('getSummary на порожній черзі повертає нулі, не падає', async () => {
    const prisma = createFakePrisma();
    const queue = prisma._seedQueue({ userId: 'u1', title: 'Empty' });
    const service = makeService(prisma);

    const summary = await service.getSummary('u1', queue.id);

    expect(summary).toEqual({ totalItems: 0, doneItems: 0, manipulationSignals: 0, discrepancySignals: 0 });
  });
});

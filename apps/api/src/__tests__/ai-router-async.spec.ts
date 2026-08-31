// Пункт [multimodal] §4, фаза B — асинхронная полоса роутера.
//
// Что здесь проверяется: enqueue сохраняет сериализуемый запрос с
// MediaRef (не URL) и владельцем; execute отвергает медиа; pollRunning
// маппит терминальные статусы провайдера; сторожевая различает QUEUED
// и RUNNING; hashInput стабилен относительно presign.
//
// ЧЕСТНАЯ ГРАНИЦА: SKIP LOCKED — семантика Postgres, юнит-тестом на
// фейковой БД её не проверить. Здесь фиксируется, что claim-запрос
// действительно отправляется с FOR UPDATE SKIP LOCKED (строковая
// проверка шаблона) — настоящая проверка двойного забора возможна
// только против живой БД, что названо и в ТЗ (§12.2).

import { ForbiddenException } from '@nestjs/common';
import { AIRouterService, PendingRequestPayload } from '../ai-router/ai-router.service';

const USER = 'user-1';

function makeDeps() {
  const jobs = new Map<string, any>();
  let idCounter = 0;
  const rawQueries: string[] = [];

  const prisma = {
    _jobs: jobs,
    _rawQueries: rawQueries,
    aIJob: {
      create: jest.fn(async ({ data }: any) => {
        const job = { id: `job-${++idCounter}`, retryCount: 0, ...data };
        jobs.set(job.id, job);
        return job;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const job = { ...jobs.get(where.id) };
        for (const [k, v] of Object.entries(data)) {
          job[k] = typeof v === 'object' && v !== null && 'increment' in (v as object)
            ? (job[k] ?? 0) + (v as { increment: number }).increment
            : v;
        }
        jobs.set(where.id, job);
        return job;
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const job = jobs.get(where.id);
        if (!job) throw new Error('job not found');
        return {
          ...job,
          modelVersion: {
            id: 'mv-google', version: 'gemini-test',
            model: { name: 'gemini', provider: { name: 'google', apiEndpoint: 'https://g.example', credentialRef: 'GEMINI_API_KEY' } },
          },
        };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const job = jobs.get(where.id);
        return job ? { ...job, inferences: [] } : null;
      }),
      findMany: jest.fn(async (): Promise<any[]> => []),
    },
    aIInference: {
      create: jest.fn(async ({ data }: any) => ({ id: `inf-${++idCounter}`, ...data })),
    },
    aIModelCapability: {
      findFirst: jest.fn(async ({ where }: any) => ({
        _where: where,
        modelVersion: {
          id: 'mv-google', version: 'gemini-test',
          model: { name: 'gemini', provider: { name: 'google', apiEndpoint: 'https://g.example', credentialRef: 'GEMINI_API_KEY' } },
        },
      })),
    },
    contentScanResult: { updateMany: jest.fn(async () => ({ count: 1 })) },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray): Promise<Array<{ id: string }>> => {
      rawQueries.push(strings.join('?'));
      return [];
    }),
  };
  const secrets = { resolve: jest.fn(async () => 'key') };
  const consent = {
    requireConsent: jest.fn(async () => undefined),
    assertAudioMayLeaveDevice: jest.fn(async () => undefined),
  };
  const contentScan = {
    scan: jest.fn(async ({ text }: any) => ({ blocked: false, sanitizedText: text, resultId: `scan-${++idCounter}`, detectionsCount: 0 })),
  };
  const mediaResolver = { resolve: jest.fn(async () => ({ uri: 'https://resolved.example/x' })) };
  return { prisma, secrets, consent, contentScan, mediaResolver };
}

function makeRouter(deps: ReturnType<typeof makeDeps>) {
  return new AIRouterService(
    deps.prisma as any,
    deps.secrets as any,
    deps.consent as any,
    deps.contentScan as any,
    deps.mediaResolver as any,
  );
}

describe('AIRouterService.execute — граница синхронного пути', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: медиа-блоки в execute() отвергаются — они не помещаются в maxDuration функции', async () => {
    const deps = makeDeps();
    const router = makeRouter(deps);
    await expect(
      router.execute({
        userId: USER,
        taskType: 'media-public-review',
        userPrompt: [{ type: 'media', ref: { source: 'youtube', videoId: 'v' } }],
      }),
    ).rejects.toThrow(/enqueue/);
    expect(deps.prisma.aIJob.create).not.toHaveBeenCalled();
  });
});

describe('AIRouterService.enqueue', () => {
  it('сохраняет pendingRequest с MediaRef (не URL), lease и владельца', async () => {
    const deps = makeDeps();
    const router = makeRouter(deps);

    const { jobId } = await router.enqueue({
      userId: USER,
      projectId: 'proj-1',
      taskType: 'media-public-review',
      userPrompt: [
        { type: 'media', ref: { source: 'youtube', videoId: 'abc' } },
        { type: 'text', text: 'промпт' },
      ],
    });

    const job = deps.prisma._jobs.get(jobId);
    expect(job.requestUserId).toBe(USER);
    expect(job.leaseExpiresAt).toBeInstanceOf(Date);
    const payload = job.pendingRequest as PendingRequestPayload;
    // МЕДИА ХРАНИТСЯ КАК MediaRef: подписанный URL протухает и убил бы
    // дедупликацию по inputHash (§10.1). Резолвер на этапе enqueue не
    // вызывается вовсе.
    expect(JSON.stringify(payload.userPrompt)).toContain('"videoId":"abc"');
    expect(JSON.stringify(payload.userPrompt)).not.toContain('resolved.example');
    expect(deps.mediaResolver.resolve).not.toHaveBeenCalled();
  });

  it('inputHash стабилен между двумя enqueue одного MediaRef (дедупликация)', async () => {
    const deps = makeDeps();
    const router = makeRouter(deps);
    const req = {
      userId: USER,
      taskType: 'media-public-review',
      userPrompt: [{ type: 'media' as const, ref: { source: 'youtube' as const, videoId: 'same' } }],
    };
    const { jobId: j1 } = await router.enqueue({ ...req });
    const { jobId: j2 } = await router.enqueue({ ...req });
    expect(deps.prisma._jobs.get(j1).inputHash).toBe(deps.prisma._jobs.get(j2).inputHash);
  });

  it('КЛЮЧЕВОЙ ТЕСТ §10.4: blob-медиа требует assertAudioMayLeaveDevice — роутер стал седьмой точкой проверки', async () => {
    const deps = makeDeps();
    deps.consent.assertAudioMayLeaveDevice = jest.fn(async () => {
      throw new ForbiddenException('MAXIMUM_PRIVACY');
    });
    const router = makeRouter(deps);

    await expect(
      router.enqueue({
        userId: USER,
        taskType: 'conversation-paralinguistics',
        userPrompt: [{ type: 'media', ref: { source: 'blob', pathname: 'conversation-audio/c/f.m4a', mimeType: 'audio/mp4' } }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Публичное YouTube-видео той же проверки НЕ требует: своих данных
    // пользователя там нет (§9.1).
    deps.consent.assertAudioMayLeaveDevice = jest.fn(async () => {
      throw new Error('не должно вызываться');
    });
    await expect(
      router.enqueue({
        userId: USER,
        taskType: 'media-public-review',
        userPrompt: [{ type: 'media', ref: { source: 'youtube', videoId: 'v' } }],
      }),
    ).resolves.toBeDefined();
  });
});

describe('AIRouterService — воркер', () => {
  it('claim-запрос идёт с FOR UPDATE SKIP LOCKED (двойной забор = двойной счёт провайдеру)', async () => {
    const deps = makeDeps();
    const router = makeRouter(deps);
    await router.submitQueued(3);
    await router.pollRunning(10);
    expect(deps.prisma._rawQueries.some((q) => q.includes('FOR UPDATE SKIP LOCKED') && q.includes("status = 'QUEUED'"))).toBe(true);
    expect(deps.prisma._rawQueries.some((q) => q.includes('FOR UPDATE SKIP LOCKED') && q.includes("status = 'RUNNING'"))).toBe(true);
  });

  it('pollRunning: completed → AIInference + COMPLETED + очистка pendingRequest; уведомляется обработчик', async () => {
    const deps = makeDeps();
    const router = makeRouter(deps);
    const outcomes: unknown[] = [];
    router.registerCompletionHandler('media-public-review', async (o) => {
      outcomes.push(o);
    });

    const { jobId } = await router.enqueue({
      userId: USER,
      taskType: 'media-public-review',
      userPrompt: [{ type: 'media', ref: { source: 'youtube', videoId: 'v' } }],
    });
    await deps.prisma.aIJob.update({ where: { id: jobId }, data: { status: 'RUNNING', externalInteractionId: 'int-1' } });
    deps.prisma.$queryRaw = jest.fn(async (strings: TemplateStringsArray): Promise<Array<{ id: string }>> => {
      deps.prisma._rawQueries.push(strings.join('?'));
      return [{ id: jobId }];
    });
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ id: 'int-1', status: 'completed', output_text: 'result-text' }),
      text: async () => JSON.stringify({ id: 'int-1', status: 'completed', output_text: 'result-text' }),
    } as unknown as Response);

    const res = await router.pollRunning(10);
    jest.restoreAllMocks();

    expect(res.completed).toBe(1);
    const job = deps.prisma._jobs.get(jobId);
    expect(job.status).toBe('COMPLETED');
    expect(job.pendingRequest).toBeDefined(); // Prisma.DbNull-маркер, не payload
    expect(String(job.pendingRequest)).not.toContain('videoId');
    expect(outcomes).toHaveLength(1);
    expect((outcomes[0] as { kind: string }).kind).toBe('completed');
  });

  it('pollRunning: budget_exceeded → FAILED без ретрая, с внятным сообщением про квоту', async () => {
    const deps = makeDeps();
    const router = makeRouter(deps);
    const { jobId } = await router.enqueue({
      userId: USER,
      taskType: 'media-public-review',
      userPrompt: [{ type: 'media', ref: { source: 'youtube', videoId: 'v' } }],
    });
    await deps.prisma.aIJob.update({ where: { id: jobId }, data: { status: 'RUNNING', externalInteractionId: 'int-1' } });
    deps.prisma.$queryRaw = jest.fn(async (_s: TemplateStringsArray): Promise<Array<{ id: string }>> => [{ id: jobId }]);
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ id: 'int-1', status: 'budget_exceeded' }),
      text: async () => JSON.stringify({ id: 'int-1', status: 'budget_exceeded' }),
    } as unknown as Response);

    const res = await router.pollRunning(10);
    jest.restoreAllMocks();

    expect(res.failed).toBe(1);
    const job = deps.prisma._jobs.get(jobId);
    expect(job.status).toBe('FAILED');
    expect(job.partialResult).toContain('budget_exceeded');
    // Ретрая нет: новая постановка упёрлась бы в тот же лимит (§9.3).
    expect(job.retryCount).toBe(0);
  });

  it('pollRunning: failed при остатке попыток → НОВАЯ постановка (QUEUED, externalInteractionId сброшен)', async () => {
    const deps = makeDeps();
    const router = makeRouter(deps);
    const { jobId } = await router.enqueue({
      userId: USER,
      taskType: 'media-public-review',
      userPrompt: [{ type: 'media', ref: { source: 'youtube', videoId: 'v' } }],
    });
    await deps.prisma.aIJob.update({ where: { id: jobId }, data: { status: 'RUNNING', externalInteractionId: 'int-old' } });
    deps.prisma.$queryRaw = jest.fn(async (_s: TemplateStringsArray): Promise<Array<{ id: string }>> => [{ id: jobId }]);
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ id: 'int-old', status: 'failed', error: { message: 'boom' } }),
      text: async () => JSON.stringify({ id: 'int-old', status: 'failed', error: { message: 'boom' } }),
    } as unknown as Response);

    await router.pollRunning(10);
    jest.restoreAllMocks();

    const job = deps.prisma._jobs.get(jobId);
    // Ретрай = новая постановка задачи, не повторный опрос старой (§4.4).
    expect(job.status).toBe('QUEUED');
    expect(job.externalInteractionId).toBeNull();
    expect(job.retryCount).toBe(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (живой прогон 2026-08-31): 400 на ОПРОСЕ → FAILED сразу, тело ответа в partialResult — не молчаливое «waiting»', async () => {
    const deps = makeDeps();
    const router = makeRouter(deps);
    const outcomes: unknown[] = [];
    router.registerCompletionHandler('media-public-review', async (o) => {
      outcomes.push(o);
    });
    const { jobId } = await router.enqueue({
      userId: USER,
      taskType: 'media-public-review',
      userPrompt: [{ type: 'media', ref: { source: 'youtube', videoId: 'v' } }],
    });
    await deps.prisma.aIJob.update({ where: { id: jobId }, data: { status: 'RUNNING', externalInteractionId: 'int-1' } });
    deps.prisma.$queryRaw = jest.fn(async (_s: TemplateStringsArray): Promise<Array<{ id: string }>> => [{ id: jobId }]);
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false, status: 400, statusText: 'Bad Request',
      json: async () => ({}),
      text: async () => '{"error":{"code":400,"message":"Invalid interaction id"}}',
    } as unknown as Response);

    const res = await router.pollRunning(10);
    jest.restoreAllMocks();

    // До правки это была ветка «waiting++» без записи: джоба молча
    // висела в RUNNING (retryCount 0, partialResult NULL) до 2-часового
    // lease. Теперь — немедленный FAILED с причиной от провайдера.
    expect(res.failed).toBe(1);
    expect(res.waiting).toBe(0);
    const job = deps.prisma._jobs.get(jobId);
    expect(job.status).toBe('FAILED');
    expect(job.partialResult).toContain('Invalid interaction id');
    expect(job.retryCount).toBe(0);
    expect((outcomes[0] as { kind: string }).kind).toBe('failed');
  });

  it('КЛЮЧЕВОЙ ТЕСТ (вторая находка живого прогона): completed без читаемого текста → FAILED с телом ответа, не вечный опрос', async () => {
    const deps = makeDeps();
    const router = makeRouter(deps);
    const { jobId } = await router.enqueue({
      userId: USER,
      taskType: 'media-public-review',
      userPrompt: [{ type: 'media', ref: { source: 'youtube', videoId: 'v' } }],
    });
    await deps.prisma.aIJob.update({ where: { id: jobId }, data: { status: 'RUNNING', externalInteractionId: 'int-1' } });
    deps.prisma.$queryRaw = jest.fn(async (_s: TemplateStringsArray): Promise<Array<{ id: string }>> => [{ id: jobId }]);
    const weirdBody = { id: 'int-1', status: 'completed', outputs: [{ mystery: true }] };
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      json: async () => weirdBody,
      text: async () => JSON.stringify(weirdBody),
    } as unknown as Response);

    const res = await router.pollRunning(10);
    jest.restoreAllMocks();

    // Ответ терминален и больше не изменится — ждать нечего: джоба
    // закрывается сразу, а ФОРМА ответа целиком видна в partialResult.
    expect(res.failed).toBe(1);
    expect(res.waiting).toBe(0);
    const job = deps.prisma._jobs.get(jobId);
    expect(job.status).toBe('FAILED');
    expect(job.partialResult).toContain('mystery');
  });

  it('503 на опросе → waiting, статус остаётся RUNNING, но причина ЗАПИСАНА в partialResult', async () => {
    const deps = makeDeps();
    const router = makeRouter(deps);
    const { jobId } = await router.enqueue({
      userId: USER,
      taskType: 'media-public-review',
      userPrompt: [{ type: 'media', ref: { source: 'youtube', videoId: 'v' } }],
    });
    await deps.prisma.aIJob.update({ where: { id: jobId }, data: { status: 'RUNNING', externalInteractionId: 'int-1' } });
    deps.prisma.$queryRaw = jest.fn(async (_s: TemplateStringsArray): Promise<Array<{ id: string }>> => [{ id: jobId }]);
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false, status: 503, statusText: 'Service Unavailable',
      json: async () => ({}),
      text: async () => '{"error":{"code":503,"message":"The model is overloaded"}}',
    } as unknown as Response);

    const res = await router.pollRunning(10);
    jest.restoreAllMocks();

    expect(res.waiting).toBe(1);
    const job = deps.prisma._jobs.get(jobId);
    // Транзиентная ошибка: задача у провайдера жива, ждём следующего
    // тика — но зависание больше не «без причины»: SQL покажет её.
    expect(job.status).toBe('RUNNING');
    expect(job.partialResult).toContain('overloaded');
  });

  it('400 на ПОСТАНОВКЕ → FAILED сразу, без рекью (та же форма даст тот же 400)', async () => {
    const deps = makeDeps();
    const router = makeRouter(deps);
    const { jobId } = await router.enqueue({
      userId: USER,
      taskType: 'media-public-review',
      userPrompt: [{ type: 'media', ref: { source: 'youtube', videoId: 'v' } }],
      maxRetries: 3,
    });
    deps.prisma.$queryRaw = jest.fn(async (_s: TemplateStringsArray): Promise<Array<{ id: string }>> => [{ id: jobId }]);
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false, status: 400, statusText: 'Bad Request',
      json: async () => ({}),
      text: async () => '{"error":{"code":400,"message":"Unknown name \\"system_instruction\\""}}',
    } as unknown as Response);

    const res = await router.submitQueued(3);
    jest.restoreAllMocks();

    expect(res.failed).toBe(1);
    const job = deps.prisma._jobs.get(jobId);
    // maxRetries 3, но 400 не ретраится: рекью новой постановкой дал бы
    // тот же 400 и сжёг бы попытки без новой информации.
    expect(job.status).toBe('FAILED');
    expect(job.retryCount).toBe(0);
    expect(job.partialResult).toContain('system_instruction');
  });

  it('503 на постановке → рекью новой постановкой, причина записана в partialResult', async () => {
    const deps = makeDeps();
    const router = makeRouter(deps);
    const { jobId } = await router.enqueue({
      userId: USER,
      taskType: 'media-public-review',
      userPrompt: [{ type: 'media', ref: { source: 'youtube', videoId: 'v' } }],
      maxRetries: 3,
    });
    deps.prisma.$queryRaw = jest.fn(async (_s: TemplateStringsArray): Promise<Array<{ id: string }>> => [{ id: jobId }]);
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false, status: 503, statusText: 'Service Unavailable',
      json: async () => ({}),
      text: async () => '{"error":{"code":503,"message":"overloaded"}}',
    } as unknown as Response);

    await router.submitQueued(3);
    jest.restoreAllMocks();

    const job = deps.prisma._jobs.get(jobId);
    expect(job.status).toBe('QUEUED');
    expect(job.retryCount).toBe(1);
    expect(job.externalInteractionId).toBeNull();
    expect(job.partialResult).toContain('503');
  });

  it('сторожевая различает QUEUED (воркер не поставил) и RUNNING (провайдер молчит)', async () => {
    const deps = makeDeps();
    const router = makeRouter(deps);
    deps.prisma.aIJob.findMany = jest.fn(async (): Promise<any[]> => [
      { id: 'q1', status: 'QUEUED', taskType: 't' },
      { id: 'r1', status: 'RUNNING', taskType: 't' },
    ]);
    deps.prisma._jobs.set('q1', { id: 'q1', status: 'QUEUED' });
    deps.prisma._jobs.set('r1', { id: 'r1', status: 'RUNNING' });

    const res = await router.reapExpired();

    expect(res.reaped).toBe(2);
    expect(deps.prisma._jobs.get('q1').partialResult).toContain('воркер');
    expect(deps.prisma._jobs.get('r1').partialResult).toContain('потолок ожидания');
  });
});

describe('GET /ai-jobs/:id — только свои', () => {
  it('чужая джоба неотличима от несуществующей', async () => {
    const deps = makeDeps();
    const router = makeRouter(deps);
    const { jobId } = await router.enqueue({
      userId: USER,
      taskType: 'media-public-review',
      userPrompt: [{ type: 'media', ref: { source: 'youtube', videoId: 'v' } }],
    });
    expect(await router.getJobForUser('someone-else', jobId)).toBeNull();
    expect(await router.getJobForUser(USER, 'no-such-job')).toBeNull();
    expect((await router.getJobForUser(USER, jobId))?.id).toBe(jobId);
  });
});

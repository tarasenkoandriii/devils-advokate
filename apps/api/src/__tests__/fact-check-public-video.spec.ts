// Пункт [fact-check] 2026-09-01 — проверка сегментов разобранного
// публичного видео по базе фактчеков (кнопка в Sandbox/очереди).
//
// Метод живёт в DiscrepancyAnalysisService намеренно: там уже есть
// fetchFactCheckClaims с кэшем и пагинацией — эти тесты фиксируют
// именно НОВУЮ обёртку (отбор сегментов, потолок запросов, изоляция
// сбоев, AI-фоллбек с кэшем гипотез), а не сам claims:search.

import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { DiscrepancyAnalysisService } from '../discrepancy-analysis/discrepancy-analysis.service';

const LONG_TEXT = 'Это достаточно длинное утверждение, чтобы искать его в базе фактчеков.';

function makeService(opts: {
  segments?: Array<{ id: string; text: string; startMs: number }>;
  language?: string | null;
  hasKey?: boolean;
}) {
  const prisma = {
    conversation: {
      findUnique: jest.fn(async () => ({ id: 'conv-1', projectId: 'p1', project: { ownerId: 'user-1' } })),
    },
    promptVersion: {
      findFirst: jest.fn(async () => null),
    },
    transcript: {
      findUnique: jest.fn(async () =>
        opts.segments
          ? {
              language: opts.language ?? 'ru',
              segments: opts.segments.map((s) => ({ ...s, endMs: s.startMs + 1000 })),
            }
          : null,
      ),
    },
    factCheckApiCache: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async () => ({})),
    },
  };
  const secrets = {
    resolve: jest.fn(async (ref: string) => {
      if (ref === 'FACT_CHECK_TOOLS_API_KEY' && opts.hasKey !== false) return 'fc-key';
      throw new Error(`Secret not found for credentialRef "${ref}"`);
    }),
  };
  // AI-фоллбек ([fact-check-ai-fallback]): по умолчанию отвечает
  // валидной гипотезой на КАЖДЫЙ segmentId из промпта.
  const aiRouter = {
    execute: jest.fn(async (req: { userPrompt: string; taskType: string }) => {
      const ids = [...req.userPrompt.matchAll(/segmentId=([\w-]+)/g)].map((m) => m[1]);
      return {
        text: JSON.stringify(ids.map((id) => ({ segmentId: id, verdict: 'DISPUTED', confidence: 0.6, rationale: 'источники расходятся', sources: ['StopFake'] }))),
        aiInferenceId: 'inf-1',
      };
    }),
  };
  return {
    svc: new DiscrepancyAnalysisService(prisma as any, aiRouter as any, secrets as any),
    prisma,
    secrets,
    aiRouter,
  };
}

function okFetch(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => jest.restoreAllMocks());

describe('DiscrepancyAnalysisService.factCheckConversationSegments', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: совпадения маппятся в плоскую форму; короткие реплики отфильтрованы; результат кэшируется', async () => {
    const { svc, prisma } = makeService({
      segments: [
        { id: 's-short', text: 'Да.', startMs: 0 },
        { id: 's-1', text: LONG_TEXT, startMs: 5000 },
      ],
    });
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      okFetch({
        claims: [
          {
            text: 'Часы стоят 50 тысяч долларов',
            claimant: 'Некто',
            claimReview: [
              { publisher: { name: 'StopFake' }, url: 'https://stopfake.org/check', textualRating: 'False', reviewDate: '2026-01-01' },
            ],
          },
        ],
      }),
    );

    const res = await svc.factCheckConversationSegments('user-1', 'conv-1');

    expect(res.totalSegments).toBe(2);
    expect(res.checkedSegments).toBe(1); // короткая реплика не проверялась
    expect(res.results[0].segmentId).toBe('s-1');
    expect(res.results[0].matches[0]).toEqual({
      claim: 'Часы стоят 50 тысяч долларов',
      claimant: 'Некто',
      rating: 'False',
      publisher: 'StopFake',
      url: 'https://stopfake.org/check',
      reviewDate: '2026-01-01',
    });
    // Переиспользуется существующий кэш claims:search (24 ч).
    expect(prisma.factCheckApiCache.upsert).toHaveBeenCalled();
  });

  it('КЛЮЧЕВОЙ ТЕСТ: потолок 8 сегментов; сбой одного поиска не роняет остальные', async () => {
    const segments = Array.from({ length: 11 }, (_, i) => ({
      id: `s-${i}`,
      text: `${LONG_TEXT} №${i}`,
      startMs: i * 1000,
    }));
    const { svc } = makeService({ segments });
    const spy = jest.spyOn(global, 'fetch');
    for (let i = 0; i < 8; i++) {
      if (i === 2) {
        spy.mockRejectedValueOnce(new Error('network down'));
      } else {
        spy.mockResolvedValueOnce(okFetch({ claims: [] }));
      }
    }

    const res = await svc.factCheckConversationSegments('user-1', 'conv-1');

    expect(spy).toHaveBeenCalledTimes(8); // лишние 3 сегмента не проверялись
    expect(res.checkedSegments).toBe(8);
    expect(res.results).toHaveLength(8); // сбойный сегмент присутствует с нулём совпадений
    // Пункт [fact-check-unmask]: причина сбоя видна в результате
    // сегмента, а не проглочена как «совпадений: 0».
    const failed = res.results.find((r) => r.segmentId === 's-2')!;
    expect(failed.matches).toEqual([]);
    expect(failed.error).toMatch(/недоступен|network/i);
    expect(res.results.filter((r) => r.error === null)).toHaveLength(7);
  });

  it('КЛЮЧЕВОЙ ТЕСТ [fact-check-ai-fallback]: сегменты без совпадений уходят ОДНИМ батчем в AI; сегмент с совпадением — нет', async () => {
    const { svc, aiRouter } = makeService({
      segments: [
        { id: 's-hit', text: LONG_TEXT, startMs: 0 },
        { id: 's-miss', text: `${LONG_TEXT} №2`, startMs: 1000 },
      ],
    });
    const spy = jest.spyOn(global, 'fetch');
    spy.mockResolvedValueOnce(
      okFetch({ claims: [{ text: 'c', claimReview: [{ publisher: { name: 'StopFake' }, url: 'https://s/1', textualRating: 'False' }] }] }),
    );
    spy.mockResolvedValueOnce(okFetch({ claims: [] }));

    const res = await svc.factCheckConversationSegments('user-1', 'conv-1');

    expect(aiRouter.execute).toHaveBeenCalledTimes(1); // один батч, не по вызову на сегмент
    const req = aiRouter.execute.mock.calls[0][0];
    expect(req.taskType).toBe('fact-check-ai-fallback');
    expect(req.userPrompt).toContain('s-miss');
    expect(req.userPrompt).not.toContain('s-hit'); // по нему уже есть фактчек
    const hit = res.results.find((r) => r.segmentId === 's-hit')!;
    const miss = res.results.find((r) => r.segmentId === 's-miss')!;
    expect(hit.ai).toBeNull();
    expect(miss.ai).toMatchObject({ verdict: 'DISPUTED', confidence: 0.6, sources: ['StopFake'] });
    expect(res.aiFallbackUsed).toBe(true);
    expect(res.aiCheckedSegments).toBe(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ [fact-check-unmask]+[fact-check-ai-fallback]: 100% отказов API → AI-гипотезы с видимой причиной отказа; если И AI упал — ошибка запроса', async () => {
    // Живой прогон 2026-09-01: Fact Check Tools API не был включён в
    // Google Cloud проекте → 14 мгновенных отказов (медиана 4мс), а
    // песочница показывала «Проверено 6 из 6, совпадений 0». Теперь
    // отказ виден per-segment, а сегменты уходят в AI-фоллбек.
    const failAll = () =>
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 403,
        text: async () =>
          JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Fact Check Tools API has not been used in project ... before or it is disabled.' } }),
      } as unknown as Response);

    const ok = makeService({
      segments: [
        { id: 's-1', text: LONG_TEXT, startMs: 0 },
        { id: 's-2', text: `${LONG_TEXT} №2`, startMs: 1000 },
      ],
    });
    failAll();
    const res = await ok.svc.factCheckConversationSegments('user-1', 'conv-1');
    expect(res.results.every((r) => r.error !== null && /PERMISSION_DENIED/.test(r.error))).toBe(true);
    expect(res.results.every((r) => r.ai !== null)).toBe(true); // отказ API не оставил оператора ни с чем
    expect(res.aiFallbackUsed).toBe(true);
    jest.restoreAllMocks();

    // Тот же отказ API + недоступный AI-провайдер → теперь уже честная
    // ошибка запроса с ОБЕИМИ причинами, не нулевой успех.
    const broken = makeService({ segments: [{ id: 's-1', text: LONG_TEXT, startMs: 0 }] });
    broken.aiRouter.execute.mockRejectedValue(new Error('провайдер недоступен'));
    failAll();
    await expect(broken.svc.factCheckConversationSegments('user-1', 'conv-1')).rejects.toBeInstanceOf(BadGatewayException);
    failAll();
    await expect(broken.svc.factCheckConversationSegments('user-1', 'conv-1')).rejects.toThrow(/PERMISSION_DENIED.*AI-фоллбек/s);
  });

  it('КЛЮЧЕВОЙ ТЕСТ [fact-check-audit]: AI-гипотезы кэшируются 24 ч — повторное нажатие кнопки не оплачивает AI-вызов заново', async () => {
    const { svc, prisma, aiRouter } = makeService({
      segments: [
        { id: 's-1', text: LONG_TEXT, startMs: 0 },
        { id: 's-2', text: `${LONG_TEXT} №2`, startMs: 1000 },
      ],
    });
    // Map-backed кэш вместо всегда-null: и claims:search, и гипотезы.
    const store = new Map<string, { queryHash: string; resultJson: unknown; expiresAt: Date }>();
    (prisma.factCheckApiCache.findUnique as jest.Mock).mockImplementation(async (args: { where: { queryHash: string } }) => store.get(args.where.queryHash) ?? null);
    (prisma.factCheckApiCache.upsert as jest.Mock).mockImplementation(async (args: { where: { queryHash: string }; create: { queryHash: string; resultJson: unknown; expiresAt: Date } }) => {
      store.set(args.where.queryHash, args.create);
      return args.create;
    });
    const spy = jest.spyOn(global, 'fetch');
    spy.mockResolvedValue(okFetch({ claims: [] }));

    const first = await svc.factCheckConversationSegments('user-1', 'conv-1');
    expect(first.aiCheckedSegments).toBe(2);
    expect(aiRouter.execute).toHaveBeenCalledTimes(1);

    const second = await svc.factCheckConversationSegments('user-1', 'conv-1');
    expect(second.aiCheckedSegments).toBe(2); // гипотезы на месте…
    expect(second.results.every((r) => r.ai !== null)).toBe(true);
    expect(aiRouter.execute).toHaveBeenCalledTimes(1); // …но AI больше не вызывался
    expect(spy).toHaveBeenCalledTimes(2); // и claims:search тоже из кэша (2 сегмента × 1-й прогон)
  });

  it('[fact-check-audit]: checkAgainstFactCheckAPI без ключа — честный 400 с именем переменной, не 500', async () => {
    const { svc, prisma } = makeService({ segments: undefined, hasKey: false });
    (prisma.conversation.findUnique as jest.Mock).mockResolvedValue({
      id: 'conv-1',
      projectId: 'p1',
      project: { ownerId: 'user-1' },
      transcript: { segments: [{ id: 'seg-1', text: LONG_TEXT, participantId: null, participant: null }] },
    } as never);
    await expect(svc.checkAgainstFactCheckAPI('user-1', 'conv-1', 'seg-1', 'часы стоят 50 тысяч')).rejects.toThrow(/FACT_CHECK_TOOLS_API_KEY/);
    await expect(svc.checkAgainstFactCheckAPI('user-1', 'conv-1', 'seg-1', 'часы стоят 50 тысяч')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('[fact-check-ai-fallback]: без ключа claims:search пропускается (ни одного fetch), сегменты получают AI-гипотезы; сбой AI не роняет ответ при живом API; без транскрипта — пустой результат', async () => {
    const noKey = makeService({ segments: [{ id: 's-1', text: LONG_TEXT, startMs: 0 }], hasKey: false });
    const spy = jest.spyOn(global, 'fetch');
    const res = await noKey.svc.factCheckConversationSegments('user-1', 'conv-1');
    expect(spy).not.toHaveBeenCalled(); // база фактчеков честно пропущена
    expect(res.apiKeyPresent).toBe(false);
    expect(res.results[0].error).toMatch(/FACT_CHECK_TOOLS_API_KEY/);
    expect(res.results[0].ai).not.toBeNull();

    // AI упал, но claims:search живой и нашёл совпадение → ответ не
    // роняется, причина сбоя фоллбека — отдельным полем.
    const aiDown = makeService({ segments: [{ id: 's-1', text: LONG_TEXT, startMs: 0 }, { id: 's-2', text: `${LONG_TEXT} №2`, startMs: 1 }] });
    aiDown.aiRouter.execute.mockRejectedValue(new Error('AI недоступен'));
    const spy2 = jest.spyOn(global, 'fetch');
    spy2.mockResolvedValueOnce(okFetch({ claims: [{ text: 'c', claimReview: [{ publisher: { name: 'P' }, url: 'https://p/1', textualRating: 'False' }] }] }));
    spy2.mockResolvedValueOnce(okFetch({ claims: [] }));
    const res2 = await aiDown.svc.factCheckConversationSegments('user-1', 'conv-1');
    expect(res2.aiError).toMatch(/AI недоступен/);
    expect(res2.results.find((r) => r.segmentId === 's-1')!.matches).toHaveLength(1);
    expect(res2.results.find((r) => r.segmentId === 's-2')!.ai).toBeNull();

    const empty = makeService({ segments: undefined });
    const emptyRes = await empty.svc.factCheckConversationSegments('user-1', 'conv-none');
    expect(emptyRes).toMatchObject({ language: null, checkedSegments: 0, totalSegments: 0, results: [], aiFallbackUsed: false });
  });
});

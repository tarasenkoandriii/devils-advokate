// Пункт [fact-check] 2026-09-01 — проверка сегментов разобранного
// публичного видео по базе фактчеков (кнопка в Sandbox/очереди).
//
// Метод живёт в DiscrepancyAnalysisService намеренно: там уже есть
// fetchFactCheckClaims с кэшем и пагинацией — эти тесты фиксируют
// именно НОВУЮ обёртку (отбор сегментов, потолок запросов, изоляция
// сбоев, честная ошибка про незаданный ключ), а не сам claims:search.

import { BadRequestException } from '@nestjs/common';
import { DiscrepancyAnalysisService } from '../discrepancy-analysis/discrepancy-analysis.service';

const LONG_TEXT = 'Это достаточно длинное утверждение, чтобы искать его в базе фактчеков.';

function makeService(opts: {
  segments?: Array<{ id: string; text: string; startMs: number }>;
  language?: string | null;
  hasKey?: boolean;
}) {
  const prisma = {
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
  const aiRouter = { execute: jest.fn() };
  return {
    svc: new DiscrepancyAnalysisService(prisma as any, aiRouter as any, secrets as any),
    prisma,
    secrets,
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

    const res = await svc.factCheckConversationSegments('conv-1');

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

    const res = await svc.factCheckConversationSegments('conv-1');

    expect(spy).toHaveBeenCalledTimes(8); // лишние 3 сегмента не проверялись
    expect(res.checkedSegments).toBe(8);
    expect(res.results).toHaveLength(8); // сбойный сегмент присутствует с нулём совпадений
  });

  it('без ключа — честная ошибка с именем переменной ДО единого запроса; без транскрипта — пустой результат', async () => {
    const noKey = makeService({ segments: [{ id: 's-1', text: LONG_TEXT, startMs: 0 }], hasKey: false });
    const spy = jest.spyOn(global, 'fetch');
    await expect(noKey.svc.factCheckConversationSegments('conv-1')).rejects.toThrow(/FACT_CHECK_TOOLS_API_KEY/);
    await expect(noKey.svc.factCheckConversationSegments('conv-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(spy).not.toHaveBeenCalled();

    const empty = makeService({ segments: undefined });
    expect(await empty.svc.factCheckConversationSegments('conv-none')).toEqual({
      language: null,
      checkedSegments: 0,
      totalSegments: 0,
      results: [],
    });
  });
});

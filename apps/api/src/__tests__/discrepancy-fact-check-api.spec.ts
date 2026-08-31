import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DiscrepancyAnalysisService } from '../discrepancy-analysis/discrepancy-analysis.service';

function createFakePrisma() {
  const conversations = new Map<string, any>();
  const signals: any[] = [];
  const evidence: any[] = [];
  const cache = new Map<string, any>();
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedConversation(c: any) {
      const conv = { id: nextId(), ...c };
      conversations.set(conv.id, conv);
      return conv;
    },
    _getSignals() {
      return signals;
    },
    _getEvidence() {
      return evidence;
    },
    _getCache() {
      return cache;
    },
    _seedCacheEntry(entry: any) {
      cache.set(entry.queryHash, { id: nextId(), ...entry });
    },

    conversation: {
      findUnique: async ({ where }: any) => conversations.get(where.id) ?? null,
    },
    conversationSignal: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), ...data };
        signals.push(s);
        return s;
      },
    },
    conversationSignalEvidence: {
      create: async ({ data }: any) => {
        const e = { id: nextId(), ...data };
        evidence.push(e);
        return e;
      },
    },
    factCheckApiCache: {
      findUnique: async ({ where }: any) => cache.get(where.queryHash) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const existing = cache.get(where.queryHash);
        const entry = existing ? { ...existing, ...update } : { id: nextId(), ...create };
        cache.set(where.queryHash, entry);
        return entry;
      },
    },
  };
}

function createFakeSecrets(apiKey = 'test-fact-check-key') {
  return { resolve: async (_ref: string) => apiKey } as any;
}

function makeService(prisma: any, secrets = createFakeSecrets()) {
  return new DiscrepancyAnalysisService(prisma as any, {} as any, secrets);
}

const SEGMENT = { id: 'seg-1', text: 'Vaccines cause autism', participantId: 'p-1' };

function seedConversationWithSegment(prisma: any) {
  return prisma._seedConversation({
    ownerId: 'u1',
    projectId: 'proj-1',
    project: { ownerId: 'u1' },
    transcript: { segments: [SEGMENT] },
  });
}

describe('DiscrepancyAnalysisService.checkAgainstFactCheckAPI', () => {
  afterEach(() => {
    (global as any).fetch = undefined;
  });

  it('acceptance-тест §6 ТЗ: не виконує пошук по імені людини — тільки по claimText через query-параметр', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    let capturedUrl = '';
    (global as any).fetch = jest.fn(async (url: string) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ claims: [] }) };
    });
    const service = makeService(prisma);

    await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'vaccines cause autism');

    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.get('query')).toBe('vaccines cause autism');
    expect(parsed.hostname).toBe('factchecktools.googleapis.com');
  });

  it('відхиляє порожній claimText — аналітик зобов’язаний сформулювати твердження сам', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    const service = makeService(prisma);

    await expect(service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, '   ')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('чужа Conversation дає NotFoundException', async () => {
    const prisma = createFakePrisma();
    const conv = prisma._seedConversation({
      ownerId: 'someone-else',
      project: { ownerId: 'someone-else' },
      transcript: { segments: [SEGMENT] },
    });
    const service = makeService(prisma);

    await expect(service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'claim')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('acceptance-тест §6: створює сигнал і зберігає factCheckClaimId, коли знайдено claim з негативним рейтингом', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        claims: [
          {
            text: 'Vaccines cause autism',
            claimant: 'Someone',
            claimReview: [
              { publisher: { name: 'PolitiFact' }, textualRating: 'False', url: 'https://politifact.com/claim1' },
            ],
          },
        ],
      }),
    }));
    const service = makeService(prisma);

    const result = await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'vaccines cause autism');

    expect(result.claims.length).toBe(1);
    expect(result.signal).not.toBeNull();
    expect(prisma._getEvidence()[0].factCheckClaimId).toBeDefined();
    expect(prisma._getEvidence()[0].factCheckClaimId).toBe(result.claims[0].claimId);
    // Пункт [fact-check-source-closure]: без factCheckSourceDescription
    // сигнал ложно попадал бы в "ещё требует проверки" в exportFactsToVerify().
    expect(prisma._getEvidence()[0].factCheckSourceDescription).toContain('Google Fact Check Tools API');
    expect(prisma._getEvidence()[0].factCheckSourceDescription).toContain('PolitiFact');
  });

  it('НЕ створює сигнал, коли рейтинг не вказує на недостовірність (наприклад "True")', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        claims: [
          {
            text: 'Water boils at 100C at sea level',
            claimReview: [{ publisher: { name: 'FactCheck.org' }, textualRating: 'True', url: 'https://factcheck.org/claim2' }],
          },
        ],
      }),
    }));
    const service = makeService(prisma);

    const result = await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'water boils at 100C');

    expect(result.claims.length).toBe(1);
    expect(result.signal).toBeNull();
    expect(prisma._getSignals().length).toBe(0);
  });

  it('порожній результат від Fact Check Tools API — чесно повертає порожній claims[], без сигналу', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) }));
    const service = makeService(prisma);

    const result = await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'some obscure claim');

    expect(result.claims).toEqual([]);
    expect(result.signal).toBeNull();
  });

  it('розгортає кілька claimReview в один claim в окремі рядки результату', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        claims: [
          {
            text: 'Some claim',
            claimReview: [
              { publisher: { name: 'Snopes' }, textualRating: 'Mostly False', url: 'https://snopes.com/c1' },
              { publisher: { name: 'Reuters Fact Check' }, textualRating: 'Unproven', url: 'https://reuters.com/c1' },
            ],
          },
        ],
      }),
    }));
    const service = makeService(prisma);

    const result = await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'some claim');

    expect(result.claims.length).toBe(2);
    expect(result.claims.map((c) => c.publisher)).toEqual(['Snopes', 'Reuters Fact Check']);
  });

  it('другий виклик з тим самим claimText НЕ звертається до зовнішнього API — читає з кешу', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    let fetchCallCount = 0;
    (global as any).fetch = jest.fn(async () => {
      fetchCallCount++;
      return {
        ok: true,
        json: async () => ({
          claims: [{ text: 'x', claimReview: [{ publisher: { name: 'Snopes' }, textualRating: 'False', url: 'https://snopes.com/c1' }] }],
        }),
      };
    });
    const service = makeService(prisma);

    await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'vaccines cause autism');
    await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'vaccines cause autism');

    expect(fetchCallCount).toBe(1);
  });

  it('кеш нормалізує пробіли й регістр — різне написання того самого твердження влучає в один кеш', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    let fetchCallCount = 0;
    (global as any).fetch = jest.fn(async () => {
      fetchCallCount++;
      return { ok: true, json: async () => ({ claims: [] }) };
    });
    const service = makeService(prisma);

    await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'Vaccines Cause Autism');
    await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, '  vaccines   cause autism  ');

    expect(fetchCallCount).toBe(1);
  });

  it('прострочений кеш (expiresAt у минулому) звертається до зовнішнього API заново', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    const normalized = 'vaccines cause autism';
    const queryHash = require('crypto').createHash('sha256').update(normalized).digest('hex');
    prisma._seedCacheEntry({
      queryHash,
      claimText: 'vaccines cause autism',
      resultJson: [],
      expiresAt: new Date(Date.now() - 1000), // вже прострочено
    });
    let fetchCallCount = 0;
    (global as any).fetch = jest.fn(async () => {
      fetchCallCount++;
      return { ok: true, json: async () => ({ claims: [] }) };
    });
    const service = makeService(prisma);

    await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'vaccines cause autism');

    expect(fetchCallCount).toBe(1);
  });

  it('свіжий кеш (expiresAt у майбутньому) використовується без звернення до API', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    const normalized = 'vaccines cause autism';
    const queryHash = require('crypto').createHash('sha256').update(normalized).digest('hex');
    prisma._seedCacheEntry({
      queryHash,
      claimText: 'vaccines cause autism',
      resultJson: [
        { claimId: 'cached-1', text: 'x', publisher: 'Cached Publisher', textualRating: 'False', reviewUrl: 'https://x.com' },
      ],
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });
    (global as any).fetch = jest.fn(async () => {
      throw new Error('fetch should not have been called — cache should have been used');
    });
    const service = makeService(prisma);

    const result = await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'vaccines cause autism');

    expect(result.claims[0].publisher).toBe('Cached Publisher');
  });
});

describe('DiscrepancyAnalysisService.exportFactsToVerify — Fact Check API sourced signals', () => {
  afterEach(() => {
    (global as any).fetch = undefined;
  });

  function createFakePrismaForExport() {
    const conversations = new Map<string, any>();
    const signals: any[] = [];
    let idCounter = 0;
    const nextId = () => `id-${++idCounter}`;

    return {
      _seedConversation(c: any) {
        const conv = { id: nextId(), ...c };
        conversations.set(conv.id, conv);
        return conv;
      },
      _seedSignalWithEvidence(s: any) {
        signals.push({ id: nextId(), ...s });
      },

      conversation: {
        findUnique: async ({ where }: any) => conversations.get(where.id) ?? null,
      },
      conversationSignal: {
        findMany: async ({ where }: any) =>
          signals.filter(
            (s) => s.signalType === where.signalType && where.transcriptSegmentId.in.includes(s.transcriptSegmentId),
          ),
      },
    };
  }

  it('регресійний тест на реальний баг: сигнал, створений через checkAgainstFactCheckAPI, класифікується як "вже перевірено", НЕ "вимагає перевірки"', async () => {
    const prisma = createFakePrismaForExport();
    const conv = prisma._seedConversation({
      ownerId: 'u1',
      project: { ownerId: 'u1' },
      occurredAt: new Date('2026-01-01'),
      transcript: { segments: [SEGMENT] },
    });
    prisma._seedSignalWithEvidence({
      signalType: 'FACTUAL_DISCREPANCY',
      transcriptSegmentId: SEGMENT.id,
      severity: 'INACCURACY',
      transcriptSegment: SEGMENT,
      evidence: [
        {
          aiInference: null, // checkAgainstFactCheckAPI НІКОЛИ не викликає AI — саме тому баг існував
          factCheckSourceDescription:
            'Источник — Google Fact Check Tools API: PolitiFact оценил утверждение как "False" (https://politifact.com/claim1)',
        },
      ],
    });
    const service = makeService(prisma);

    const result = await service.exportFactsToVerify('u1', conv.id);

    expect(result.text).toContain('Уже проверено вручную');
    expect(result.text).toContain('Google Fact Check Tools API');
    expect(result.text).toContain('требует проверки: 0');
  });

  it('без factCheckSourceDescription (регресія на випадок майбутнього видалення поля) сигнал хибно потрапив би в "вимагає перевірки" — контрольний негативний тест', async () => {
    const prisma = createFakePrismaForExport();
    const conv = prisma._seedConversation({
      ownerId: 'u1',
      project: { ownerId: 'u1' },
      occurredAt: new Date('2026-01-01'),
      transcript: { segments: [SEGMENT] },
    });
    prisma._seedSignalWithEvidence({
      signalType: 'FACTUAL_DISCREPANCY',
      transcriptSegmentId: SEGMENT.id,
      severity: 'INACCURACY',
      transcriptSegment: SEGMENT,
      evidence: [{ aiInference: null, factCheckSourceDescription: null }],
    });
    const service = makeService(prisma);

    const result = await service.exportFactsToVerify('u1', conv.id);

    // Документує стару, баговану поведінку як контрольний приклад —
    // якщо цей тест раптом стане FAIL, значить хтось прибрав поле,
    // не помітивши, що воно було критичним для фіксу.
    expect(result.text).not.toContain('Уже проверено вручную');
    expect(result.text).toContain('требует проверки: 1');
  });

  it('РЕГРЕСІЯ (вичерпний аудит Fact Check Tools API 2026-08-30): тіло відповіді Google при помилці потрапляє в текст BadGatewayException, не губиться', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    // Реалистична форма помилки Google (403, API не увімкнено в Google Cloud Console) —
    // саме такий текст мав загубитися до фіксу, залишивши лише код статусу.
    const realisticGoogleError = JSON.stringify({
      error: { code: 403, message: 'Fact Check Tools API has not been used in project 123456789 or it is disabled', status: 'PERMISSION_DENIED' },
    });
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 403, statusText: 'Forbidden', text: async () => realisticGoogleError }));
    const service = makeService(prisma);

    await expect(service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'some claim')).rejects.toThrow(/PERMISSION_DENIED/);
  });

  // ── Розширення на майбутнє (2026-08-30, за прямим запитом) ──

  it('РЕГРЕСІЯ: pageSize=20 передається явно в кожному запиті (раніше — дефолт API, 10)', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    let capturedUrl = '';
    (global as any).fetch = jest.fn(async (url: string) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ claims: [] }) };
    });
    const service = makeService(prisma);

    await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'some claim');

    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.get('pageSize')).toBe('20');
  });

  it('РЕГРЕСІЯ: слідує nextPageToken і об’єднує claims з кількох сторінок в один список', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    let callCount = 0;
    const pageTokensSeen: (string | null)[] = [];
    (global as any).fetch = jest.fn(async (url: string) => {
      callCount++;
      const parsed = new URL(url);
      pageTokensSeen.push(parsed.searchParams.get('pageToken'));
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            claims: [{ text: 'claim A', claimReview: [{ publisher: { name: 'PolitiFact' }, textualRating: 'True', url: 'https://politifact.com/a' }] }],
            nextPageToken: 'page-2-token',
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          claims: [{ text: 'claim B', claimReview: [{ publisher: { name: 'Snopes' }, textualRating: 'True', url: 'https://snopes.com/b' }] }],
          // немає nextPageToken — це остання сторінка
        }),
      };
    });
    const service = makeService(prisma);

    const result = await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'some claim');

    expect(callCount).toBe(2);
    expect(pageTokensSeen).toEqual([null, 'page-2-token']);
    expect(result.claims).toHaveLength(2);
    expect(result.claims.map((c) => c.publisher).sort()).toEqual(['PolitiFact', 'Snopes']);
  });

  it('РЕГРЕСІЯ: зупиняється на FACT_CHECK_PAGE_LIMIT (3) сторінках, навіть якщо Google продовжує повертати nextPageToken', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    let callCount = 0;
    (global as any).fetch = jest.fn(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          claims: [{ text: `claim ${callCount}`, claimReview: [{ publisher: { name: `Publisher${callCount}` }, textualRating: 'True', url: `https://example.com/${callCount}` }] }],
          nextPageToken: `token-${callCount + 1}`, // ЗАВЖДИ повертає токен — нескінченна пагінація без потолка
        }),
      };
    });
    const service = makeService(prisma);

    const result = await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'some claim');

    expect(callCount).toBe(3); // FACT_CHECK_PAGE_LIMIT, не нескінченно
    expect(result.claims).toHaveLength(3);
  });

  it('РЕГРЕСІЯ: title і reviewDate з ClaimReview потрапляють у FactCheckClaim, якщо Google їх повернув', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        claims: [{
          text: 'vaccines cause autism',
          claimReview: [{
            publisher: { name: 'PolitiFact' },
            textualRating: 'False',
            url: 'https://politifact.com/claim1',
            title: 'No, vaccines do not cause autism',
            reviewDate: '2024-05-01',
          }],
        }],
      }),
    }));
    const service = makeService(prisma);

    const result = await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'vaccines cause autism');

    expect(result.claims[0].title).toBe('No, vaccines do not cause autism');
    expect(result.claims[0].reviewDate).toBe('2024-05-01');
    // Title потрапляє і в опис доказу, якщо він є
    expect(prisma._getEvidence()[0].factCheckSourceDescription).toContain('No, vaccines do not cause autism');
  });

  it('title відсутній у відповіді Google — опис доказу не ламається, просто без вставки заголовка', async () => {
    const prisma = createFakePrisma();
    const conv = seedConversationWithSegment(prisma);
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        claims: [{
          text: 'vaccines cause autism',
          claimReview: [{ publisher: { name: 'PolitiFact' }, textualRating: 'False', url: 'https://politifact.com/claim1' }],
        }],
      }),
    }));
    const service = makeService(prisma);

    await service.checkAgainstFactCheckAPI('u1', conv.id, SEGMENT.id, 'vaccines cause autism');

    const description = prisma._getEvidence()[0].factCheckSourceDescription as string;
    expect(description).toContain('PolitiFact');
    expect(description).not.toMatch(/\(«.*»\)/); // немає порожньої вставки заголовка
  });
});

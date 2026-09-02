import { PrecedentSearchService } from '../precedent-search/precedent-search.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const people = new Map<string, any>();
  const facts: any[] = [];
  const conversations = new Map<string, any>();
  const transcripts = new Map<string, any>();
  const segments = new Map<string, any>();
  const participants = new Map<string, any>();
  const precedents: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedFact(f: any) { facts.push(f); },
    _seedConversation(c: any) { conversations.set(c.id, c); },
    _seedTranscript(t: any) { transcripts.set(t.id, t); },
    _seedSegment(s: any) { segments.set(s.id, s); },
    _seedParticipant(p: any) { participants.set(p.id, p); },
    _getPrecedents() { return precedents; },

    person: {
      findFirst: async ({ where }: any) => {
        const p = people.get(where.id);
        if (!p || p.createdByUserId !== where.createdByUserId) return null;
        return p;
      },
    },
    personFact: {
      findMany: async ({ where }: any) => facts.filter((f) => f.personId === where.personId && f.status === where.status),
    },
    conversation: {
      findMany: async ({ where, include }: any) => {
        const requiredPersonId = where.participants?.some?.personId;
        let result = [...conversations.values()].filter((c) => where.status.in.includes(c.status));
        if (requiredPersonId) {
          result = result.filter((c) => {
            const transcript = [...transcripts.values()].find((t) => t.conversationId === c.id);
            if (!transcript) return false;
            return [...segments.values()]
              .filter((s) => s.transcriptId === transcript.id)
              .some((s) => participants.get(s.participantId)?.personId === requiredPersonId);
          });
        }
        result = result.sort((a, b) => b.occurredAt - a.occurredAt);
        if (include?.transcript) {
          const personFilter = include.transcript.include?.segments?.where?.participant?.personId;
          result = result.map((c) => {
            const transcript = [...transcripts.values()].find((t) => t.conversationId === c.id);
            const segs = transcript
              ? [...segments.values()].filter(
                  (s) => s.transcriptId === transcript.id && (!personFilter || participants.get(s.participantId)?.personId === personFilter),
                )
              : [];
            return { ...c, transcript: transcript ? { ...transcript, segments: segs } : null };
          });
        }
        return result;
      },
    },
    promptVersion: {
      findFirst: async () => null,
    },
    behaviorPrecedent: {
      create: async ({ data }: any) => {
        const p = { id: nextId(), createdAt: new Date(), ...data };
        precedents.push(p);
        return p;
      },
      findMany: async ({ where }: any) => precedents.filter((p) => p.personId === where.personId).sort((a, b) => b.createdAt - a.createdAt),
    },
    $transaction: async (ops: Promise<any>[]) => Promise.all(ops),
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
const PERSON_ID = 'person-1';

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('findPrecedents() бросает NotFoundException для чужой персоны', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: 'other-user' });
    const svc = new PrecedentSearchService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.findPrecedents(USER_ID, PERSON_ID, 'Просит остаться на выходных на работе'),
      NotFoundException,
      'findPrecedents() на чужую персону',
    );
  });

  test('findPrecedents() бросает BadRequestException для пустого situationDescription', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    prisma._seedFact({ personId: PERSON_ID, status: 'ACTIVE', content: 'x' });
    const svc = new PrecedentSearchService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.findPrecedents(USER_ID, PERSON_ID, '   '),
      BadRequestException,
      'findPrecedents() с пустым situationDescription',
    );
  });

  test('findPrecedents() бросает BadRequestException, если нет ни фактов, ни разговоров', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    const svc = new PrecedentSearchService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(
      () => svc.findPrecedents(USER_ID, PERSON_ID, 'ситуация'),
      BadRequestException,
      'findPrecedents() без данных',
    );
  });

  test('findPrecedents() подмешивает факты, реплики и текущую ситуацию в промпт', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    prisma._seedFact({ personId: PERSON_ID, status: 'ACTIVE', content: 'Уже дважды отказывал в отпуске без объяснений' });
    prisma._seedConversation({ id: 'conv-1', status: 'TRANSCRIBED', occurredAt: new Date() });
    prisma._seedTranscript({ id: 'transcript-1', conversationId: 'conv-1' });
    prisma._seedParticipant({ id: 'part-1', personId: PERSON_ID });
    prisma._seedSegment({ id: 'seg-1', transcriptId: 'transcript-1', participantId: 'part-1', text: 'Нет, сейчас не время для отпуска.' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new PrecedentSearchService(prisma as any, fakeRouter as any);

    await svc.findPrecedents(USER_ID, PERSON_ID, 'Хочу попросить взять отгул на пятницу');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Уже дважды отказывал в отпуске'), true, 'факт попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Нет, сейчас не время для отпуска'), true, 'реплика попала в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Хочу попросить взять отгул на пятницу'), true, 'текущая ситуация попала в промпт');
  });

  test('findPrecedents() создаёт BehaviorPrecedent с правильными полями', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    prisma._seedFact({ personId: PERSON_ID, status: 'ACTIVE', content: 'x' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { precedentDescription: 'В марте отказал в похожей просьбе без объяснений', similarity: 'ANALOGOUS', sourceDescription: 'факт: уже дважды отказывал' },
    ]);
    const svc = new PrecedentSearchService(prisma as any, fakeRouter as any);

    const created = await svc.findPrecedents(USER_ID, PERSON_ID, 'ситуация');
    assertEqual(created.length, 1, 'один прецедент создан');
    assertEqual(created[0].similarity, 'ANALOGOUS', 'similarity сохранён');
    assertEqual(created[0].personId, PERSON_ID, 'personId проставлен');
  });

  test('findPrecedents() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    prisma._seedFact({ personId: PERSON_ID, status: 'ACTIVE', content: 'x' });
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new PrecedentSearchService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.findPrecedents(USER_ID, PERSON_ID, 'ситуация'), BadGatewayException, 'findPrecedents() при недоступности провайдера');
  });

  test('list() возвращает пустой вывод без прецедентов', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    const svc = new PrecedentSearchService(prisma as any, new FakeAIRouterService() as any);
    const result = await svc.list(USER_ID, PERSON_ID);
    assertEqual(result.total, 0, 'нет прецедентов');
    assertEqual(result.conclusion.includes('не найдено'), true, 'явное пояснение пустоты');
  });

  test('list() строит вероятностный вывод из РЕАЛЬНОГО числа накопленных прецедентов', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    prisma._seedFact({ personId: PERSON_ID, status: 'ACTIVE', content: 'x' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new PrecedentSearchService(prisma as any, fakeRouter as any);

    fakeRouter.responseText = JSON.stringify([
      { precedentDescription: 'p1', similarity: 'ANALOGOUS', sourceDescription: 's1' },
      { precedentDescription: 'p2', similarity: 'ANALOGOUS', sourceDescription: 's2' },
      { precedentDescription: 'p3', similarity: 'CONTRASTING', sourceDescription: 's3' },
    ]);
    await svc.findPrecedents(USER_ID, PERSON_ID, 'ситуация 1');

    const result = await svc.list(USER_ID, PERSON_ID);
    assertEqual(result.total, 3, 'все три прецедента накоплены');
    assertEqual(result.analogousCount, 2, 'два из трёх — аналогичные');
    assertEqual(result.conclusion.includes('2 из 3'), true, 'вывод содержит реальное соотношение, не выдуманное');
  });

  test('list() бросает NotFoundException для чужой персоны', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: 'other-user' });
    const svc = new PrecedentSearchService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.list(USER_ID, PERSON_ID), NotFoundException, 'list() на чужую персону');
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
  console.log(`\nPrecedentSearchService: ${results.length - failed.length}/${results.length} passed\n`);
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

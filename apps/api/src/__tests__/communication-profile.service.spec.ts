import { CommunicationProfileService } from '../communication-profile/communication-profile.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const people = new Map<string, any>();
  const facts: any[] = [];
  const conversations = new Map<string, any>();
  const transcripts = new Map<string, any>();
  const segments = new Map<string, any>();
  const participants = new Map<string, any>();
  const traits = new Map<string, any>(); // ключ: `${personId}:${traitType}`
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedFact(f: any) { facts.push(f); },
    _seedConversation(c: any) { conversations.set(c.id, c); },
    _seedTranscript(t: any) { transcripts.set(t.id, t); },
    _seedSegment(s: any) { segments.set(s.id, s); },
    _seedParticipant(p: any) { participants.set(p.id, p); },
    _getTraits() { return [...traits.values()]; },

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
    personCommunicationTrait: {
      upsert: async ({ where, create, update }: any) => {
        const key = `${where.personId_traitType.personId}:${where.personId_traitType.traitType}`;
        const existing = traits.get(key);
        const record = existing
          ? { ...existing, ...update, updatedAt: new Date() }
          : { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...create };
        traits.set(key, record);
        return record;
      },
      findMany: async ({ where }: any) =>
        [...traits.values()].filter((t) => t.personId === where.personId).sort((a, b) => a.traitType.localeCompare(b.traitType)),
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
const PERSON_ID = 'person-1';

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('refresh() бросает NotFoundException для чужой персоны', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: 'other-user' });
    const svc = new CommunicationProfileService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.refresh(USER_ID, PERSON_ID), NotFoundException, 'refresh() на чужую персону');
  });

  test('refresh() бросает BadRequestException, если нет ни фактов, ни разговоров', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    const svc = new CommunicationProfileService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.refresh(USER_ID, PERSON_ID), BadRequestException, 'refresh() без данных для наблюдения');
  });

  test('refresh() подмешивает факты и реплики ТОЛЬКО этого фигуранта в промпт', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    prisma._seedFact({ personId: PERSON_ID, status: 'ACTIVE', content: 'Работает финансовым директором' });
    prisma._seedConversation({ id: 'conv-1', status: 'TRANSCRIBED', occurredAt: new Date() });
    prisma._seedTranscript({ id: 'transcript-1', conversationId: 'conv-1' });
    prisma._seedParticipant({ id: 'part-1', personId: PERSON_ID });
    prisma._seedSegment({ id: 'seg-1', transcriptId: 'transcript-1', participantId: 'part-1', text: 'Дайте мне посчитать цифры перед ответом.' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new CommunicationProfileService(prisma as any, fakeRouter as any);

    await svc.refresh(USER_ID, PERSON_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Работает финансовым директором'), true, 'факт попал в промпт');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Дайте мне посчитать цифры перед ответом'), true, 'реплика попала в промпт');
  });

  test('refresh() создаёт признаки при первом вызове (upsert → create)', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    prisma._seedFact({ personId: PERSON_ID, status: 'ACTIVE', content: 'x' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { traitType: 'RESPONDS_TO_DATA', value: 'Просит конкретные цифры перед решением', observedFrom: 'разговор от 12.03', confidence: 0.8 },
    ]);
    const svc = new CommunicationProfileService(prisma as any, fakeRouter as any);

    const updated = await svc.refresh(USER_ID, PERSON_ID);
    assertEqual(updated.length, 1, 'один признак создан');
    assertEqual(updated[0].traitType, 'RESPONDS_TO_DATA', 'traitType корректный');
    assertEqual(prisma._getTraits().length, 1, 'ровно одна запись в хранилище');
  });

  test('refresh() ОБНОВЛЯЕТ существующий признак при повторном вызове, не дублирует (накопительное обновление)', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    prisma._seedFact({ personId: PERSON_ID, status: 'ACTIVE', content: 'x' });
    const fakeRouter = new FakeAIRouterService();
    const svc = new CommunicationProfileService(prisma as any, fakeRouter as any);

    fakeRouter.responseText = JSON.stringify([
      { traitType: 'RESPONDS_TO_DATA', value: 'Старое наблюдение', observedFrom: 'разговор 1', confidence: 0.5 },
    ]);
    await svc.refresh(USER_ID, PERSON_ID);
    fakeRouter.responseText = JSON.stringify([
      { traitType: 'RESPONDS_TO_DATA', value: 'Новое, более точное наблюдение', observedFrom: 'разговор 2', confidence: 0.9 },
    ]);
    await svc.refresh(USER_ID, PERSON_ID);

    assertEqual(prisma._getTraits().length, 1, 'ровно одна запись — вторая перезаписала первую, не дублировала');
    assertEqual(prisma._getTraits()[0].value, 'Новое, более точное наблюдение', 'значение обновлено на самое свежее');
    assertEqual(prisma._getTraits()[0].confidence, 0.9, 'confidence обновлён');
  });

  test('refresh() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    prisma._seedFact({ personId: PERSON_ID, status: 'ACTIVE', content: 'x' });
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new CommunicationProfileService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.refresh(USER_ID, PERSON_ID), BadGatewayException, 'refresh() при недоступности провайдера');
  });

  test('get() возвращает текущие признаки персоны', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: USER_ID });
    prisma._seedFact({ personId: PERSON_ID, status: 'ACTIVE', content: 'x' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify([
      { traitType: 'PREFERS_DIRECTNESS', value: 'Ценит короткие прямые ответы', observedFrom: 'разговор 1' },
    ]);
    const svc = new CommunicationProfileService(prisma as any, fakeRouter as any);
    await svc.refresh(USER_ID, PERSON_ID);

    const profile = await svc.get(USER_ID, PERSON_ID);
    assertEqual(profile.length, 1, 'признак виден через get() без нового AI-вызова');
    assertEqual(profile[0].value, 'Ценит короткие прямые ответы', 'значение сохранено');
  });

  test('get() бросает NotFoundException для чужой персоны', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_ID, createdByUserId: 'other-user' });
    const svc = new CommunicationProfileService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.get(USER_ID, PERSON_ID), NotFoundException, 'get() на чужую персону');
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
  console.log(`\nCommunicationProfileService: ${results.length - failed.length}/${results.length} passed\n`);
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

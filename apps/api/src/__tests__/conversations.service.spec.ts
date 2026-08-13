import { ConversationsService } from '../conversations/conversations.service';
import { TranscriptionService } from '../conversations/transcription.service';
import { ConsentService } from '../consent/consent.service';
import { SecretsService } from '../secrets/secrets.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const users = new Map<string, any>();
  const conversations = new Map<string, any>();
  const participants = new Map<string, any>();
  const transcripts = new Map<string, any>();
  const segments: any[] = [];
  const aiProviders = new Map<string, any>();
  const aiModelVersions = new Map<string, any>();
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedUser(u: any) { users.set(u.id, u); },
    _seedProvider(p: any) { aiProviders.set(p.id, p); },
    _seedModelVersion(v: any) { aiModelVersions.set(v.id, v); },
    _getConversation(id: string) { return conversations.get(id); },
    _getSegments() { return segments; },
    _getParticipants() { return [...participants.values()]; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    user: {
      findUniqueOrThrow: async ({ where }: any) => {
        const u = users.get(where.id);
        if (!u) throw new Error('user not found');
        return u;
      },
    },
    conversation: {
      create: async ({ data }: any) => {
        const c = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        conversations.set(c.id, c);
        return c;
      },
      findMany: async ({ where }: any) =>
        [...conversations.values()].filter((c) => c.projectId === where.projectId),
      findUnique: async ({ where, include }: any) => {
        const c = conversations.get(where.id);
        if (!c) return null;
        if (include?.project) return { ...c, project: projects.get(c.projectId) };
        if (include?.participants) {
          return {
            ...c,
            participants: [...participants.values()].filter((p) => p.conversationId === c.id),
            transcript: [...transcripts.values()].find((t) => t.conversationId === c.id) ?? null,
          };
        }
        return c;
      },
      findFirst: async ({ where }: any) =>
        [...conversations.values()].find((c) => c.externalTranscriptionJobId === where.externalTranscriptionJobId) ?? null,
      update: async ({ where, data }: any) => {
        const merged = { ...conversations.get(where.id), ...data };
        conversations.set(where.id, merged);
        return merged;
      },
    },
    conversationParticipant: {
      upsert: async ({ where, create }: any) => {
        const key = `${where.conversationId_diarizationLabel.conversationId}:${where.conversationId_diarizationLabel.diarizationLabel}`;
        const existing = participants.get(key);
        if (existing) return existing;
        const p = { id: nextId(), createdAt: new Date(), personId: null, isSelf: false, ...create };
        participants.set(key, p);
        return p;
      },
    },
    transcript: {
      create: async ({ data }: any) => {
        const t = { id: nextId(), createdAt: new Date(), ...data };
        transcripts.set(t.id, t);
        return t;
      },
    },
    transcriptSegment: {
      createMany: async ({ data }: any) => {
        segments.push(...data);
        return { count: data.length };
      },
    },
    aIProvider: {
      findUniqueOrThrow: async ({ where }: any) => {
        const p = [...aiProviders.values()].find((p) => p.name === where.name);
        if (!p) throw new Error('provider not found');
        return p;
      },
    },
    aIModelVersion: {
      findFirstOrThrow: async ({ where }: any) => {
        const v = [...aiModelVersions.values()].find((v) => v.providerId === where.model.providerId);
        if (!v) throw new Error('model version not found');
        return v;
      },
    },
  };
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
  }
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

// Fake TranscriptionService — не делает реальных HTTP-вызовов (сеть
// отключена в среде разработки), возвращает предсказуемый результат.
class FakeTranscriptionService {
  submitCalls: any[] = [];
  async submitJob(_apiKey: string, params: any) {
    this.submitCalls.push(params);
    return { externalJobId: 'ext-job-1' };
  }
  parseWebhookPayload(payload: any) {
    return new TranscriptionService().parseWebhookPayload(payload);
  }
  async streamUpload() {
    return 'https://cdn.assemblyai.com/upload/fake';
  }
}

async function run() {
  // Выставляется один раз до всех сценариев — requestTranscription()
  // всегда строит webhook URL из этой переменной, порядок выполнения
  // сценариев не должен на это влиять. Первая версия теста
  // выставляла её только внутри одного конкретного сценария — реальный
  // баг теста, найденный именно прогоном, не написанием: сценарий
  // "требует оба согласия", идущий раньше по списку, падал с
  // "API_PUBLIC_BASE_URL is not set", хотя сам код сервиса был рабочим.
  process.env.API_PUBLIC_BASE_URL = 'https://api.example.com';

  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('create() создаёт Conversation со статусом UPLOADED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const fakeTranscription = new FakeTranscriptionService();
    const svc = new ConversationsService(
      prisma as any,
      {} as SecretsService,
      {} as ConsentService,
      fakeTranscription as any,
    );
    const c = await svc.create(USER_ID, PROJECT_ID, {
      sourceType: 'UPLOADED_AUDIO' as any,
      occurredAt: new Date().toISOString(),
    });
    assertEqual(c.status, 'UPLOADED', 'статус нового Conversation');
  });

  test('create() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new ConversationsService(
      prisma as any, {} as SecretsService, {} as ConsentService, new FakeTranscriptionService() as any,
    );
    await assertThrowsAsync(
      () => svc.create(USER_ID, PROJECT_ID, { sourceType: 'UPLOADED_AUDIO' as any, occurredAt: new Date().toISOString() }),
      NotFoundException,
      'create() на чужой проект',
    );
  });

  test('requestTranscription() бросает ForbiddenException при MAXIMUM_PRIVACY', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedUser({ id: USER_ID, privacyProcessingMode: 'MAXIMUM_PRIVACY' });
    const conv = await prisma.conversation.create({
      data: { projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'UPLOADED', occurredAt: new Date() },
    });
    const svc = new ConversationsService(
      prisma as any, {} as SecretsService, {} as ConsentService, new FakeTranscriptionService() as any,
    );
    await assertThrowsAsync(
      () => svc.requestTranscription(USER_ID, conv.id, { audioUrl: 'https://x/y' }),
      ForbiddenException,
      'requestTranscription() при MAXIMUM_PRIVACY',
    );
  });

  test('requestTranscription() бросает ForbiddenException, если статус не UPLOADED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedUser({ id: USER_ID, privacyProcessingMode: 'BALANCED' });
    const conv = await prisma.conversation.create({
      data: { projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'TRANSCRIBING', occurredAt: new Date() },
    });
    const consent = { requireConsent: async () => {} } as any;
    const svc = new ConversationsService(prisma as any, {} as SecretsService, consent, new FakeTranscriptionService() as any);
    await assertThrowsAsync(
      () => svc.requestTranscription(USER_ID, conv.id, { audioUrl: 'https://x/y' }),
      ForbiddenException,
      'requestTranscription() при статусе TRANSCRIBING',
    );
  });

  test('requestTranscription() требует оба согласия (RECORDING и EPHEMERAL_SERVER)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedUser({ id: USER_ID, privacyProcessingMode: 'BALANCED' });
    prisma._seedProvider({ id: 'p1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' });
    prisma._seedModelVersion({ id: 'mv1', providerId: 'p1' });
    const conv = await prisma.conversation.create({
      data: { projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'UPLOADED', occurredAt: new Date() },
    });

    const requestedTypes: string[] = [];
    const consent = {
      requireConsent: async (_u: string, type: string) => { requestedTypes.push(type); },
    } as any;
    const secrets = { resolve: async () => 'fake-key' } as any;
    const svc = new ConversationsService(prisma as any, secrets, consent, new FakeTranscriptionService() as any);

    await svc.requestTranscription(USER_ID, conv.id, { audioUrl: 'https://x/y' });
    assertEqual(requestedTypes, ['RECORDING', 'EPHEMERAL_SERVER'], 'порядок и состав запрошенных согласий');
  });

  test('requestTranscription() успешно переводит статус в TRANSCRIBING и сохраняет job id', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedUser({ id: USER_ID, privacyProcessingMode: 'BALANCED' });
    prisma._seedProvider({ id: 'p1', name: 'assemblyai', credentialRef: 'ASSEMBLYAI_API_KEY' });
    prisma._seedModelVersion({ id: 'mv1', providerId: 'p1' });
    const conv = await prisma.conversation.create({
      data: { projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'UPLOADED', occurredAt: new Date() },
    });
    const consent = { requireConsent: async () => {} } as any;
    const secrets = { resolve: async () => 'fake-key' } as any;
    const svc = new ConversationsService(prisma as any, secrets, consent, new FakeTranscriptionService() as any);

    const updated = await svc.requestTranscription(USER_ID, conv.id, { audioUrl: 'https://x/y' });
    assertEqual(updated.status, 'TRANSCRIBING', 'статус после запроса транскрибации');
    assertEqual(updated.externalTranscriptionJobId, 'ext-job-1', 'сохранённый externalTranscriptionJobId');
  });

  test('handleTranscriptionWebhook() создаёт Transcript+TranscriptSegment+ConversationParticipant', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const conv = await prisma.conversation.create({
      data: {
        projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'TRANSCRIBING',
        occurredAt: new Date(), externalTranscriptionJobId: 'ext-job-1',
      },
    });
    const svc = new ConversationsService(
      prisma as any, {} as SecretsService, {} as ConsentService, new FakeTranscriptionService() as any,
    );

    await svc.handleTranscriptionWebhook({
      id: 'ext-job-1',
      status: 'completed',
      language_code: 'ru',
      utterances: [
        { speaker: 'A', text: 'Привет', start: 0, end: 1000, confidence: 0.95 },
        { speaker: 'B', text: 'Здравствуйте', start: 1000, end: 2500, confidence: 0.9 },
        { speaker: 'A', text: 'Как дела?', start: 2500, end: 3500, confidence: 0.92 },
      ],
    });

    const updated = prisma._getConversation(conv.id);
    assertEqual(updated.status, 'TRANSCRIBED', 'статус после успешного webhook');
    assertEqual(prisma._getSegments().length, 3, 'количество сохранённых сегментов');
    assertEqual(prisma._getParticipants().length, 2, 'количество уникальных участников (A, B)');
  });

  test('handleTranscriptionWebhook() переводит статус в FAILED при ошибке провайдера', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const conv = await prisma.conversation.create({
      data: {
        projectId: PROJECT_ID, sourceType: 'UPLOADED_AUDIO', status: 'TRANSCRIBING',
        occurredAt: new Date(), externalTranscriptionJobId: 'ext-job-2',
      },
    });
    const svc = new ConversationsService(
      prisma as any, {} as SecretsService, {} as ConsentService, new FakeTranscriptionService() as any,
    );
    await svc.handleTranscriptionWebhook({ id: 'ext-job-2', status: 'error', error: 'audio too short' });
    assertEqual(prisma._getConversation(conv.id).status, 'FAILED', 'статус после ошибки провайдера');
  });

  test('handleTranscriptionWebhook() не падает на неизвестный job id — просто не совпадает', async () => {
    const prisma = createFakePrisma();
    const svc = new ConversationsService(
      prisma as any, {} as SecretsService, {} as ConsentService, new FakeTranscriptionService() as any,
    );
    const result = await svc.handleTranscriptionWebhook({ id: 'unknown-job', status: 'completed', utterances: [] });
    assertEqual(result, { acknowledged: true, matched: false }, 'ответ на webhook с неизвестным job id');
  });

  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  const passed = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  console.log(`\nConversationsService: ${passed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }

  if (failed.length > 0) {
    process.exit(1);
  }
}

run();

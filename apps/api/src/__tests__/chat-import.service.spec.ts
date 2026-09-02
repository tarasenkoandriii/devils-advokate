import { ChatImportService } from '../chat-import/chat-import.service';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const conversations: any[] = [];
  const participants: any[] = [];
  const transcripts: any[] = [];
  const segments: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  const prismaCore = {
    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    conversation: {
      create: async ({ data }: any) => {
        const c = { id: nextId(), createdAt: new Date(), ...data };
        conversations.push(c);
        return c;
      },
      findUniqueOrThrow: async ({ where, include }: any) => {
        const c = conversations.find((x) => x.id === where.id);
        if (!c) throw new Error('not found');
        const result: any = { ...c };
        if (include?.participants) result.participants = participants.filter((p) => p.conversationId === c.id);
        if (include?.transcript) {
          const t = transcripts.find((tr) => tr.conversationId === c.id);
          result.transcript = t ? { ...t, segments: segments.filter((s) => s.transcriptId === t.id) } : null;
        }
        return result;
      },
    },
    conversationParticipant: {
      create: async ({ data }: any) => {
        const p = { id: nextId(), createdAt: new Date(), ...data };
        participants.push(p);
        return p;
      },
    },
    transcript: {
      create: async ({ data }: any) => {
        const t = { id: nextId(), createdAt: new Date(), ...data };
        transcripts.push(t);
        return t;
      },
    },
    transcriptSegment: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), createdAt: new Date(), ...data };
        segments.push(s);
        return s;
      },
    },
  };

  return {
    ...prismaCore,
    // $transaction(callback) — вызываем callback с тем же объектом,
    // реальной транзакционности не требуется для теста сервисного слоя.
    $transaction: async (callback: any) => callback(prismaCore),
    _seedProject(p: any) { projects.set(p.id, p); },
    _getConversations() { return conversations; },
    _getParticipants() { return participants; },
    _getSegments() { return segments; },
  };
}

function createFakeConsentService(options: { hasConsent: boolean } = { hasConsent: true }) {
  const calls: { userId: string; consentType: string; projectId?: string }[] = [];
  return {
    calls,
    requireConsent: async (userId: string, consentType: string, projectId?: string) => {
      calls.push({ userId, consentType, projectId });
      if (!options.hasConsent) {
        throw new ForbiddenException(`Consent ${consentType} required`);
      }
    },
  };
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

async function assertThrowsAsync(fn: () => Promise<unknown>, expectedType: any, message: string) {
  try {
    await fn();
    throw new Error(`FAIL: ${message} — expected to throw ${expectedType.name}, did not throw`);
  } catch (err: any) {
    if (!(err instanceof expectedType)) {
      throw new Error(`FAIL: ${message} — expected ${expectedType.name}, got ${err?.constructor?.name}: ${err?.message}`);
    }
  }
}

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';

function seedProject(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('importChat() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new ChatImportService(prisma as any, createFakeConsentService() as any);
    await assertThrowsAsync(
      () => svc.importChat(USER_ID, PROJECT_ID, { messages: [{ sender: 'A', text: 'x', timestampMs: 1 }], selfSenderName: 'A' }),
      NotFoundException,
      'importChat() на чужой проект',
    );
  });

  test('importChat() бросает BadRequestException для пустого списка сообщений', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new ChatImportService(prisma as any, createFakeConsentService() as any);
    await assertThrowsAsync(
      () => svc.importChat(USER_ID, PROJECT_ID, { messages: [], selfSenderName: 'A' }),
      BadRequestException,
      'importChat() с пустыми messages',
    );
  });

  test('importChat() бросает BadRequestException, если selfSenderName не найден среди отправителей', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new ChatImportService(prisma as any, createFakeConsentService() as any);
    await assertThrowsAsync(
      () =>
        svc.importChat(USER_ID, PROJECT_ID, {
          messages: [{ sender: 'Иван', text: 'x', timestampMs: 1 }],
          selfSenderName: 'Пётр',
        }),
      BadRequestException,
      'importChat() с несуществующим selfSenderName',
    );
  });

  test('importChat() бросает ForbiddenException без согласия RECORDING', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new ChatImportService(prisma as any, createFakeConsentService({ hasConsent: false }) as any);
    await assertThrowsAsync(
      () => svc.importChat(USER_ID, PROJECT_ID, { messages: [{ sender: 'A', text: 'x', timestampMs: 1 }], selfSenderName: 'A' }),
      ForbiddenException,
      'importChat() без согласия',
    );
  });

  test('importChat() запрашивает именно ConsentType.RECORDING, не EPHEMERAL_SERVER', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const fakeConsent = createFakeConsentService();
    const svc = new ChatImportService(prisma as any, fakeConsent as any);

    await svc.importChat(USER_ID, PROJECT_ID, { messages: [{ sender: 'A', text: 'x', timestampMs: 1 }], selfSenderName: 'A' });
    assertEqual(fakeConsent.calls.length, 1, 'ровно один запрос согласия');
    assertEqual(fakeConsent.calls[0].consentType, 'RECORDING', 'именно RECORDING, не EPHEMERAL_SERVER — нет внешнего STT-провайдера');
  });

  test('importChat() создаёт Conversation с sourceType=TEXT_IMPORT и status=TRANSCRIBED сразу', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new ChatImportService(prisma as any, createFakeConsentService() as any);

    const result = await svc.importChat(USER_ID, PROJECT_ID, {
      messages: [{ sender: 'A', text: 'x', timestampMs: 1000 }],
      selfSenderName: 'A',
    });
    assertEqual(result.sourceType, 'TEXT_IMPORT', 'sourceType проставлен');
    assertEqual(result.status, 'TRANSCRIBED', 'статус сразу TRANSCRIBED — нет асинхронной транскрибации');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: importChat() создаёт по одному ConversationParticipant на каждого уникального отправителя, isSelf проставлен верно', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new ChatImportService(prisma as any, createFakeConsentService() as any);

    await svc.importChat(USER_ID, PROJECT_ID, {
      messages: [
        { sender: 'Я', text: 'Привет', timestampMs: 1000 },
        { sender: 'Собеседник', text: 'Привет!', timestampMs: 2000 },
        { sender: 'Я', text: 'Как дела?', timestampMs: 3000 },
      ],
      selfSenderName: 'Я',
    });

    const participants = prisma._getParticipants();
    assertEqual(participants.length, 2, 'ровно два уникальных участника, не по одному на сообщение');
    const self = participants.find((p: any) => p.isSelf);
    const other = participants.find((p: any) => !p.isSelf);
    assertEqual(self !== undefined, true, 'участник isSelf=true найден');
    assertEqual(other !== undefined, true, 'участник isSelf=false найден');
  });

  test('importChat() создаёт TranscriptSegment на каждое сообщение с правильным participantId и текстом', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new ChatImportService(prisma as any, createFakeConsentService() as any);

    await svc.importChat(USER_ID, PROJECT_ID, {
      messages: [
        { sender: 'Я', text: 'Первое сообщение', timestampMs: 1000 },
        { sender: 'Собеседник', text: 'Ответ', timestampMs: 5000 },
      ],
      selfSenderName: 'Я',
    });

    const segments = prisma._getSegments();
    assertEqual(segments.length, 2, 'по сегменту на каждое сообщение');
    assertEqual(segments[0].text, 'Первое сообщение', 'текст первого сегмента');
    assertEqual(segments[0].startMs, 0, 'первое сообщение — startMs=0 относительно самого раннего');
    assertEqual(segments[1].startMs, 4000, 'второе сообщение — startMs относительно первого (5000-1000)');
  });

  test('importChat() использует самое раннее сообщение как occurredAt', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new ChatImportService(prisma as any, createFakeConsentService() as any);

    const result = await svc.importChat(USER_ID, PROJECT_ID, {
      messages: [
        { sender: 'A', text: 'x', timestampMs: 5000 },
        { sender: 'A', text: 'y', timestampMs: 2000 }, // раньше первого по порядку в массиве
      ],
      selfSenderName: 'A',
    });
    assertEqual(new Date(result.occurredAt).getTime(), 2000, 'occurredAt = самое раннее сообщение, не первое в массиве');
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
  console.log(`\nChatImportService: ${results.length - failed.length}/${results.length} passed\n`);
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

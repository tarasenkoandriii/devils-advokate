import { ConversationsService } from '../conversations/conversations.service';
import { NotFoundException, ForbiddenException } from '@nestjs/common';

// Пункт [multimodal]: шестой аргумент конструктора — ParalinguisticsService.
function makeFakeParalinguistics() {
  return { wireRelease: () => undefined, enqueueForConversation: async () => ({ jobId: 'j' }) };
}

function createFakePrisma() {
  const projects = new Map<string, any>();
  const conversations = new Map<string, any>();
  const participants = new Map<string, any>();
  const people = new Map<string, any>();

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedConversation(c: any) { conversations.set(c.id, c); },
    _seedParticipant(p: any) { participants.set(p.id, p); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _getParticipant(id: string) { return participants.get(id); },

    person: {
      findFirst: async ({ where }: any) => {
        const p = people.get(where.id);
        if (!p || p.createdByUserId !== where.createdByUserId) return null;
        return p;
      },
    },
    conversationParticipant: {
      findUnique: async ({ where }: any) => {
        const p = participants.get(where.id);
        if (!p) return null;
        const conv = conversations.get(p.conversationId);
        return { ...p, conversation: { ...conv, project: projects.get(conv.projectId) } };
      },
      update: async ({ where, data }: any) => {
        const merged = { ...participants.get(where.id), ...data };
        participants.set(where.id, merged);
        return merged;
      },
    },
  };
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
const PROJECT_ID = 'proj-1';
const CONV_ID = 'conv-1';
const PARTICIPANT_ID = 'part-1';

function seed(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
  prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID });
  prisma._seedParticipant({ id: PARTICIPANT_ID, conversationId: CONV_ID, diarizationLabel: 'A', personId: null, isSelf: false });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('assignParticipant() сопоставляет personId', async () => {
    const prisma = createFakePrisma();
    seed(prisma);
    prisma._seedPerson({ id: 'person-1', createdByUserId: USER_ID });
    const svc = new ConversationsService(prisma as any, {} as any, {} as any, {} as any, {} as any, makeFakeParalinguistics() as any);

    const updated = await svc.assignParticipant(USER_ID, PARTICIPANT_ID, { personId: 'person-1' });
    assertEqual(updated.personId, 'person-1', 'personId сопоставлен');
    assertEqual(updated.isSelf, false, 'isSelf остаётся false');
  });

  test('assignParticipant() помечает isSelf=true', async () => {
    const prisma = createFakePrisma();
    seed(prisma);
    const svc = new ConversationsService(prisma as any, {} as any, {} as any, {} as any, {} as any, makeFakeParalinguistics() as any);

    const updated = await svc.assignParticipant(USER_ID, PARTICIPANT_ID, { isSelf: true });
    assertEqual(updated.isSelf, true, 'isSelf проставлен');
    assertEqual(updated.personId, null, 'personId остаётся null для isSelf');
  });

  test('assignParticipant() бросает ForbiddenException при одновременных personId и isSelf', async () => {
    const prisma = createFakePrisma();
    seed(prisma);
    prisma._seedPerson({ id: 'person-1', createdByUserId: USER_ID });
    const svc = new ConversationsService(prisma as any, {} as any, {} as any, {} as any, {} as any, makeFakeParalinguistics() as any);

    await assertThrowsAsync(
      () => svc.assignParticipant(USER_ID, PARTICIPANT_ID, { personId: 'person-1', isSelf: true }),
      ForbiddenException,
      'assignParticipant() с обоими полями сразу',
    );
  });

  test('assignParticipant() бросает NotFoundException для чужого участника', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    prisma._seedConversation({ id: CONV_ID, projectId: PROJECT_ID });
    prisma._seedParticipant({ id: PARTICIPANT_ID, conversationId: CONV_ID, diarizationLabel: 'A', personId: null, isSelf: false });
    const svc = new ConversationsService(prisma as any, {} as any, {} as any, {} as any, {} as any, makeFakeParalinguistics() as any);

    await assertThrowsAsync(
      () => svc.assignParticipant(USER_ID, PARTICIPANT_ID, { isSelf: true }),
      NotFoundException,
      'assignParticipant() на чужого участника',
    );
  });

  test('assignParticipant() бросает NotFoundException, если personId — чужая персона', async () => {
    const prisma = createFakePrisma();
    seed(prisma);
    prisma._seedPerson({ id: 'person-1', createdByUserId: 'other-user' });
    const svc = new ConversationsService(prisma as any, {} as any, {} as any, {} as any, {} as any, makeFakeParalinguistics() as any);

    await assertThrowsAsync(
      () => svc.assignParticipant(USER_ID, PARTICIPANT_ID, { personId: 'person-1' }),
      NotFoundException,
      'assignParticipant() с чужой персоной',
    );
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
  console.log(`\nConversationsService.assignParticipant: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

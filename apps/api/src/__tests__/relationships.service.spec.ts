import { RelationshipsService } from '../relationships/relationships.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const people = new Map<string, any>();
  const relationships: any[] = [];
  const projects = new Map<string, any>();
  const conversations = new Map<string, any>();
  const participants: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedConversation(c: any) { conversations.set(c.id, c); },
    _seedParticipant(p: any) { participants.push(p); },
    _seedRelationship(r: any) { relationships.push({ id: r.id ?? nextId(), createdAt: new Date(), ...r }); },
    _getRelationships() { return relationships; },

    person: {
      findFirst: async ({ where }: any) => {
        const p = people.get(where.id);
        if (!p || p.createdByUserId !== where.createdByUserId) return null;
        return p;
      },
      findMany: async ({ where }: any) => [...people.values()].filter((p) => where.id.in.includes(p.id)),
    },
    relationship: {
      create: async ({ data }: any) => {
        const r = { id: nextId(), createdAt: new Date(), ...data };
        relationships.push(r);
        return r;
      },
      findMany: async ({ where }: any) => {
        if (where.OR) {
          return relationships.filter((r) => r.personAId === where.OR[0].personAId || r.personBId === where.OR[1].personBId);
        }
        if (where.createdByUserId) {
          return relationships.filter((r) => r.createdByUserId === where.createdByUserId);
        }
        return relationships;
      },
      findUnique: async ({ where }: any) => relationships.find((r) => r.id === where.id) ?? null,
      delete: async ({ where }: any) => {
        const idx = relationships.findIndex((r) => r.id === where.id);
        if (idx >= 0) relationships.splice(idx, 1);
      },
    },
    conversationParticipant: {
      findMany: async ({ where }: any) => {
        return participants
          .filter((p) => p.personId !== null && p.isSelf === false)
          .filter((p) => {
            const conv = conversations.get(p.conversationId);
            const project = conv ? projects.get(conv.projectId) : null;
            return project?.ownerId === where.conversation.project.ownerId;
          })
          .map((p) => ({ personId: p.personId, conversationId: p.conversationId }));
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
const PERSON_A = 'person-a';
const PERSON_B = 'person-b';
const PERSON_C = 'person-c';

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('create() отклоняет связь человека с самим собой', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_A, createdByUserId: USER_ID });
    const svc = new RelationshipsService(prisma as any);
    await assertThrowsAsync(
      () => svc.create(USER_ID, { personAId: PERSON_A, personBId: PERSON_A, type: 'FAMILY', label: 'x', direction: 'MUTUAL', sourceType: 'PERSONAL_RECORD' }),
      BadRequestException,
      'create() personA === personB',
    );
  });

  test('create() бросает NotFoundException, если personB не принадлежит пользователю', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_A, createdByUserId: USER_ID });
    prisma._seedPerson({ id: PERSON_B, createdByUserId: 'other-user' });
    const svc = new RelationshipsService(prisma as any);
    await assertThrowsAsync(
      () => svc.create(USER_ID, { personAId: PERSON_A, personBId: PERSON_B, type: 'HIERARCHY', label: 'начальник', direction: 'A_TO_B', sourceType: 'PERSONAL_RECORD' }),
      NotFoundException,
      'create() с чужой personB',
    );
  });

  test('create() успешно создаёт связь с правильными полями', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_A, createdByUserId: USER_ID });
    prisma._seedPerson({ id: PERSON_B, createdByUserId: USER_ID });
    const svc = new RelationshipsService(prisma as any);

    const created = await svc.create(USER_ID, {
      personAId: PERSON_A, personBId: PERSON_B, type: 'HIERARCHY', label: 'непосредственный руководитель', direction: 'A_TO_B', strength: 0.9, sourceType: 'PERSONAL_RECORD',
    });
    assertEqual(created.type, 'HIERARCHY', 'type сохранён');
    assertEqual(created.label, 'непосредственный руководитель', 'label сохранён');
    assertEqual(created.direction, 'A_TO_B', 'direction сохранён');
    assertEqual(created.strength, 0.9, 'strength сохранён');
    assertEqual(created.createdByUserId, USER_ID, 'ownership проставлен');
  });

  test('listForPerson() возвращает связи, где персона — любая из сторон (A или B)', async () => {
    const prisma = createFakePrisma();
    prisma._seedPerson({ id: PERSON_A, createdByUserId: USER_ID });
    prisma._seedPerson({ id: PERSON_B, createdByUserId: USER_ID });
    prisma._seedRelationship({ personAId: PERSON_A, personBId: PERSON_B, type: 'SOCIAL', label: 'x', direction: 'MUTUAL', sourceType: 'USER_GUESS', createdByUserId: USER_ID });

    const svc = new RelationshipsService(prisma as any);
    const listA = await svc.listForPerson(USER_ID, PERSON_A);
    assertEqual(listA.length, 1, 'видна из стороны A');
  });

  test('delete() бросает NotFoundException для чужой связи', async () => {
    const prisma = createFakePrisma();
    prisma._seedRelationship({ id: 'rel-1', personAId: PERSON_A, personBId: PERSON_B, type: 'SOCIAL', label: 'x', direction: 'MUTUAL', sourceType: 'USER_GUESS', createdByUserId: 'other-user' });
    const svc = new RelationshipsService(prisma as any);
    await assertThrowsAsync(() => svc.delete(USER_ID, 'rel-1'), NotFoundException, 'delete() на чужую связь');
  });

  test('delete() удаляет связь владельца', async () => {
    const prisma = createFakePrisma();
    prisma._seedRelationship({ id: 'rel-1', personAId: PERSON_A, personBId: PERSON_B, type: 'SOCIAL', label: 'x', direction: 'MUTUAL', sourceType: 'USER_GUESS', createdByUserId: USER_ID });
    const svc = new RelationshipsService(prisma as any);
    await svc.delete(USER_ID, 'rel-1');
    assertEqual(prisma._getRelationships().length, 0, 'связь удалена');
  });

  test('suggestFromCoParticipation() находит пару из общего разговора', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-1', ownerId: USER_ID });
    prisma._seedConversation({ id: 'conv-1', projectId: 'proj-1' });
    prisma._seedPerson({ id: PERSON_A, createdByUserId: USER_ID });
    prisma._seedPerson({ id: PERSON_B, createdByUserId: USER_ID });
    prisma._seedParticipant({ personId: PERSON_A, conversationId: 'conv-1', isSelf: false });
    prisma._seedParticipant({ personId: PERSON_B, conversationId: 'conv-1', isSelf: false });

    const svc = new RelationshipsService(prisma as any);
    const suggestions = await svc.suggestFromCoParticipation(USER_ID);
    assertEqual(suggestions.length, 1, 'одна пара найдена');
    assertEqual(suggestions[0].sharedConversations, 1, 'один общий разговор');
  });

  test('suggestFromCoParticipation() исключает пары, у которых УЖЕ есть связь', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-1', ownerId: USER_ID });
    prisma._seedConversation({ id: 'conv-1', projectId: 'proj-1' });
    prisma._seedPerson({ id: PERSON_A, createdByUserId: USER_ID });
    prisma._seedPerson({ id: PERSON_B, createdByUserId: USER_ID });
    prisma._seedParticipant({ personId: PERSON_A, conversationId: 'conv-1', isSelf: false });
    prisma._seedParticipant({ personId: PERSON_B, conversationId: 'conv-1', isSelf: false });
    prisma._seedRelationship({ personAId: PERSON_A, personBId: PERSON_B, type: 'SOCIAL', label: 'x', direction: 'MUTUAL', sourceType: 'USER_GUESS', createdByUserId: USER_ID });

    const svc = new RelationshipsService(prisma as any);
    const suggestions = await svc.suggestFromCoParticipation(USER_ID);
    assertEqual(suggestions.length, 0, 'уже подтверждённая пара не предлагается снова');
  });

  test('suggestFromCoParticipation() исключает isSelf-участников (пользователь — не Person)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-1', ownerId: USER_ID });
    prisma._seedConversation({ id: 'conv-1', projectId: 'proj-1' });
    prisma._seedPerson({ id: PERSON_A, createdByUserId: USER_ID });
    prisma._seedParticipant({ personId: PERSON_A, conversationId: 'conv-1', isSelf: false });
    prisma._seedParticipant({ personId: null, conversationId: 'conv-1', isSelf: true });

    const svc = new RelationshipsService(prisma as any);
    const suggestions = await svc.suggestFromCoParticipation(USER_ID);
    assertEqual(suggestions.length, 0, 'нет пары без второго Person — isSelf не считается участником графа');
  });

  test('suggestFromCoParticipation() считает число ОБЩИХ разговоров, сортирует по убыванию', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-1', ownerId: USER_ID });
    prisma._seedConversation({ id: 'conv-1', projectId: 'proj-1' });
    prisma._seedConversation({ id: 'conv-2', projectId: 'proj-1' });
    prisma._seedConversation({ id: 'conv-3', projectId: 'proj-1' });
    prisma._seedPerson({ id: PERSON_A, createdByUserId: USER_ID });
    prisma._seedPerson({ id: PERSON_B, createdByUserId: USER_ID });
    prisma._seedPerson({ id: PERSON_C, createdByUserId: USER_ID });
    // A+B встречались дважды (conv-1, conv-2), A+C — один раз
    // (conv-3). B никогда не появляется в одном разговоре с C.
    prisma._seedParticipant({ personId: PERSON_A, conversationId: 'conv-1', isSelf: false });
    prisma._seedParticipant({ personId: PERSON_B, conversationId: 'conv-1', isSelf: false });
    prisma._seedParticipant({ personId: PERSON_A, conversationId: 'conv-2', isSelf: false });
    prisma._seedParticipant({ personId: PERSON_B, conversationId: 'conv-2', isSelf: false });
    prisma._seedParticipant({ personId: PERSON_A, conversationId: 'conv-3', isSelf: false });
    prisma._seedParticipant({ personId: PERSON_C, conversationId: 'conv-3', isSelf: false });

    const svc = new RelationshipsService(prisma as any);
    const suggestions = await svc.suggestFromCoParticipation(USER_ID);
    assertEqual(suggestions.length, 2, 'две пары найдены: A-B и A-C (B-C не встречались вместе)');
    assertEqual(suggestions[0].sharedConversations, 2, 'самая частая пара (A-B, 2 разговора) идёт первой');
  });

  test('suggestFromCoParticipation() возвращает пустой список, если нет разговоров с несколькими фигурантами', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-1', ownerId: USER_ID });
    const svc = new RelationshipsService(prisma as any);
    const suggestions = await svc.suggestFromCoParticipation(USER_ID);
    assertEqual(suggestions, [], 'пустой список, не падение');
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
  console.log(`\nRelationshipsService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

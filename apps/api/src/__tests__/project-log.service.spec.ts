import { ProjectLogService } from '../project-log/project-log.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const projectPeople: any[] = [];
  const signals: any[] = [];
  const participants = new Map<string, any>();
  const conversations = new Map<string, any>();
  const people = new Map<string, any>();

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedProjectPerson(pp: any) { projectPeople.push({ statusChangedAt: null, ...pp }); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedConversation(c: any) { conversations.set(c.id, c); },
    _seedParticipant(p: any) { participants.set(p.id, p); },
    _seedSignal(s: any) { signals.push({ id: signals.length + 1, createdAt: new Date(), ...s }); },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    projectPerson: {
      findMany: async ({ where }: any) =>
        projectPeople
          .filter((pp) => pp.projectId === where.projectId && pp.statusChangedAt !== null)
          .map((pp) => ({ ...pp, person: people.get(pp.personId) })),
    },
    conversationSignal: {
      findMany: async ({ where }: any) => {
        return signals
          .filter((s) => where.signalType.in.includes(s.signalType))
          .map((s) => {
            const participant = participants.get(s.participantId);
            if (!participant) return { ...s, participant: null };
            const conversation = conversations.get(participant.conversationId);
            if (!conversation || conversation.projectId !== where.participant.conversation.projectId) return { ...s, participant: null };
            if (where.participant.personId !== undefined && !participant.personId) return { ...s, participant: null };
            return {
              ...s,
              participant: { ...participant, conversation, person: participant.personId ? people.get(participant.personId) : null },
            };
          })
          .filter((s) => s.participant !== null);
      },
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
const PERSON_ID = 'person-1';

function seedProject(prisma: ReturnType<typeof createFakePrisma>) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
  prisma._seedPerson({ id: PERSON_ID, displayName: 'Иван' });
}

async function run() {
  const { NotFoundException } = await import('@nestjs/common');
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('getLog() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new ProjectLogService(prisma as any);
    await assertThrowsAsync(() => svc.getLog(USER_ID, PROJECT_ID), NotFoundException, 'getLog() на чужой проект');
  });

  test('getLog() возвращает пустой лог без событий', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new ProjectLogService(prisma as any);
    const log = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(log, [], 'пустой лог без данных');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: getLog() красит смену на FIGURANT красным, на PERSONA зелёным', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_ID, status: 'FIGURANT', statusChangedAt: new Date('2026-01-01') });
    const svc = new ProjectLogService(prisma as any);

    const log = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(log.length, 1, 'одна запись о смене статуса');
    assertEqual(log[0].color, 'RED', 'переход в фигуранта — красный (эскалация)');
    assertEqual(log[0].eventType, 'STATUS_CHANGE', 'тип события верный');
  });

  test('getLog() красит возврат в PERSONA зелёным', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_ID, status: 'PERSONA', statusChangedAt: new Date('2026-01-02') });
    const svc = new ProjectLogService(prisma as any);

    const log = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(log[0].color, 'GREEN', 'возврат в персону — зелёный (сглаживание)');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: getLog() всегда называет конкретного человека в описании, не абстрактную фразу', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_ID, status: 'FIGURANT', statusChangedAt: new Date() });
    const svc = new ProjectLogService(prisma as any);

    const log = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(log[0].description.includes('Иван'), true, 'имя персоны реально присутствует в тексте записи, не обобщённая фраза');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: getLog() честно пропускает сигналы БЕЗ привязанной персоны, не выдумывает имя', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedConversation({ id: 'conv-1', projectId: PROJECT_ID });
    prisma._seedParticipant({ id: 'part-1', conversationId: 'conv-1', personId: null }); // диаризация не сопоставлена
    prisma._seedSignal({ signalType: 'MANIPULATION_PATTERN', participantId: 'part-1' });
    const svc = new ProjectLogService(prisma as any);

    const log = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(log.length, 0, 'сигнал без привязанной персоны честно пропущен, не показан с выдуманным именем');
  });

  test('getLog() включает сигнал расхождения с привязанной персоной, со ссылкой на разговор', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedConversation({ id: 'conv-1', projectId: PROJECT_ID });
    prisma._seedParticipant({ id: 'part-1', conversationId: 'conv-1', personId: PERSON_ID });
    prisma._seedSignal({ signalType: 'FACTUAL_DISCREPANCY', participantId: 'part-1' });
    const svc = new ProjectLogService(prisma as any);

    const log = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(log.length, 1, 'сигнал с привязанной персоной включён');
    assertEqual(log[0].eventType, 'DISCREPANCY_DETECTED', 'тип события — расхождение');
    assertEqual(log[0].color, 'RED', 'появление флага — эскалация');
    assertEqual(log[0].sourceConversationId, 'conv-1', 'прямая ссылка на разговор сохранена');
  });

  test('getLog() сортирует все события по времени, самые новые первыми', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: PERSON_ID, status: 'FIGURANT', statusChangedAt: new Date('2026-01-01') });
    prisma._seedConversation({ id: 'conv-1', projectId: PROJECT_ID });
    prisma._seedParticipant({ id: 'part-1', conversationId: 'conv-1', personId: PERSON_ID });
    prisma._seedSignal({ signalType: 'MANIPULATION_PATTERN', participantId: 'part-1', createdAt: new Date('2026-01-05') });
    const svc = new ProjectLogService(prisma as any);

    const log = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(log.length, 2, 'оба события видны');
    assertEqual(log[0].eventType, 'MANIPULATION_DETECTED', 'более позднее событие (5 января) идёт первым');
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
  console.log(`\nProjectLogService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

import { ProjectLogService } from '../project-log/project-log.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const projectPeople: any[] = [];
  const signals: any[] = [];
  const participants = new Map<string, any>();
  const conversations = new Map<string, any>();
  const people = new Map<string, any>();
  // Пункт [project-log-v2] — два новых источника событий лога.
  const escalationEvents: any[] = [];
  const probingTopics: any[] = [];

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedProjectPerson(pp: any) { projectPeople.push({ statusChangedAt: null, ...pp }); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedConversation(c: any) { conversations.set(c.id, c); },
    _seedParticipant(p: any) { participants.set(p.id, p); },
    _seedSignal(s: any) { signals.push({ id: `sig-${signals.length + 1}`, createdAt: new Date(), disputed: false, disputedAt: null, ...s }); },
    _seedEscalation(e: any) { escalationEvents.push({ id: `esc-${escalationEvents.length + 1}`, personId: null, createdAt: new Date(), ...e }); },
    _seedProbing(t: any) { probingTopics.push({ id: `probe-${probingTopics.length + 1}`, personId: null, repeatCount: 1, lastDetectedAt: new Date(), ...t }); },
    _signals: signals,

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
      findFirst: async ({ where }: any) => {
        const s = signals.find((x) => x.id === where.id);
        if (!s) return null;
        const participant = participants.get(s.participantId);
        const conversation = participant ? conversations.get(participant.conversationId) : null;
        if (!conversation || conversation.projectId !== where.participant.conversation.projectId) return null;
        return s;
      },
      update: async ({ where, data }: any) => {
        const s = signals.find((x) => x.id === where.id);
        Object.assign(s, data);
        return s;
      },
    },
    escalationCategoryEvent: {
      findMany: async ({ where }: any) =>
        escalationEvents
          .filter((e) => e.projectId === where.projectId && (where.personId?.not === null ? e.personId !== null : true))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((e) => ({ ...e, person: e.personId ? people.get(e.personId) : null })),
    },
    probingTopic: {
      findMany: async ({ where }: any) =>
        probingTopics
          .filter((t) => t.projectId === where.projectId && (where.personId?.not === null ? t.personId !== null : true))
          .map((t) => ({ ...t, person: t.personId ? people.get(t.personId) : null })),
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

  // ─── Пункт [project-log-v2]: третий источник событий и снятие флагов ───
  // §3.39 ТЗ описывает лог как ДИНАМИКУ конфликта в обе стороны. До этого
  // пункта лог умел показывать только рост: два источника из трёх и только
  // появление флагов. Тесты ниже держат именно вторую половину.

  test('КЛЮЧЕВОЙ ТЕСТ: событие накала без выбранного собеседника в лог не попадает — записи лога всегда называют человека', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedEscalation({ projectId: PROJECT_ID, sessionId: 's-1', category: 'CALM', personId: null, createdAt: new Date('2026-02-01T10:00:00Z') });
    prisma._seedEscalation({ projectId: PROJECT_ID, sessionId: 's-1', category: 'CRITICAL', personId: null, createdAt: new Date('2026-02-01T10:05:00Z') });
    prisma._seedProbing({ projectId: PROJECT_ID, topicDescription: 'бюджет на переезд', repeatCount: 3, personId: null });
    const svc = new ProjectLogService(prisma as any);

    const log = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(log.length, 0, 'ни накал, ни прощупывание без собеседника не показаны — и не показаны с обобщённым «конфликт обострился»');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: рост накала — 🔴, снижение — 🟢; первое событие сессии записью не становится', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedEscalation({ projectId: PROJECT_ID, sessionId: 's-1', category: 'CALM', personId: PERSON_ID, createdAt: new Date('2026-02-01T10:00:00Z') });
    prisma._seedEscalation({ projectId: PROJECT_ID, sessionId: 's-1', category: 'HIGH', personId: PERSON_ID, createdAt: new Date('2026-02-01T10:05:00Z') });
    prisma._seedEscalation({ projectId: PROJECT_ID, sessionId: 's-1', category: 'RISING', personId: PERSON_ID, createdAt: new Date('2026-02-01T10:20:00Z') });
    const svc = new ProjectLogService(prisma as any);

    const log = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(log.length, 2, 'два перехода, а не три события — первому не с чем сравниваться, и точку отсчёта мы не придумываем');
    assertEqual(log[0].eventType, 'ESCALATION_DOWN', 'последний по времени — снижение');
    assertEqual(log[0].color, 'GREEN', 'снижение накала — зелёная запись, ТЗ прямо называет это сглаживанием');
    assertEqual(log[1].eventType, 'ESCALATION_UP', 'предыдущий — рост');
    assertEqual(log[1].color, 'RED', 'рост накала — красная запись');
    assertEqual(log[1].description.includes('Иван'), true, 'запись называет человека, а не «конфликт обострился»');
    assertEqual(log[1].sourceSessionId, 's-1', 'ссылка на сессию сохранена — buкально ТЗ «с прямой ссылкой на разговор/сессию»');
  });

  test('повтор той же категории записью не становится, а разные сессии не склеиваются между собой', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedEscalation({ projectId: PROJECT_ID, sessionId: 's-1', category: 'CALM', personId: PERSON_ID, createdAt: new Date('2026-02-01T10:00:00Z') });
    prisma._seedEscalation({ projectId: PROJECT_ID, sessionId: 's-1', category: 'CALM', personId: PERSON_ID, createdAt: new Date('2026-02-01T10:01:00Z') });
    // Новая сессия начинается с высокого накала — это НЕ переход
    // «спокойно → высокий накал» из прошлого разговора.
    prisma._seedEscalation({ projectId: PROJECT_ID, sessionId: 's-2', category: 'HIGH', personId: PERSON_ID, createdAt: new Date('2026-02-05T10:00:00Z') });
    const svc = new ProjectLogService(prisma as any);

    const log = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(log.length, 0, 'ни повтор категории, ни первое событие новой сессии переходом не считаются');
  });

  test('прощупывание попадает в лог только с порога повторов и называет тему словами самой темы', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedProbing({ projectId: PROJECT_ID, topicDescription: 'ваша зарплата', repeatCount: 1, personId: PERSON_ID });
    prisma._seedProbing({ projectId: PROJECT_ID, topicDescription: 'бюджет на переезд', repeatCount: 3, personId: PERSON_ID, lastDetectedAt: new Date('2026-03-01') });
    const svc = new ProjectLogService(prisma as any);

    const log = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(log.length, 1, 'одно упоминание темы прощупыванием не считается — в лог идёт только тема, перешедшая порог');
    assertEqual(log[0].eventType, 'PROBING_DETECTED', 'тип события верный');
    assertEqual(log[0].description.includes('бюджет на переезд'), true, 'тема названа своими словами, не «ведёт себя подозрительно»');
    assertEqual(log[0].description.includes('Иван'), true, 'человек назван');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: снятие флага даёт 🟢-запись и НЕ стирает 🔴-запись о его появлении', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedConversation({ id: 'conv-1', projectId: PROJECT_ID });
    prisma._seedParticipant({ id: 'part-1', conversationId: 'conv-1', personId: PERSON_ID });
    prisma._seedSignal({ signalType: 'MANIPULATION_PATTERN', participantId: 'part-1', createdAt: new Date('2026-04-01') });
    const svc = new ProjectLogService(prisma as any);

    const before = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(before.length, 1, 'до снятия — одна запись о появлении флага');
    assertEqual(before[0].sourceSignalId, 'sig-1', 'запись несёт id флага — по нему интерфейс и даёт действие «снять»');

    await svc.setFlagDisputed(USER_ID, PROJECT_ID, 'sig-1', true);
    const after = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(after.length, 2, 'хронология: флаг появился и был снят — обе записи, а не переписанная задним числом одна');
    assertEqual(after[0].eventType, 'FLAG_WITHDRAWN', 'снятие — самое позднее событие');
    assertEqual(after[0].color, 'GREEN', 'снятие флага — сглаживание');
    assertEqual(after[0].description.includes('Вы сняли'), true, 'текст говорит, что это сделал человек, а не система «передумала»');

    // Человек может передумать обратно — зелёная запись тогда исчезает,
    // иначе лог утверждал бы, что флаг снят, когда он снова активен.
    await svc.setFlagDisputed(USER_ID, PROJECT_ID, 'sig-1', false);
    const restored = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(restored.length, 1, 'возврат флага убирает запись о снятии');
    assertEqual(prisma._signals[0].disputedAt, null, 'дата снятия обнулена вместе с флагом');
  });

  test('снять флаг в чужом проекте нельзя, и ни один сервис не выставляет disputed сам', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedProject({ id: 'proj-2', ownerId: USER_ID });
    prisma._seedConversation({ id: 'conv-1', projectId: PROJECT_ID });
    prisma._seedParticipant({ id: 'part-1', conversationId: 'conv-1', personId: PERSON_ID });
    prisma._seedSignal({ signalType: 'FACTUAL_DISCREPANCY', participantId: 'part-1' });
    const svc = new ProjectLogService(prisma as any);

    // Флаг существует, но в другом проекте — маршрут не должен позволять
    // снять его «через» свой проект.
    await assertThrowsAsync(() => svc.setFlagDisputed(USER_ID, 'proj-2', 'sig-1', true), NotFoundException, 'снятие флага чужого проекта');
    assertEqual(prisma._signals[0].disputed, false, 'флаг остался нетронутым');
  });

  test('КЛЮЧЕВОЙ ТЕСТ (мутационная сверка 2026-09-04): запись лога называет человека, даже если фильтр запроса ослабили', async () => {
    // Мутация «убрать `if (!s.participant?.personId) continue;`» проходила
    // весь набор тестов зелёной. Причина: фейк честно повторял фильтр
    // запроса (`personId: { not: null }`) и сигнала без персоны наверх не
    // отдавал — то есть проверялся фильтр, а страховка в коде не
    // проверялась ничем. А правило лога здесь категоричное: «запись
    // всегда называет человека»; запись про «без имени» — это обвинение
    // без адресата, худший возможный вид находки в этом продукте.
    //
    // Поэтому фейк здесь НАМЕРЕННО ослаблен: он игнорирует фильтр по
    // personId, как повёл бы себя код после невнимательной правки
    // запроса. Тест держит именно вторую линию защиты.
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedConversation({ id: 'conv-1', projectId: PROJECT_ID });
    prisma._seedParticipant({ id: 'part-1', conversationId: 'conv-1', personId: PERSON_ID });
    prisma._seedParticipant({ id: 'part-anon', conversationId: 'conv-1', personId: null });
    prisma._seedSignal({ signalType: 'FACTUAL_DISCREPANCY', participantId: 'part-1' });
    prisma._seedSignal({ signalType: 'MANIPULATION_PATTERN', participantId: 'part-anon' });

    const strict = prisma.conversationSignal.findMany;
    prisma.conversationSignal.findMany = async ({ where }: any) => {
      // Тот же вызов, но БЕЗ условия про personId — база вернула строку,
      // которую фильтр обязан был отсечь.
      const { personId: _dropped, ...participantWhere } = where.participant ?? {};
      return strict({ where: { ...where, participant: participantWhere } });
    };

    const svc = new ProjectLogService(prisma as any);
    const log = await svc.getLog(USER_ID, PROJECT_ID);

    assertEqual(log.length, 1, 'сигнал без привязанной персоны в лог не попал');
    assertEqual(log[0].personId, PERSON_ID, 'единственная запись — про названного человека');
    assertEqual(
      log.every((e: any) => Boolean(e.personId) && e.personName !== 'без имени'),
      true,
      'ни одной записи без адресата',
    );
  });

  test('флаг, снятый до появления disputedAt, не получает выдуманную дату события', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    prisma._seedConversation({ id: 'conv-1', projectId: PROJECT_ID });
    prisma._seedParticipant({ id: 'part-1', conversationId: 'conv-1', personId: PERSON_ID });
    // Старая строка: disputed уже true, даты снятия нет.
    prisma._seedSignal({ signalType: 'FACTUAL_DISCREPANCY', participantId: 'part-1', disputed: true, disputedAt: null });
    const svc = new ProjectLogService(prisma as any);

    const log = await svc.getLog(USER_ID, PROJECT_ID);
    assertEqual(log.length, 1, 'только запись о появлении — «снято» без даты в хронологию не ставится');
    assertEqual(log[0].eventType, 'DISCREPANCY_DETECTED', 'это именно запись о появлении');
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

run().catch((err) => {
  // Падение вне тела теста (в фейке, в модульном коде) — это
  // провал файла, а не тихий unhandled rejection.
  console.error(err);
  process.exit(1);
});

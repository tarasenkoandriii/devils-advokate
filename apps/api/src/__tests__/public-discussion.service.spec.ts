import { PublicDiscussionService } from '../public-discussion/public-discussion.service';

function fakeConsent(granted = true) {
  return { requireConsent: async () => { if (!granted) throw new ForbiddenException('Consent required'); } } as any;
}
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const argumentsStore: any[] = [];
  const participants: any[] = [];
  const submissions: any[] = [];
  const comments: any[] = [];
  const protocols: any[] = [];
  const closingMessages: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedArgument(a: any) { argumentsStore.push(a); },
    _seedProtocol(p: any) { protocols.push({ id: nextId(), createdAt: new Date(), ...p }); },
    _seedClosingMessage(m: any) { closingMessages.push({ id: nextId(), createdAt: new Date(), ...m }); },
    _seedSubmission(s: any) { submissions.push({ id: s.id ?? nextId(), upvotes: 0, downvotes: 0, status: 'PENDING', participantId: null, createdAt: new Date(), ...s }); },
    _getSubmissions() { return submissions; },
    _getArguments() { return argumentsStore; },
    _getParticipants() { return participants; },

    project: {
      findFirst: async ({ where }: any) => {
        if (where.publicShareToken !== undefined) {
          return [...projects.values()].find((p) => p.publicShareToken === where.publicShareToken) ?? null;
        }
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
      update: async ({ where, data }: any) => {
        const p = { ...projects.get(where.id), ...data };
        projects.set(where.id, p);
        return p;
      },
    },
    argument: {
      findMany: async ({ where }: any) =>
        argumentsStore.filter(
          (a) =>
            a.projectId === where.projectId &&
            (where.targetPersonId === undefined ? true : a.targetPersonId === null) &&
            (where.stance?.in ? where.stance.in.includes(a.stance) : true),
        ),
      create: async ({ data }: any) => {
        const a = { id: nextId(), createdAt: new Date(), ...data };
        argumentsStore.push(a);
        return a;
      },
    },
    publicParticipant: {
      create: async ({ data }: any) => {
        const p = { id: nextId(), createdAt: new Date(), ...data };
        participants.push(p);
        return p;
      },
      findFirst: async ({ where }: any) => participants.find((p) => p.id === where.id && p.projectId === where.projectId) ?? null,
    },
    publicArgumentSubmission: {
      create: async ({ data }: any) => {
        const s = { id: nextId(), status: 'PENDING', upvotes: 0, downvotes: 0, createdAt: new Date(), ...data };
        submissions.push(s);
        return s;
      },
      findFirst: async ({ where }: any) => submissions.find((s) => s.id === where.id && s.projectId === where.projectId) ?? null,
      findMany: async ({ where, include }: any) => {
        let result = submissions.filter((s) => s.projectId === where.projectId);
        if (include?.participant) {
          result = result.map((s) => ({ ...s, participant: participants.find((p) => p.id === s.participantId) ?? null }));
        }
        return result.sort((a, b) => b.createdAt - a.createdAt);
      },
      update: async ({ where, data }: any) => {
        const idx = submissions.findIndex((s) => s.id === where.id);
        submissions[idx] = { ...submissions[idx], ...data };
        return submissions[idx];
      },
    },
    publicComment: {
      create: async ({ data }: any) => {
        const c = { id: nextId(), createdAt: new Date(), ...data };
        comments.push(c);
        return c;
      },
      findMany: async ({ where }: any) => comments.filter((c) => c.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt),
    },
    // Пункт 80 — узкий read-only объём командного режима.
    protocol: {
      findFirst: async ({ where }: any) => protocols.filter((p) => p.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
    },
    closingMessage: {
      findFirst: async ({ where }: any) => closingMessages.filter((m) => m.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
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
const TOKEN = 'test-token-abc';

function seedProject(prisma: ReturnType<typeof createFakePrisma>, publicShareToken: string | null = null) {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Продавать ли квартиру?', goal: 'Переехать в другой город', publicShareToken });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('enableSharing() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());
    await assertThrowsAsync(() => svc.enableSharing(USER_ID, PROJECT_ID), NotFoundException, 'enableSharing() на чужой проект');
  });

  test('enableSharing() генерирует непредсказуемый непустой токен', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    const updated = await svc.enableSharing(USER_ID, PROJECT_ID);
    assertEqual(typeof updated.publicShareToken, 'string', 'токен — строка');
    assertEqual(updated.publicShareToken!.length > 20, true, 'токен достаточно длинный, не тривиально угадываемый');
  });

  test('РЕГРЕСІЯ (аудит БД 2026-08-30): enableSharing() без згоди PUBLIC_SHARING — ForbiddenException, токен не видається', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma);
    const svc = new PublicDiscussionService(prisma as any, fakeConsent(false));

    await assertThrowsAsync(() => svc.enableSharing(USER_ID, PROJECT_ID), ForbiddenException, 'enableSharing() без згоди має відмовляти, а не мовчки публікувати проект');
  });

  test('disableSharing() сбрасывает токен в null', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    const updated = await svc.disableSharing(USER_ID, PROJECT_ID);
    assertEqual(updated.publicShareToken, null, 'токен сброшен');
  });

  test('publicView() бросает NotFoundException для недействительного токена', async () => {
    const prisma = createFakePrisma();
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());
    await assertThrowsAsync(() => svc.publicView('nonexistent-token'), NotFoundException, 'publicView() с несуществующим токеном');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: publicView() показывает только общие PRO/CON аргументы, НЕ адресные и НЕ RECONCILIATION', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    prisma._seedArgument({ id: 'a1', projectId: PROJECT_ID, text: 'Общий аргумент за', stance: 'PRO', targetPersonId: null });
    prisma._seedArgument({ id: 'a2', projectId: PROJECT_ID, text: 'Адресный аргумент под стейкхолдера', stance: 'PRO', targetPersonId: 'person-1' });
    prisma._seedArgument({ id: 'a3', projectId: PROJECT_ID, text: 'Религиозный аргумент примирения', stance: 'RECONCILIATION', targetPersonId: null });
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    const view = await svc.publicView(TOKEN);
    assertEqual(view.arguments.length, 1, 'только один аргумент виден публично');
    assertEqual(view.arguments[0].text, 'Общий аргумент за', 'именно общий, не адресный и не религиозный');
  });

  test('publicView() НЕ обращается к PersonFact/FactSource ни при каких обстоятельствах', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    // Намеренно НЕ мокаем personFact/factSource в фейке — если сервис
    // попытается их запросить, тест упадёт с "personFact is undefined",
    // что само по себе доказывает: сервис их не трогает.
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());
    await svc.publicView(TOKEN); // не должно упасть
  });

  // ── Пункт 80: узкий read-only объём командного режима ──

  test('publicView() возвращает protocol=null и closingMessage=null, если ничего не сгенерировано', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    const view = await svc.publicView(TOKEN);
    assertEqual(view.protocol, null, 'честно null, не пустая строка/объект-заглушка');
    assertEqual(view.closingMessage, null, 'честно null');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: publicView() показывает протокол, если он сгенерирован', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    prisma._seedProtocol({ projectId: PROJECT_ID, summaryText: 'Стороны договорились о разделе 50/50' });
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    const view = await svc.publicView(TOKEN);
    assertEqual(view.protocol?.summaryText, 'Стороны договорились о разделе 50/50', 'текст протокола виден внешнему участнику');
  });

  test('publicView() показывает только САМЫЙ ПОСЛЕДНИЙ протокол, не всю историю', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    const older = new Date('2026-01-01');
    const newer = new Date('2026-06-01');
    prisma._seedProtocol({ projectId: PROJECT_ID, summaryText: 'Старая версия', createdAt: older });
    prisma._seedProtocol({ projectId: PROJECT_ID, summaryText: 'Новая версия', createdAt: newer });
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    const view = await svc.publicView(TOKEN);
    assertEqual(view.protocol?.summaryText, 'Новая версия', 'показана самая свежая версия, не первая созданная');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: publicView() показывает завершающее сообщение с цитатой, если оно сгенерировано', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    prisma._seedClosingMessage({
      projectId: PROJECT_ID,
      summaryText: 'Цель достигнута',
      quoteText: 'Радуйтесь с радующимися',
      quoteSourceReference: 'Рим. 12:15',
    });
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    const view = await svc.publicView(TOKEN);
    assertEqual(view.closingMessage?.summaryText, 'Цель достигнута', 'итог виден');
    assertEqual(view.closingMessage?.quoteText, 'Радуйтесь с радующимися', 'цитата видна, если была сгенерирована с согласия владельца');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: publicView() НЕ обращается к CompromiseSheet/ProjectLog/SchedulerAdvice — узкий согласованный объём, не полный доступ', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    // Намеренно НЕ мокаем compromiseSheet/conversationSignal/schedulerAdvice
    // в фейке — если сервис попытается их запросить, тест упадёт,
    // что доказывает: расширение осталось в согласованных границах.
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());
    await svc.publicView(TOKEN); // не должно упасть
  });

  test('joinAsParticipant() поддерживает анонимное участие (displayName не передан)', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    const participant = await svc.joinAsParticipant(TOKEN);
    assertEqual(participant.displayName, null, 'анонимный участник');
  });

  test('joinAsParticipant() сохраняет displayName, если передан', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    const participant = await svc.joinAsParticipant(TOKEN, 'Сосед снизу');
    assertEqual(participant.displayName, 'Сосед снизу', 'имя сохранено');
  });

  test('submitArgument() бросает BadRequestException для пустого текста', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());
    await assertThrowsAsync(() => svc.submitArgument(TOKEN, '   ', 'PRO'), BadRequestException, 'submitArgument() с пустым текстом');
  });

  test('submitArgument() бросает ForbiddenException, если participantId не относится к этому проекту', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    prisma._seedProject({ id: 'other-proj', ownerId: 'other-user', publicShareToken: 'other-token' });
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());
    const foreignParticipant = await svc.joinAsParticipant('other-token', 'Чужой участник');

    await assertThrowsAsync(
      () => svc.submitArgument(TOKEN, 'x', 'PRO', foreignParticipant.id),
      ForbiddenException,
      'submitArgument() с participantId из другого проекта',
    );
  });

  test('submitArgument() создаёт заявку со статусом PENDING, не сразу Argument', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    const submission = await svc.submitArgument(TOKEN, 'Новый аргумент от соседа', 'CON');
    assertEqual(submission.status, 'PENDING', 'заявка не принята автоматически');
    assertEqual(prisma._getArguments().length, 0, 'реальный Argument не создан до модерации');
  });

  test('vote() увеличивает соответствующий счётчик', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    prisma._seedSubmission({ projectId: PROJECT_ID, text: 'x', stance: 'PRO' });
    const [submission] = prisma._getSubmissions();
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    const upvoted = await svc.vote(TOKEN, submission.id, 'up');
    assertEqual(upvoted.upvotes, 1, 'upvotes увеличен');
    const downvoted = await svc.vote(TOKEN, submission.id, 'down');
    assertEqual(downvoted.downvotes, 1, 'downvotes увеличен отдельно');
  });

  test('addComment() создаёт комментарий, привязанный к проекту', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    await svc.addComment(TOKEN, 'Согласен с этим аргументом');
    const view = await svc.publicView(TOKEN);
    assertEqual(view.comments.length, 1, 'комментарий виден в публичном представлении');
  });

  test('listSubmissionsForModeration() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());
    await assertThrowsAsync(() => svc.listSubmissionsForModeration(USER_ID, PROJECT_ID), NotFoundException, 'listSubmissionsForModeration() на чужой проект');
  });

  test('moderate() ACCEPT создаёт реальный Argument и связывает через promotedToArgumentId', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    prisma._seedSubmission({ projectId: PROJECT_ID, text: 'Хороший аргумент от соседа', stance: 'PRO' });
    const [submission] = prisma._getSubmissions();
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    const updated = await svc.moderate(USER_ID, PROJECT_ID, submission.id, 'ACCEPT');
    assertEqual(updated.status, 'ACCEPTED', 'статус изменён');
    assertEqual(prisma._getArguments().length, 1, 'реальный Argument создан');
    assertEqual(updated.promotedToArgumentId, prisma._getArguments()[0].id, 'связь проставлена');
  });

  test('moderate() REJECT НЕ создаёт Argument', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    prisma._seedSubmission({ projectId: PROJECT_ID, text: 'Спорный аргумент', stance: 'CON' });
    const [submission] = prisma._getSubmissions();
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    const updated = await svc.moderate(USER_ID, PROJECT_ID, submission.id, 'REJECT');
    assertEqual(updated.status, 'REJECTED', 'статус изменён');
    assertEqual(prisma._getArguments().length, 0, 'Argument не создан для отклонённой заявки');
  });

  test('moderate() бросает BadRequestException при повторной модерации уже обработанной заявки', async () => {
    const prisma = createFakePrisma();
    seedProject(prisma, TOKEN);
    prisma._seedSubmission({ projectId: PROJECT_ID, text: 'x', stance: 'PRO', status: 'ACCEPTED' });
    const [submission] = prisma._getSubmissions();
    const svc = new PublicDiscussionService(prisma as any, fakeConsent());

    await assertThrowsAsync(() => svc.moderate(USER_ID, PROJECT_ID, submission.id, 'REJECT'), BadRequestException, 'moderate() на уже обработанную заявку');
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
  console.log(`\nPublicDiscussionService: ${results.length - failed.length}/${results.length} passed\n`);
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

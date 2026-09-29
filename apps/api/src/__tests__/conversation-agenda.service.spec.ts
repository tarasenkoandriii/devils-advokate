import { ConversationAgendaService } from '../conversation-agenda/conversation-agenda.service';
import { AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const objectives = new Map<string, any>();
  const conversations: any[] = [];
  const agendas: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedObjective(projectId: string, o: any) { objectives.set(projectId, o); },
    _seedConversation(c: any) { conversations.push(c); },
    _getAgendas() { return agendas; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    decisionObjective: {
      findUnique: async ({ where }: any) => objectives.get(where.projectId) ?? null,
    },
    conversation: {
      findMany: async ({ where, take }: any) => {
        const matching = conversations
          .filter((c) => c.projectId === where.projectId && where.status.in.includes(c.status))
          .sort((a, b) => b.occurredAt - a.occurredAt);
        return take ? matching.slice(0, take) : matching;
      },
      // Пункт [shown-not-all] 2026-09-05: фейк умеет count — повестка
      // считает целое, чтобы сказать модели, что видит не весь архив.
      count: async ({ where }: any) =>
        conversations.filter((c) => c.projectId === where.projectId && where.status.in.includes(c.status)).length,
    },
    promptVersion: {
      findFirst: async () => null,
    },
    conversationAgenda: {
      create: async ({ data }: any) => {
        const a = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        agendas.push(a);
        return a;
      },
      findFirst: async ({ where, orderBy }: any) => {
        const matching = agendas.filter((a) => a.projectId === where.projectId);
        if (matching.length === 0) return null;
        if (orderBy?.createdAt === 'desc') {
          return matching.reduce((latest, a) => (a.createdAt > latest.createdAt ? a : latest));
        }
        return matching[0];
      },
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
const PROJECT_ID = 'proj-1';

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('generate() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new ConversationAgendaService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.generate(USER_ID, PROJECT_ID), NotFoundException, 'generate() на чужой проект');
  });

  test('generate() работает без прошлых разговоров (только по цели)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedObjective(PROJECT_ID, { desiredOutcome: 'Договориться о графике' });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify(['Обсудить конкретные дни недели']);
    const svc = new ConversationAgendaService(prisma as any, fakeRouter as any);

    const agenda = await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(agenda.items, ['Обсудить конкретные дни недели'], 'повестка сформирована без прошлых разговоров');
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Прошлых расшифрованных разговоров пока нет'), true, 'явно указано отсутствие истории в промпте');
  });

  test('generate() подмешивает транскрипты прошлых разговоров в промпт', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedConversation({
      id: 'conv-1', projectId: PROJECT_ID, status: 'TRANSCRIBED', occurredAt: new Date(),
      transcript: { segments: [{ text: 'Обсуждали зарплату' }] },
    });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = JSON.stringify(['Вернуться к вопросу зарплаты']);
    const svc = new ConversationAgendaService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID);
    assertEqual(fakeRouter.lastRequest.userPrompt.includes('Обсуждали зарплату'), true, 'транскрипт прошлого разговора попал в промпт');
  });

  test('generate() ограничивает выборку прошлых разговоров последними 5', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    for (let i = 0; i < 8; i++) {
      prisma._seedConversation({
        id: `conv-${i}`, projectId: PROJECT_ID, status: 'TRANSCRIBED', occurredAt: new Date(Date.now() - i * 86400000),
        transcript: { segments: [{ text: `Разговор номер ${i}` }] },
      });
    }
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '[]';
    const svc = new ConversationAgendaService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID);
    const matches = (fakeRouter.lastRequest.userPrompt.match(/Разговор \d+/g) ?? []).length;
    assertEqual(matches <= 5, true, 'в промпт попало не больше 5 прошлых разговоров');
  });

  test('КЛЮЧЕВОЙ ТЕСТ [server-said-which-day]: порядок разговоров назван верно, а не наугад', async () => {
    // Дату из промпта убрали (сервер не знает календаря человека), и
    // вместо неё модель получает ПОРЯДОК. Неверно названное направление
    // хуже отсутствия даты: модель станет рассуждать «раньше — позже»
    // задом наперёд. Поэтому проверяется не наличие подписи, а
    // совпадение подписи с настоящим порядком выборки.
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedConversation({
      id: 'conv-old', projectId: PROJECT_ID, status: 'TRANSCRIBED', occurredAt: new Date('2026-01-01T10:00:00Z'),
      transcript: { segments: [{ text: 'Самый ранний разговор' }] },
    });
    prisma._seedConversation({
      id: 'conv-new', projectId: PROJECT_ID, status: 'TRANSCRIBED', occurredAt: new Date('2026-09-01T10:00:00Z'),
      transcript: { segments: [{ text: 'Самый недавний разговор' }] },
    });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.responseText = '[]';
    const svc = new ConversationAgendaService(prisma as any, fakeRouter as any);

    await svc.generate(USER_ID, PROJECT_ID);
    const prompt: string = fakeRouter.lastRequest.userPrompt;
    const first = prompt.indexOf('Самый недавний разговор');
    const second = prompt.indexOf('Самый ранний разговор');
    assertEqual(first >= 0 && second >= 0, true, 'оба разговора попали в промпт');
    assertEqual(first < second, true, 'выборка идёт от недавнего к раннему');
    // И подпись у ПЕРВОГО совпадает с этим направлением.
    const head = prompt.slice(0, first);
    assertEqual(head.includes('1 из 2, 1 — самый недавний'), true, 'направление названо так же, как отсортировано');
    assertEqual(head.includes('самый ранний'), false, 'направление не названо наоборот');
  });

  test('generate() создаёт НОВУЮ запись при повторном вызове, не мутирует старую', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const fakeRouter = new FakeAIRouterService();
    const svc = new ConversationAgendaService(prisma as any, fakeRouter as any);

    fakeRouter.responseText = JSON.stringify(['Старый пункт']);
    await svc.generate(USER_ID, PROJECT_ID);
    fakeRouter.responseText = JSON.stringify(['Новый пункт']);
    await svc.generate(USER_ID, PROJECT_ID);

    assertEqual(prisma._getAgendas().length, 2, 'обе повестки сохранены, не перезаписаны');
  });

  test('getLatest() возвращает самую свежую повестку', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const fakeRouter = new FakeAIRouterService();
    const svc = new ConversationAgendaService(prisma as any, fakeRouter as any);

    fakeRouter.responseText = JSON.stringify(['Старый пункт']);
    await svc.generate(USER_ID, PROJECT_ID);
    await new Promise((r) => setTimeout(r, 5));
    fakeRouter.responseText = JSON.stringify(['Новый пункт']);
    await svc.generate(USER_ID, PROJECT_ID);

    const latest = await svc.getLatest(USER_ID, PROJECT_ID);
    assertEqual(latest?.items, ['Новый пункт'], 'возвращена именно последняя по времени повестка');
  });

  // Пункт 32 (расширенный аудит тестов) — ветка BadGatewayException в
  // generate() не тестировалась ни разу.
  test('generate() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.execute = async () => { throw new Error('provider timeout'); };
    const svc = new ConversationAgendaService(prisma as any, fakeRouter as any);
    await assertThrowsAsync(
      () => svc.generate(USER_ID, PROJECT_ID),
      BadGatewayException,
      'generate() при недоступности провайдера',
    );
  });

  // Пойман повторным прогоном систематической проверки: первый заход
  // добавил только BadGatewayException, пропустив вторую ветку catch()
  // того же метода — BadRequestException при блокировке контента.
  test('generate() бросает BadRequestException при блокировке контента', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const fakeRouter = new FakeAIRouterService();
    fakeRouter.execute = async () => { throw new AIRouterContentBlockedError('blocked'); };
    const svc = new ConversationAgendaService(prisma as any, fakeRouter as any);
    await assertThrowsAsync(
      () => svc.generate(USER_ID, PROJECT_ID),
      BadRequestException,
      'generate() при блокировке контента',
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
  console.log(`\nConversationAgendaService: ${results.length - failed.length}/${results.length} passed\n`);
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

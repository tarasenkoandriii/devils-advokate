import { SituationalContentService } from '../situational-content/situational-content.service';
import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const users = new Map<string, any>();
  const quotes: any[] = [];
  const anecdotes: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedUser(u: any) { users.set(u.id, { alwaysShowQuote: false, alwaysShowAnecdote: false, ...u }); },
    _getQuotes() { return quotes; },
    _getAnecdotes() { return anecdotes; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
      update: async ({ where, data }: any) => {
        const u = { ...users.get(where.id), ...data };
        users.set(where.id, u);
        return { alwaysShowQuote: u.alwaysShowQuote, alwaysShowAnecdote: u.alwaysShowAnecdote };
      },
    },
    promptVersion: {
      findFirst: async () => null,
    },
    situationalQuote: {
      create: async ({ data }: any) => {
        const q = { id: nextId(), createdAt: new Date(), ...data };
        quotes.push(q);
        return q;
      },
      findMany: async ({ where }: any) => quotes.filter((q) => q.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt),
    },
    situationalAnecdote: {
      create: async ({ data }: any) => {
        const a = { id: nextId(), createdAt: new Date(), ...data };
        anecdotes.push(a);
        return a;
      },
      findMany: async ({ where }: any) => anecdotes.filter((a) => a.projectId === where.projectId).sort((a, b) => b.createdAt - a.createdAt),
    },
  };
}

class FakeAIRouterService {
  quoteResponseText = '{"quoteText":"Не суди, да не судим будешь","sourceReference":"Мф. 7:1"}';
  anecdoteResponseText = '{"text":"Забавная история про переезд"}';
  aiInferenceId = 'inference-1';
  lastRequest: any = null;

  async execute(request: any) {
    this.lastRequest = request;
    const responseText = request.taskType === 'situational-quote' ? this.quoteResponseText : this.anecdoteResponseText;
    if (request.validateOutput && !request.validateOutput(responseText)) {
      throw new Error('validation failed in fake router');
    }
    return { aiInferenceId: this.aiInferenceId, jobId: 'job-1', text: responseText };
  }
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

function seedProjectWithReligion(prisma: ReturnType<typeof createFakePrisma>, religion: string | null = 'Христианство') {
  prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID, question: 'Переезд в другой город', goal: null });
  prisma._seedUser({ id: USER_ID, religion });
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('generateQuote() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new SituationalContentService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.generateQuote(USER_ID, PROJECT_ID), NotFoundException, 'generateQuote() на чужой проект');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: generateQuote() бросает BadRequestException, если вероисповедание не указано', async () => {
    const prisma = createFakePrisma();
    seedProjectWithReligion(prisma, null);
    const svc = new SituationalContentService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.generateQuote(USER_ID, PROJECT_ID), BadRequestException, 'generateQuote() без указанного вероисповедания');
  });

  test('generateAnecdote() тоже бросает BadRequestException без указанного вероисповедания', async () => {
    const prisma = createFakePrisma();
    seedProjectWithReligion(prisma, null);
    const svc = new SituationalContentService(prisma as any, new FakeAIRouterService() as any);
    await assertThrowsAsync(() => svc.generateAnecdote(USER_ID, PROJECT_ID), BadRequestException, 'generateAnecdote() без указанного вероисповедания');
  });

  test('generateQuote() создаёт запись с раздельными quoteText и sourceReference', async () => {
    const prisma = createFakePrisma();
    seedProjectWithReligion(prisma);
    const svc = new SituationalContentService(prisma as any, new FakeAIRouterService() as any);

    const quote = await svc.generateQuote(USER_ID, PROJECT_ID);
    assertEqual(quote.quoteText, 'Не суди, да не судим будешь', 'текст цитаты сохранён');
    assertEqual(quote.sourceReference, 'Мф. 7:1', 'ссылка на источник — ОТДЕЛЬНОЕ поле, не смешана с текстом');
  });

  test('generateAnecdote() создаёт запись без какого-либо поля источника', async () => {
    const prisma = createFakePrisma();
    seedProjectWithReligion(prisma);
    const svc = new SituationalContentService(prisma as any, new FakeAIRouterService() as any);

    const anecdote = await svc.generateAnecdote(USER_ID, PROJECT_ID);
    assertEqual(anecdote.text, 'Забавная история про переезд', 'текст анекдота сохранён');
    assertEqual('sourceReference' in anecdote, false, 'у анекдота нет поля источника вообще — не факт, не аргумент');
  });

  test('generateQuote() бросает BadGatewayException при недоступности AI-провайдера', async () => {
    const prisma = createFakePrisma();
    seedProjectWithReligion(prisma);
    const failingRouter = { execute: async () => { throw new Error('provider down'); } };
    const svc = new SituationalContentService(prisma as any, failingRouter as any);
    await assertThrowsAsync(() => svc.generateQuote(USER_ID, PROJECT_ID), BadGatewayException, 'generateQuote() при недоступности провайдера');
  });

  test('listQuotes()/listAnecdotes() возвращают записи проекта', async () => {
    const prisma = createFakePrisma();
    seedProjectWithReligion(prisma);
    const svc = new SituationalContentService(prisma as any, new FakeAIRouterService() as any);
    await svc.generateQuote(USER_ID, PROJECT_ID);
    await svc.generateAnecdote(USER_ID, PROJECT_ID);

    assertEqual((await svc.listQuotes(USER_ID, PROJECT_ID)).length, 1, 'цитата видна');
    assertEqual((await svc.listAnecdotes(USER_ID, PROJECT_ID)).length, 1, 'анекдот виден');
  });

  test('updatePreferences() сохраняет alwaysShowQuote/alwaysShowAnecdote раздельно', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: USER_ID });
    const svc = new SituationalContentService(prisma as any, new FakeAIRouterService() as any);

    const updated = await svc.updatePreferences(USER_ID, { alwaysShowQuote: true });
    assertEqual(updated.alwaysShowQuote, true, 'alwaysShowQuote включён');
    assertEqual(updated.alwaysShowAnecdote, false, 'alwaysShowAnecdote не тронут, остался false');
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
  console.log(`\nSituationalContentService: ${results.length - failed.length}/${results.length} passed\n`);
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

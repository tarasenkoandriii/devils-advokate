import { OpenLoopsService } from '../open-loops/open-loops.service';
import { SourceConflictService } from '../source-conflict/source-conflict.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const missingInfoChecks: any[] = [];
  const commitments: any[] = [];
  const args: any[] = [];
  const projectPeople: any[] = [];
  const people = new Map<string, any>();
  const facts = new Map<string, any>();
  const conflicts: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedMissingInfoCheck(c: any) { missingInfoChecks.push(c); },
    _seedCommitment(c: any) { commitments.push(c); },
    _seedArgument(a: any) { args.push(a); },
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedProjectPerson(pp: any) { projectPeople.push(pp); },
    _seedFact(f: any) { facts.set(f.id, f); },
    _seedConflict(c: any) { conflicts.push(c); },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    person: {
      findFirst: async ({ where }: any) => {
        const p = people.get(where.id);
        if (!p || p.createdByUserId !== where.createdByUserId) return null;
        return p;
      },
    },
    projectPerson: {
      findMany: async ({ where }: any) => projectPeople.filter((pp) => pp.projectId === where.projectId),
    },
    missingInformationCheck: {
      findFirst: async ({ where, orderBy }: any) => {
        const matching = missingInfoChecks.filter((c) => c.projectId === where.projectId);
        if (matching.length === 0) return null;
        return matching.reduce((latest, c) => (c.createdAt > latest.createdAt ? c : latest));
      },
    },
    commitment: {
      findMany: async ({ where }: any) =>
        commitments.filter((c) => c.projectId === where.projectId && c.status === where.status),
    },
    argument: {
      findMany: async ({ where }: any) =>
        args.filter((a) => a.projectId === where.projectId && a.lifecycleStatus === where.lifecycleStatus),
    },
    sourceConflict: {
      findMany: async ({ where }: any) =>
        conflicts
          .filter((c) => where.personId.in.includes(c.personId) && c.resolvedAt === null)
          .map((c) => ({ ...c, factA: facts.get(c.factAId), factB: facts.get(c.factBId) })),
    },
  };
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('getSummary() возвращает нули для пустого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const svc = new OpenLoopsService(prisma as any, new SourceConflictService(prisma as any, {} as any));

    const summary = await svc.getSummary(USER_ID, PROJECT_ID);
    assertEqual(summary.unansweredQuestionsCount, 0, 'нет вопросов в пустом проекте');
    assertEqual(summary.openCommitmentsCount, 0, 'нет обязательств');
    assertEqual(summary.pendingDecisionsCount, 0, 'нет решений в ожидании');
    assertEqual(summary.unresolvedObjectionsCount, 0, 'нет возражений');
  });

  test('getSummary() считает openCommitments только со статусом IN_PROGRESS', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedCommitment({ id: 'c1', projectId: PROJECT_ID, status: 'IN_PROGRESS', description: 'Пришлёт документы' });
    prisma._seedCommitment({ id: 'c2', projectId: PROJECT_ID, status: 'COMPLETED', description: 'Уже выполнено' });
    const svc = new OpenLoopsService(prisma as any, new SourceConflictService(prisma as any, {} as any));

    const summary = await svc.getSummary(USER_ID, PROJECT_ID);
    assertEqual(summary.openCommitmentsCount, 1, 'COMPLETED не считается открытым обязательством');
    assertEqual(summary.details.openCommitments[0].description, 'Пришлёт документы', 'правильное обязательство в details');
  });

  test('getSummary() считает pendingDecisions по lifecycleStatus=USED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({ id: 'a1', projectId: PROJECT_ID, lifecycleStatus: 'USED', text: 'Аргумент в ожидании исхода' });
    prisma._seedArgument({ id: 'a2', projectId: PROJECT_ID, lifecycleStatus: 'ACCEPTED', text: 'Уже принят' });
    const svc = new OpenLoopsService(prisma as any, new SourceConflictService(prisma as any, {} as any));

    const summary = await svc.getSummary(USER_ID, PROJECT_ID);
    assertEqual(summary.pendingDecisionsCount, 1, 'только USED считается решением в ожидании');
  });

  test('getSummary() считает unresolvedObjections по lifecycleStatus=COUNTERED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({ id: 'a1', projectId: PROJECT_ID, lifecycleStatus: 'COUNTERED', text: 'Опровергнутый аргумент' });
    prisma._seedArgument({ id: 'a2', projectId: PROJECT_ID, lifecycleStatus: 'REJECTED', text: 'Просто отвергнут, не опровергнут' });
    const svc = new OpenLoopsService(prisma as any, new SourceConflictService(prisma as any, {} as any));

    const summary = await svc.getSummary(USER_ID, PROJECT_ID);
    assertEqual(summary.unresolvedObjectionsCount, 1, 'только COUNTERED считается неразрешённым возражением, не REJECTED');
  });

  test('getSummary() складывает вопросы из MissingInformationCheck и SourceConflict вместе', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedMissingInfoCheck({ id: 'mic1', projectId: PROJECT_ID, questions: ['Кто принимает решение?', 'Что если откажут?'], createdAt: new Date() });
    prisma._seedPerson({ id: 'person-1', createdByUserId: USER_ID });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: 'person-1' });
    prisma._seedFact({ id: 'fact-1', personId: 'person-1', content: 'x' });
    prisma._seedFact({ id: 'fact-2', personId: 'person-1', content: 'y' });
    prisma._seedConflict({ id: 'sc1', personId: 'person-1', factAId: 'fact-1', factBId: 'fact-2', resolvedAt: null, clarifyingQuestion: 'Актуален ли этот факт сейчас?' });
    const svc = new OpenLoopsService(prisma as any, new SourceConflictService(prisma as any, {} as any));

    const summary = await svc.getSummary(USER_ID, PROJECT_ID);
    assertEqual(summary.unansweredQuestionsCount, 3, '2 вопроса из MissingInformationCheck + 1 из SourceConflict = 3');
    assertEqual(summary.details.missingInformationQuestions.length, 2, 'вопросы MissingInformationCheck в details');
    assertEqual(summary.details.unresolvedConflictQuestions, ['Актуален ли этот факт сейчас?'], 'вопрос SourceConflict в details');
  });

  test('getSummary() не считает РАЗРЕШЁННЫЕ SourceConflict как незакрытые вопросы', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedPerson({ id: 'person-1', createdByUserId: USER_ID });
    prisma._seedProjectPerson({ projectId: PROJECT_ID, personId: 'person-1' });
    prisma._seedFact({ id: 'fact-1', personId: 'person-1', content: 'x' });
    prisma._seedFact({ id: 'fact-2', personId: 'person-1', content: 'y' });
    prisma._seedConflict({ id: 'sc1', personId: 'person-1', factAId: 'fact-1', factBId: 'fact-2', resolvedAt: new Date(), clarifyingQuestion: 'Уже разобрано' });
    const svc = new OpenLoopsService(prisma as any, new SourceConflictService(prisma as any, {} as any));

    const summary = await svc.getSummary(USER_ID, PROJECT_ID);
    assertEqual(summary.unansweredQuestionsCount, 0, 'разрешённый конфликт не считается незакрытым вопросом');
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
  console.log(`\nOpenLoopsService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

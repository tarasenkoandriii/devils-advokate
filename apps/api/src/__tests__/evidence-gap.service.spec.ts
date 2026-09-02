import { EvidenceGapService } from '../evidence-gap/evidence-gap.service';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const args: any[] = [];

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedArgument(a: any) { args.push(a); },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    argument: {
      findMany: async ({ where }: any) => args.filter((a) => a.projectId === where.projectId),
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

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('PUBLIC_FACT, не оспорен, не устарел → KNOWN', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({
      id: 'a1', projectId: PROJECT_ID, text: 'x', stance: 'PRO',
      derivedFromPersonFact: { status: 'ACTIVE', sourceType: 'PUBLIC_FACT', lastVerifiedAt: daysAgo(10), createdAt: daysAgo(10) },
      derivedFromInference: null,
    });
    const svc = new EvidenceGapService(prisma as any);
    const report = await svc.analyze(USER_ID, PROJECT_ID);
    assertEqual(report.breakdown.KNOWN.length, 1, 'PUBLIC_FACT свежий → KNOWN');
  });

  test('PERSONAL_RECORD → SUPPORTED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({
      id: 'a1', projectId: PROJECT_ID, text: 'x', stance: 'CON',
      derivedFromPersonFact: { status: 'ACTIVE', sourceType: 'PERSONAL_RECORD', lastVerifiedAt: daysAgo(5), createdAt: daysAgo(5) },
      derivedFromInference: null,
    });
    const svc = new EvidenceGapService(prisma as any);
    const report = await svc.analyze(USER_ID, PROJECT_ID);
    assertEqual(report.breakdown.SUPPORTED.length, 1, 'PERSONAL_RECORD → SUPPORTED');
  });

  test('USER_GUESS → ASSUMED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({
      id: 'a1', projectId: PROJECT_ID, text: 'x', stance: 'PRO',
      derivedFromPersonFact: { status: 'ACTIVE', sourceType: 'USER_GUESS', lastVerifiedAt: daysAgo(1), createdAt: daysAgo(1) },
      derivedFromInference: null,
    });
    const svc = new EvidenceGapService(prisma as any);
    const report = await svc.analyze(USER_ID, PROJECT_ID);
    assertEqual(report.breakdown.ASSUMED.length, 1, 'USER_GUESS → ASSUMED');
  });

  test('AIInference без userVerified → ASSUMED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({
      id: 'a1', projectId: PROJECT_ID, text: 'x', stance: 'PRO',
      derivedFromPersonFact: null,
      derivedFromInference: { userVerified: false, userDisputed: false },
    });
    const svc = new EvidenceGapService(prisma as any);
    const report = await svc.analyze(USER_ID, PROJECT_ID);
    assertEqual(report.breakdown.ASSUMED.length, 1, 'AI-догадка без подтверждения → ASSUMED');
  });

  test('AIInference с userVerified=true → SUPPORTED', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({
      id: 'a1', projectId: PROJECT_ID, text: 'x', stance: 'PRO',
      derivedFromPersonFact: null,
      derivedFromInference: { userVerified: true, userDisputed: false },
    });
    const svc = new EvidenceGapService(prisma as any);
    const report = await svc.analyze(USER_ID, PROJECT_ID);
    assertEqual(report.breakdown.SUPPORTED.length, 1, 'AI-догадка, подтверждённая пользователем → SUPPORTED');
  });

  test('AIInference с userDisputed=true → CONTRADICTORY', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({
      id: 'a1', projectId: PROJECT_ID, text: 'x', stance: 'PRO',
      derivedFromPersonFact: null,
      derivedFromInference: { userVerified: false, userDisputed: true },
    });
    const svc = new EvidenceGapService(prisma as any);
    const report = await svc.analyze(USER_ID, PROJECT_ID);
    assertEqual(report.breakdown.CONTRADICTORY.length, 1, 'оспоренная AI-догадка → CONTRADICTORY');
  });

  test('PersonFact.status=DISPUTED → CONTRADICTORY (даже если PUBLIC_FACT)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({
      id: 'a1', projectId: PROJECT_ID, text: 'x', stance: 'PRO',
      derivedFromPersonFact: { status: 'DISPUTED', sourceType: 'PUBLIC_FACT', lastVerifiedAt: daysAgo(1), createdAt: daysAgo(1) },
      derivedFromInference: null,
    });
    const svc = new EvidenceGapService(prisma as any);
    const report = await svc.analyze(USER_ID, PROJECT_ID);
    assertEqual(report.breakdown.CONTRADICTORY.length, 1, 'DISPUTED перевешивает даже PUBLIC_FACT');
    assertEqual(report.breakdown.KNOWN.length, 0, 'DISPUTED PUBLIC_FACT не попадает в KNOWN');
  });

  test('PersonFact.status=EXPIRED → STALE', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({
      id: 'a1', projectId: PROJECT_ID, text: 'x', stance: 'PRO',
      derivedFromPersonFact: { status: 'EXPIRED', sourceType: 'PUBLIC_FACT', lastVerifiedAt: daysAgo(1), createdAt: daysAgo(1) },
      derivedFromInference: null,
    });
    const svc = new EvidenceGapService(prisma as any);
    const report = await svc.analyze(USER_ID, PROJECT_ID);
    assertEqual(report.breakdown.STALE.length, 1, 'EXPIRED → STALE');
  });

  test('PersonFact.lastVerifiedAt старше 365 дней → STALE (порог из §3.57)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({
      id: 'a1', projectId: PROJECT_ID, text: 'x', stance: 'PRO',
      derivedFromPersonFact: { status: 'ACTIVE', sourceType: 'PUBLIC_FACT', lastVerifiedAt: daysAgo(400), createdAt: daysAgo(400) },
      derivedFromInference: null,
    });
    const svc = new EvidenceGapService(prisma as any);
    const report = await svc.analyze(USER_ID, PROJECT_ID);
    assertEqual(report.breakdown.STALE.length, 1, 'верифицирован 400 дней назад → STALE');
    assertEqual(report.breakdown.KNOWN.length, 0, 'не попадает в KNOWN несмотря на PUBLIC_FACT');
  });

  test('PersonFact.lastVerifiedAt свежее 365 дней → НЕ STALE', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({
      id: 'a1', projectId: PROJECT_ID, text: 'x', stance: 'PRO',
      derivedFromPersonFact: { status: 'ACTIVE', sourceType: 'PUBLIC_FACT', lastVerifiedAt: daysAgo(300), createdAt: daysAgo(300) },
      derivedFromInference: null,
    });
    const svc = new EvidenceGapService(prisma as any);
    const report = await svc.analyze(USER_ID, PROJECT_ID);
    assertEqual(report.breakdown.STALE.length, 0, 'верифицирован 300 дней назад — ещё не устарело');
    assertEqual(report.breakdown.KNOWN.length, 1, 'остаётся в KNOWN');
  });

  test('Ни факта, ни AI-вывода → UNKNOWN', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({
      id: 'a1', projectId: PROJECT_ID, text: 'x', stance: 'PRO',
      derivedFromPersonFact: null,
      derivedFromInference: null,
    });
    const svc = new EvidenceGapService(prisma as any);
    const report = await svc.analyze(USER_ID, PROJECT_ID);
    assertEqual(report.breakdown.UNKNOWN.length, 1, 'голословный аргумент → UNKNOWN');
  });

  test('promptToUser — фиксированный текст, присутствует всегда', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const svc = new EvidenceGapService(prisma as any);
    const report = await svc.analyze(USER_ID, PROJECT_ID);
    assertEqual(report.promptToUser, 'Какие ключевые предположения пока не подтверждены?', 'фиксированный вопрос присутствует');
  });

  test('Смешанный проект — все категории считаются раздельно, не путаются', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({ id: 'a1', projectId: PROJECT_ID, text: '1', stance: 'PRO', derivedFromPersonFact: { status: 'ACTIVE', sourceType: 'PUBLIC_FACT', lastVerifiedAt: daysAgo(1), createdAt: daysAgo(1) }, derivedFromInference: null });
    prisma._seedArgument({ id: 'a2', projectId: PROJECT_ID, text: '2', stance: 'CON', derivedFromPersonFact: null, derivedFromInference: null });
    prisma._seedArgument({ id: 'a3', projectId: PROJECT_ID, text: '3', stance: 'PRO', derivedFromPersonFact: null, derivedFromInference: { userVerified: false, userDisputed: true } });
    const svc = new EvidenceGapService(prisma as any);
    const report = await svc.analyze(USER_ID, PROJECT_ID);
    assertEqual(report.breakdown.KNOWN.length, 1, 'смешанный проект: KNOWN=1');
    assertEqual(report.breakdown.UNKNOWN.length, 1, 'смешанный проект: UNKNOWN=1');
    assertEqual(report.breakdown.CONTRADICTORY.length, 1, 'смешанный проект: CONTRADICTORY=1');
    assertEqual(report.breakdown.ASSUMED.length, 0, 'смешанный проект: ASSUMED=0');
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
  console.log(`\nEvidenceGapService: ${results.length - failed.length}/${results.length} passed\n`);
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

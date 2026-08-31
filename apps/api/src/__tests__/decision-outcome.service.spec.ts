import { DecisionOutcomeService } from '../decision-outcome/decision-outcome.service';
import { NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const argumentsStore: any[] = [];
  const outcomes: any[] = [];
  const escalationEvents: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedArgument(a: any) { argumentsStore.push(a); },
    _seedOutcome(o: any) { outcomes.push({ recordedAt: new Date(), ...o }); },
    _getOutcomes() { return outcomes; },
    _seedEscalationEvent(e: any) { escalationEvents.push({ id: nextId(), createdAt: new Date(), ...e }); },
    _getEscalationEvents() { return escalationEvents; },

    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    argument: {
      findMany: async ({ where }: any) =>
        argumentsStore.filter(
          (a) =>
            a.projectId === where.projectId &&
            (where.targetPersonId === undefined ? true : a.targetPersonId === null) &&
            where.stance.in.includes(a.stance),
        ),
    },
    decisionOutcome: {
      upsert: async ({ where, create, update }: any) => {
        const idx = outcomes.findIndex((o) => o.projectId === where.projectId);
        if (idx >= 0) {
          outcomes[idx] = { ...outcomes[idx], ...update };
          return outcomes[idx];
        }
        const created = { recordedAt: new Date(), ...create };
        outcomes.push(created);
        return created;
      },
      findUnique: async ({ where }: any) => outcomes.find((o) => o.projectId === where.projectId) ?? null,
      findMany: async ({ where }: any) => {
        let result = outcomes.filter((o) => projects.get(o.projectId)?.ownerId === where.project.ownerId);
        if (where.actualOutcome !== undefined) result = result.filter((o) => o.actualOutcome === where.actualOutcome);
        return result;
      },
    },
    escalationCategoryEvent: {
      create: async ({ data }: any) => {
        const e = { id: nextId(), createdAt: new Date(), ...data };
        escalationEvents.push(e);
        return e;
      },
      findMany: async ({ where }: any) => {
        let result = escalationEvents.filter((e) => projects.get(e.projectId)?.ownerId === where.project.ownerId);
        if (where.createdAt?.gte) result = result.filter((e) => e.createdAt >= where.createdAt.gte);
        return [...result].sort((a, b) => a.createdAt - b.createdAt);
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

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('recordOutcome() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new DecisionOutcomeService(prisma as any);
    await assertThrowsAsync(
      () => svc.recordOutcome(USER_ID, PROJECT_ID, { actualOutcome: 'WENT_WELL' as any }),
      NotFoundException,
      'recordOutcome() на чужой проект',
    );
  });

  test('recordOutcome() вычисляет predictedLean как сумму PRO минус сумму CON', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({ projectId: PROJECT_ID, stance: 'PRO', weight: 0.8, targetPersonId: null });
    prisma._seedArgument({ projectId: PROJECT_ID, stance: 'CON', weight: 0.3, targetPersonId: null });
    const svc = new DecisionOutcomeService(prisma as any);

    const result = await svc.recordOutcome(USER_ID, PROJECT_ID, { actualOutcome: 'WENT_WELL' as any });
    assertEqual(Math.round(result.predictedLean! * 100) / 100, 0.5, 'predictedLean = 0.8 - 0.3 = 0.5');
  });

  test('recordOutcome() исключает адресные (targetPersonId!=null) аргументы из подсчёта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({ projectId: PROJECT_ID, stance: 'PRO', weight: 0.9, targetPersonId: null });
    prisma._seedArgument({ projectId: PROJECT_ID, stance: 'PRO', weight: 0.9, targetPersonId: 'person-1' });
    const svc = new DecisionOutcomeService(prisma as any);

    const result = await svc.recordOutcome(USER_ID, PROJECT_ID, { actualOutcome: 'WENT_WELL' as any });
    assertEqual(result.predictedLean, 0.9, 'адресный аргумент не учтён — только общий 0.9, не 1.8');
  });

  test('recordOutcome() исключает RECONCILIATION-аргументы из подсчёта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({ projectId: PROJECT_ID, stance: 'PRO', weight: 0.5, targetPersonId: null });
    prisma._seedArgument({ projectId: PROJECT_ID, stance: 'RECONCILIATION', weight: 0.7, targetPersonId: null });
    const svc = new DecisionOutcomeService(prisma as any);

    const result = await svc.recordOutcome(USER_ID, PROJECT_ID, { actualOutcome: 'WENT_WELL' as any });
    assertEqual(result.predictedLean, 0.5, 'RECONCILIATION не участвует в подсчёте лина решения');
  });

  test('recordOutcome() возвращает predictedLean=null, если ни один аргумент не взвешен', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    prisma._seedArgument({ projectId: PROJECT_ID, stance: 'PRO', weight: null, targetPersonId: null });
    const svc = new DecisionOutcomeService(prisma as any);

    const result = await svc.recordOutcome(USER_ID, PROJECT_ID, { actualOutcome: 'TOO_EARLY_TO_TELL' as any });
    assertEqual(result.predictedLean, null, 'нечего сравнивать без взвешенных аргументов');
  });

  test('recordOutcome() повторный вызов обновляет запись, не дублирует (upsert по @@unique projectId)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const svc = new DecisionOutcomeService(prisma as any);

    await svc.recordOutcome(USER_ID, PROJECT_ID, { actualOutcome: 'MIXED' as any });
    await svc.recordOutcome(USER_ID, PROJECT_ID, { actualOutcome: 'WENT_WELL' as any });
    assertEqual(prisma._getOutcomes().length, 1, 'ровно одна запись после двух вызовов');
    assertEqual(prisma._getOutcomes()[0].actualOutcome, 'WENT_WELL', 'вторая запись перезаписала первую');
  });

  test('getOutcome() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const svc = new DecisionOutcomeService(prisma as any);
    await assertThrowsAsync(() => svc.getOutcome(USER_ID, PROJECT_ID), NotFoundException, 'getOutcome() на чужой проект');
  });

  test('getCalibrationSummary() возвращает нули без накопленных исходов', async () => {
    const prisma = createFakePrisma();
    const svc = new DecisionOutcomeService(prisma as any);
    const summary = await svc.getCalibrationSummary(USER_ID);
    assertEqual(summary.totalRecorded, 0, 'ничего не накоплено');
    assertEqual(summary.overall.matchRate, 0, 'нет данных — 0, не деление на ноль/NaN');
  });

  test('getCalibrationSummary() корректно считает совпадения и два направления расхождения', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'p1', ownerId: USER_ID });
    prisma._seedProject({ id: 'p2', ownerId: USER_ID });
    prisma._seedProject({ id: 'p3', ownerId: USER_ID });
    // p1: predictedLean>0, WENT_WELL — совпадение
    prisma._seedOutcome({ projectId: 'p1', predictedLean: 0.5, actualOutcome: 'WENT_WELL' });
    // p2: predictedLean>0, WENT_POORLY — риск недооценён (overOptimistic)
    prisma._seedOutcome({ projectId: 'p2', predictedLean: 0.3, actualOutcome: 'WENT_POORLY' });
    // p3: predictedLean<0, WENT_WELL — риск переоценён (overCautious)
    prisma._seedOutcome({ projectId: 'p3', predictedLean: -0.4, actualOutcome: 'WENT_WELL' });
    const svc = new DecisionOutcomeService(prisma as any);

    const summary = await svc.getCalibrationSummary(USER_ID);
    assertEqual(summary.overall.matchCount, 1, 'одно совпадение');
    assertEqual(summary.overall.overOptimisticCount, 1, 'один случай недооценки риска');
    assertEqual(summary.overall.overCautiousCount, 1, 'один случай переоценки риска');
    assertEqual(summary.overall.matchRate, 1 / 3, 'доля совпадений — 1 из 3 классифицируемых');
  });

  test('getCalibrationSummary() исключает MIXED/TOO_EARLY_TO_TELL из классифицируемых', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'p1', ownerId: USER_ID });
    prisma._seedOutcome({ projectId: 'p1', predictedLean: 0.5, actualOutcome: 'MIXED' });
    const svc = new DecisionOutcomeService(prisma as any);

    const summary = await svc.getCalibrationSummary(USER_ID);
    assertEqual(summary.overall.matchCount + summary.overall.overOptimisticCount + summary.overall.overCautiousCount, 0, 'MIXED не классифицируется ни туда, ни туда');
  });

  test('getCalibrationSummary() не показывает категорию с числом случаев ниже порога', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'p1', ownerId: USER_ID });
    prisma._seedProject({ id: 'p2', ownerId: USER_ID });
    prisma._seedOutcome({ projectId: 'p1', predictedLean: 0.5, actualOutcome: 'WENT_WELL', category: 'карьера' });
    prisma._seedOutcome({ projectId: 'p2', predictedLean: 0.5, actualOutcome: 'WENT_WELL', category: 'карьера' });
    const svc = new DecisionOutcomeService(prisma as any);

    const summary = await svc.getCalibrationSummary(USER_ID);
    assertEqual(summary.byCategory.length, 0, 'два случая ниже порога (3) — категория не показана');
  });

  test('getCalibrationSummary() показывает категорию при достижении порога', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'p1', ownerId: USER_ID });
    prisma._seedProject({ id: 'p2', ownerId: USER_ID });
    prisma._seedProject({ id: 'p3', ownerId: USER_ID });
    prisma._seedOutcome({ projectId: 'p1', predictedLean: 0.5, actualOutcome: 'WENT_POORLY', category: 'карьера' });
    prisma._seedOutcome({ projectId: 'p2', predictedLean: 0.5, actualOutcome: 'WENT_POORLY', category: 'карьера' });
    prisma._seedOutcome({ projectId: 'p3', predictedLean: 0.5, actualOutcome: 'WENT_POORLY', category: 'карьера' });
    const svc = new DecisionOutcomeService(prisma as any);

    const summary = await svc.getCalibrationSummary(USER_ID);
    assertEqual(summary.byCategory.length, 1, 'три случая — порог достигнут, категория показана');
    assertEqual(summary.byCategory[0].category, 'карьера', 'категория корректная');
    assertEqual(summary.byCategory[0].overOptimisticCount, 3, 'все три — недооценка риска в этой категории');
  });

  // ── Пункт 73: Success Stats (§3.34 ТЗ, одна метрика) ──

  test('getSuccessStats() возвращает нули без накопленных исходов', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const svc = new DecisionOutcomeService(prisma as any);

    const stats = await svc.getSuccessStats(USER_ID);
    assertEqual(
      stats,
      {
        positiveOutcomesToday: 0,
        positiveOutcomesLast3Days: 0,
        positiveOutcomesLastWeek: 0,
        conflictsSmoothedToday: 0,
        conflictsSmoothedLast3Days: 0,
        conflictsSmoothedLastWeek: 0,
      },
      'нули без данных — обе метрики',
    );
  });

  test('КЛЮЧЕВОЙ ТЕСТ: getSuccessStats() считает только WENT_WELL, игнорирует WENT_POORLY/MIXED/TOO_EARLY_TO_TELL', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-good', ownerId: USER_ID });
    prisma._seedProject({ id: 'proj-bad', ownerId: USER_ID });
    prisma._seedProject({ id: 'proj-mixed', ownerId: USER_ID });
    prisma._seedOutcome({ projectId: 'proj-good', actualOutcome: 'WENT_WELL', predictedLean: null });
    prisma._seedOutcome({ projectId: 'proj-bad', actualOutcome: 'WENT_POORLY', predictedLean: null });
    prisma._seedOutcome({ projectId: 'proj-mixed', actualOutcome: 'MIXED', predictedLean: null });
    const svc = new DecisionOutcomeService(prisma as any);

    const stats = await svc.getSuccessStats(USER_ID);
    assertEqual(stats.positiveOutcomesToday, 1, 'только один WENT_WELL учтён, остальные исходы честно не входят в "успешность"');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: getSuccessStats() использует скользящие окна, не календарные — старая запись не попадает в "сегодня"/"3 дня", но входит в "неделю"', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    prisma._seedOutcome({ projectId: PROJECT_ID, actualOutcome: 'WENT_WELL', predictedLean: null, recordedAt: fiveDaysAgo });
    const svc = new DecisionOutcomeService(prisma as any);

    const stats = await svc.getSuccessStats(USER_ID);
    assertEqual(stats.positiveOutcomesToday, 0, 'запись 5 дней назад не входит в скользящее окно "сегодня" (последние 24ч)');
    assertEqual(stats.positiveOutcomesLast3Days, 0, 'и не входит в скользящее окно "3 дня"');
    assertEqual(stats.positiveOutcomesLastWeek, 1, 'но входит в скользящее окно "неделя" (последние 7 дней)');
  });

  test('getSuccessStats() агрегирует по ВСЕМ проектам пользователя разом, не по одному', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-a', ownerId: USER_ID });
    prisma._seedProject({ id: 'proj-b', ownerId: USER_ID });
    prisma._seedOutcome({ projectId: 'proj-a', actualOutcome: 'WENT_WELL', predictedLean: null });
    prisma._seedOutcome({ projectId: 'proj-b', actualOutcome: 'WENT_WELL', predictedLean: null });
    const svc = new DecisionOutcomeService(prisma as any);

    const stats = await svc.getSuccessStats(USER_ID);
    assertEqual(stats.positiveOutcomesToday, 2, 'оба проекта пользователя учтены в сумме');
  });

  test('getSuccessStats() не учитывает исходы чужих проектов', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    prisma._seedOutcome({ projectId: PROJECT_ID, actualOutcome: 'WENT_WELL', predictedLean: null });
    const svc = new DecisionOutcomeService(prisma as any);

    const stats = await svc.getSuccessStats(USER_ID);
    assertEqual(stats.positiveOutcomesToday, 0, 'чужой проект не учтён');
  });

  // ── Пункт 85: вторая метрика — настоящий след накала (§3.34 ТЗ) ──

  test('КЛЮЧЕВОЙ ТЕСТ: getSuccessStats() засчитывает сессию как сглаженную, если категория пошла вниз после пика', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-x', ownerId: USER_ID });
    const base = new Date();
    prisma._seedEscalationEvent({ projectId: 'proj-x', sessionId: 'sess-1', category: 'CALM', createdAt: new Date(base.getTime() - 3000) });
    prisma._seedEscalationEvent({ projectId: 'proj-x', sessionId: 'sess-1', category: 'HIGH', createdAt: new Date(base.getTime() - 2000) });
    prisma._seedEscalationEvent({ projectId: 'proj-x', sessionId: 'sess-1', category: 'CRITICAL', createdAt: new Date(base.getTime() - 1000) }); // пик
    prisma._seedEscalationEvent({ projectId: 'proj-x', sessionId: 'sess-1', category: 'RISING', createdAt: base }); // спад после пика
    const svc = new DecisionOutcomeService(prisma as any);

    const stats = await svc.getSuccessStats(USER_ID);
    assertEqual(stats.conflictsSmoothedToday, 1, 'сессия с реальным спадом после пика засчитана как сглаженная');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: getSuccessStats() НЕ засчитывает сессию, если разговор оборвался на пике', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-x', ownerId: USER_ID });
    const base = new Date();
    prisma._seedEscalationEvent({ projectId: 'proj-x', sessionId: 'sess-1', category: 'CALM', createdAt: new Date(base.getTime() - 2000) });
    prisma._seedEscalationEvent({ projectId: 'proj-x', sessionId: 'sess-1', category: 'HIGH', createdAt: new Date(base.getTime() - 1000) });
    prisma._seedEscalationEvent({ projectId: 'proj-x', sessionId: 'sess-1', category: 'CRITICAL', createdAt: base }); // сессия закончилась НА пике
    const svc = new DecisionOutcomeService(prisma as any);

    const stats = await svc.getSuccessStats(USER_ID);
    assertEqual(stats.conflictsSmoothedToday, 0, '"разговор оборвался на пике" — buкально НЕ засчитывается, ТЗ явно это разделяет');
  });

  test('getSuccessStats() НЕ засчитывает сессию, которая ни разу не поднималась выше CALM', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-x', ownerId: USER_ID });
    const base = new Date();
    prisma._seedEscalationEvent({ projectId: 'proj-x', sessionId: 'sess-1', category: 'CALM', createdAt: new Date(base.getTime() - 1000) });
    prisma._seedEscalationEvent({ projectId: 'proj-x', sessionId: 'sess-1', category: 'CALM', createdAt: base });
    const svc = new DecisionOutcomeService(prisma as any);

    const stats = await svc.getSuccessStats(USER_ID);
    assertEqual(stats.conflictsSmoothedToday, 0, 'без реального пика — "сглаживать" было нечего, честный 0, не ложное срабатывание');
  });

  test('getSuccessStats() учитывает несколько независимых сессий раздельно', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-x', ownerId: USER_ID });
    const base = new Date();
    // Сессия 1 — сглажена.
    prisma._seedEscalationEvent({ projectId: 'proj-x', sessionId: 'sess-1', category: 'CRITICAL', createdAt: new Date(base.getTime() - 2000) });
    prisma._seedEscalationEvent({ projectId: 'proj-x', sessionId: 'sess-1', category: 'CALM', createdAt: new Date(base.getTime() - 1000) });
    // Сессия 2 — оборвана на пике.
    prisma._seedEscalationEvent({ projectId: 'proj-x', sessionId: 'sess-2', category: 'HIGH', createdAt: base });
    const svc = new DecisionOutcomeService(prisma as any);

    const stats = await svc.getSuccessStats(USER_ID);
    assertEqual(stats.conflictsSmoothedToday, 1, 'ровно одна из двух сессий засчитана — сессии не смешиваются между собой');
  });

  test('getSuccessStats() использует скользящие окна для второй метрики — старая сессия не попадает в "сегодня"', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-x', ownerId: USER_ID });
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    prisma._seedEscalationEvent({ projectId: 'proj-x', sessionId: 'sess-old', category: 'CRITICAL', createdAt: new Date(fiveDaysAgo.getTime() - 1000) });
    prisma._seedEscalationEvent({ projectId: 'proj-x', sessionId: 'sess-old', category: 'CALM', createdAt: fiveDaysAgo });
    const svc = new DecisionOutcomeService(prisma as any);

    const stats = await svc.getSuccessStats(USER_ID);
    assertEqual(stats.conflictsSmoothedToday, 0, 'старая сессия не в "сегодня"');
    assertEqual(stats.conflictsSmoothedLastWeek, 1, 'но входит в "неделю" — то же окно, что первая метрика');
  });

  test('logEscalationCategory() бросает NotFoundException для чужого проекта', async () => {
    const { NotFoundException } = await import('@nestjs/common');
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-x', ownerId: 'other-user' });
    const svc = new DecisionOutcomeService(prisma as any);
    await assertThrowsAsync(() => svc.logEscalationCategory(USER_ID, 'proj-x', 'sess-1', 'HIGH' as any), NotFoundException, 'logEscalationCategory() на чужой проект');
  });

  test('logEscalationCategory() создаёт запись с корректными полями', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: 'proj-x', ownerId: USER_ID });
    const svc = new DecisionOutcomeService(prisma as any);

    await svc.logEscalationCategory(USER_ID, 'proj-x', 'sess-1', 'CRITICAL' as any);
    assertEqual(prisma._getEscalationEvents().length, 1, 'событие создано');
    assertEqual(prisma._getEscalationEvents()[0].category, 'CRITICAL', 'категория сохранена как есть');
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
  console.log(`\nDecisionOutcomeService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

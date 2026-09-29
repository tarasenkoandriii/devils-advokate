// Фаза F ТЗ domain-ui-and-voice-intake — операторский обзор доменов.
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminDomainsService, OPERATOR_VIEWED_PROJECT } from '../admin-domains/admin-domains.service';

function createFakePrisma() {
  const users = new Map<string, any>([['op', { isOperator: true }], ['u1', { isOperator: false }]]);
  const projects: any[] = [];
  const sessions: any[] = [];
  const queues: any[] = [];
  const matches = (p: any, where: any) => {
    if (where.mode && p.mode !== where.mode) return false;
    if (where.createdAt?.gte && p.createdAt < where.createdAt.gte) return false;
    for (const rel of ['dtpConfig', 'healthConfig', 'familyLawConfig', 'interviewPoolConfig', 'investmentConfig', 'majorPurchaseConfig']) {
      if (where[rel]?.isNot === null && !p[rel]) return false;
      if (where[rel] && 'is' in where[rel] && where[rel].is === null && p[rel]) return false;
    }
    if (where.id && p.id !== where.id) return false;
    return true;
  };
  return {
    _projects: projects, _sessions: sessions, _queues: queues,
    user: { findUnique: async ({ where }: any) => users.get(where.id) ?? null },
    project: {
      count: async ({ where }: any) => projects.filter((p) => matches(p, where)).length,
      findMany: async ({ where, take, skip, select }: any) =>
        projects.filter((p) => matches(p, where)).slice(skip, skip + take).map((p) => project(p, select)),
      findFirst: async ({ where, select }: any) => {
        const row = projects.find((p) => matches(p, where));
        return row ? project(row, select) : null;
      },
    },
    intakeSession: { findMany: async () => sessions },
    mediaReviewQueue: { findMany: async () => queues, count: async () => queues.length },
    mediaReviewQueueItem: {
      groupBy: async () => {
        const counts = new Map<string, number>();
        for (const q of queues) for (const it of q.items) counts.set(it.status, (counts.get(it.status) ?? 0) + 1);
        return [...counts.entries()].map(([status, n]) => ({ status, _count: { _all: n } }));
      },
      findMany: async ({ where }: any) =>
        queues.flatMap((q: any) => q.items.filter((it: any) => it.status === where.status)),
    },
  };
}


/** Пункт [operator-read-the-question] 2026-09-25: заглушка обязана
 * УВАЖАТЬ `select`. Без этого она отдаёт больше, чем production, и
 * проверка «список не отдаёт слова человека» ничего не проверяет:
 * падает она от щедрости заглушки, а пройти может при любом select в
 * коде. Проекция мелкая — ровно то, чем пользуется сервис. */
function project(row: any, select: any): any {
  if (!select) return row;
  const out: any = {};
  for (const [key, value] of Object.entries(select)) {
    if (value === true) out[key] = row[key];
    else if (value && typeof value === 'object' && 'select' in (value as any)) {
      const nested = (row as any)[key];
      out[key] = nested ? project(nested, (value as any).select) : (nested ?? null);
    } else if (value && typeof value === 'object') {
      out[key] = (row as any)[key] ?? null;
    }
  }
  return out;
}

function fakeAudit() { const records: any[] = []; return { records, record: async (r: any) => { records.push(r); } }; }

const day = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000);

describe('AdminDomainsService (фаза F)', () => {
  it('не оператор — ForbiddenException на всех методах', async () => {
    const svc = new AdminDomainsService(createFakePrisma() as any, fakeAudit() as any);
    await expect(svc.summary('u1')).rejects.toThrow(ForbiddenException);
    await expect(svc.intakeSummary('u1')).rejects.toThrow(ForbiddenException);
    await expect(svc.mediaReviewQueues('u1')).rejects.toThrow(ForbiddenException);
  });

  it('summary: воронка по доменам — окна 7/30 дней и доля с конфигом', async () => {
    const prisma = createFakePrisma();
    prisma._projects.push(
      { id: 'a', mode: 'DTP', createdAt: day(1), dtpConfig: { id: 'c' } },
      { id: 'b', mode: 'DTP', createdAt: day(10), dtpConfig: null },
      { id: 'c', mode: 'DTP', createdAt: day(40), dtpConfig: null },
      { id: 'd', mode: 'HEALTH', createdAt: day(2), healthConfig: null },
    );
    const rows = await new AdminDomainsService(prisma as any, fakeAudit() as any).summary('op');
    const dtp = rows.find((r) => r.domain === 'dtp')!;
    expect(dtp).toMatchObject({ total: 3, last7: 1, last30: 2, withConfig: 1, configRate: 0.33 });
    expect(rows.find((r) => r.domain === 'investment')!.configRate).toBeNull();
  });

  it('listProjects: фильтр withConfig=false показывает застрявших в онбординге; неизвестный домен — NotFound', async () => {
    const prisma = createFakePrisma();
    prisma._projects.push(
      { id: 'a', mode: 'DTP', createdAt: day(1), dtpConfig: { id: 'c', createdAt: day(1) }, owner: { id: 'u', telegramId: '1' }, question: 'q' },
      { id: 'b', mode: 'DTP', createdAt: day(2), dtpConfig: null, owner: { id: 'u', telegramId: '1' }, question: 'q2' },
    );
    const svc = new AdminDomainsService(prisma as any, fakeAudit() as any);
    const res = await svc.listProjects('op', 'dtp', { withConfig: false });
    expect(res.items.map((i) => i.id)).toEqual(['b']);
    expect(res.items[0].config).toBeNull();
    await expect(svc.listProjects('op', 'crypto')).rejects.toThrow(NotFoundException);
  });

  it('КЛЮЧЕВОЙ ТЕСТ [operator-read-the-question]: список не отдаёт слова человека, карточка отдаёт — и пишет об этом в журнал', async () => {
    // Список — навигация: оператору нужно отличать строки и видеть
    // состояние. Чтение дилеммы каждого человека подряд навигацией не
    // является. В карточке текст нужен (иначе жалобу не разобрать), и
    // ровно поэтому её открытие обязано оставлять след.
    const prisma = createFakePrisma();
    prisma._projects.push({
      id: 'p1', mode: 'HEALTH', createdAt: day(1), healthConfig: { id: 'c1', goalDescription: 'разобраться с диагнозом' },
      owner: { id: 'u7', telegramId: '77' }, question: 'что делать с результатами обследования', goal: 'выбрать клинику',
    });
    const audit = fakeAudit();
    const svc = new AdminDomainsService(prisma as any, audit as any);

    const list = await svc.listProjects('op', 'health');
    const asText = JSON.stringify(list);
    expect(asText).not.toContain('что делать с результатами обследования');
    expect(asText).not.toContain('выбрать клинику');
    expect(asText).not.toContain('разобраться с диагнозом');
    // Но отличить строки и увидеть состояние по-прежнему можно.
    expect(list.items[0]).toMatchObject({ id: 'p1', owner: { telegramId: '77' } });
    // Список ничего не записывает: смотреть перечень — не то же, что
    // читать чужие слова.
    expect(audit.records).toHaveLength(0);

    const card = await svc.getProject('op', 'health', 'p1');
    expect(JSON.stringify(card)).toContain('что делать с результатами обследования');
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ actorId: 'op', action: OPERATOR_VIEWED_PROJECT, resource: 'Project', resourceId: 'p1' });
    // В журнале нет самого текста: он уже лежит в проекте, повторять
    // его в журнале значит размножать то, что человек доверил однажды.
    expect(JSON.stringify(audit.records[0])).not.toContain('что делать с результатами обследования');
  });

  it('intakeSummary: матрица предложил×выбрал только по DISPATCHED, mismatchRate считается от dispatched', async () => {
    const prisma = createFakePrisma();
    prisma._sessions.push(
      { status: 'DISPATCHED', suggestedScenario: 'dtp', chosenScenario: 'dtp', confidence: 0.9, answers: [{ text: 'a' }] },
      { status: 'DISPATCHED', suggestedScenario: 'dtp', chosenScenario: 'UNIVERSAL', confidence: 0.5, answers: [{ text: 'a' }, { question: 'q', text: 'b' }] },
      { status: 'ABANDONED', suggestedScenario: 'health', chosenScenario: null, confidence: 0.4, answers: [{ text: 'a' }] },
    );
    const res = await new AdminDomainsService(prisma as any, fakeAudit() as any).intakeSummary('op');
    expect(res.byStatus).toEqual({ DISPATCHED: 2, ABANDONED: 1 });
    expect(res.suggestedVsChosen).toEqual({ dtp: { dtp: 1, UNIVERSAL: 1 } });
    expect(res.mismatchRate).toBe(0.5);
    expect(res.avgConfidence).toBe(0.6);
    expect(res.avgFollowUps).toBe(0.33);
  });

  it('mediaReviewQueues: PROCESSING без движения > суток считается застрявшим', async () => {
    const prisma = createFakePrisma();
    prisma._queues.push({ id: 'q', title: 't', createdAt: day(3), user: { telegramId: '7' }, items: [
      { status: 'PROCESSING', createdAt: day(3), conversation: { updatedAt: day(2) } },
      { status: 'PROCESSING', createdAt: day(3), conversation: { updatedAt: new Date() } },
      { status: 'DONE', createdAt: day(3), conversation: null },
    ] });
    const res = await new AdminDomainsService(prisma as any, fakeAudit() as any).mediaReviewQueues('op');
    expect(res.queues[0]).toMatchObject({ totalItems: 3, byStatus: { PROCESSING: 2, DONE: 1 }, stuckProcessing: 1, ownerTelegramId: '7' });
    // Пункт [ceiling-hid-inside-a-total] 2026-09-24: итоги считает база
    // по всем строкам, а не экран по показанному срезу.
    expect(res.totals).toMatchObject({ queues: 1, items: 3, byStatus: { PROCESSING: 2, DONE: 1 }, stuckProcessing: 1 });
    expect(res.hasMore).toBe(false);
  });
});

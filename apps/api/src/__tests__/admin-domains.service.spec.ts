// Фаза F ТЗ domain-ui-and-voice-intake — операторский обзор доменов.
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminDomainsService } from '../admin-domains/admin-domains.service';

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
      findMany: async ({ where, take, skip }: any) => projects.filter((p) => matches(p, where)).slice(skip, skip + take),
      findFirst: async ({ where }: any) => projects.find((p) => matches(p, where)) ?? null,
    },
    intakeSession: { findMany: async () => sessions },
    mediaReviewQueue: { findMany: async () => queues },
  };
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
    expect(res[0]).toMatchObject({ totalItems: 3, byStatus: { PROCESSING: 2, DONE: 1 }, stuckProcessing: 1, ownerTelegramId: '7' });
  });
});

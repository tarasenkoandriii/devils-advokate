import { PromptRegistryService } from '../prompt-registry/prompt-registry.service';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const users = new Map<string, any>();
  const versions: any[] = [];
  const runs: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  // Пункт [the-first-row-was-whichever] 2026-10-05: фейк обязан знать
  // ту же форму, что production, иначе он проверяет себя. Здесь было
  // ТРИ расхождения, и каждое прятало проверяемое поведение:
  //  • `findMany` игнорировал `where.status` — повышение версии под
  //    замком сняло бы ВСЕ версии промпта, а не активные, и тест бы
  //    этого не заметил;
  //  • `findFirst` всегда сортировал по `createdAt: 'desc'`, что бы ни
  //    просили, — то есть новый порядок `[updatedAt desc, id desc]`
  //    проверить было нечем;
  //  • `update` не двигал `updatedAt`, а именно по нему теперь
  //    выбирается «последняя переведённая в ACTIVE».
  const matchWhere = (v: any, where: any = {}) => {
    if (where.promptId !== undefined && v.promptId !== where.promptId) return false;
    if (where.status !== undefined && v.status !== where.status) return false;
    if (where.id !== undefined && v.id !== where.id) return false;
    return true;
  };
  /** Порядок берётся из запроса, а не придумывается заглушкой. */
  const applyOrder = (rows: any[], orderBy: any) => {
    const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o: any) =>
      Object.entries(o).map(([field, dir]) => ({ field, dir })),
    );
    if (keys.length === 0) return rows;
    return [...rows].sort((a, b) => {
      for (const { field, dir } of keys as Array<{ field: string; dir: string }>) {
        const av = a[field];
        const bv = b[field];
        if (av === bv) continue;
        const cmp = av > bv ? 1 : -1;
        return dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  };

  const fake: any = {
    _seedUser(u: any) { users.set(u.id, { isOperator: false, ...u }); },
    _seedRun(r: any) { runs.push(r); },
    _getVersions() { return versions; },

    // Замок берётся сырым запросом внутри интерактивной транзакции —
    // заглушка обязана знать и то, и другое.
    $executeRaw: async () => 1,
    $transaction: async (arg: any): Promise<any> => (typeof arg === 'function' ? arg(fake) : Promise.all(arg)),

    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
    },
    promptVersion: {
      create: async ({ data }: any) => {
        const v = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        versions.push(v);
        return v;
      },
      findMany: async ({ where, orderBy }: any = {}) =>
        applyOrder(versions.filter((v) => matchWhere(v, where)), orderBy ?? { createdAt: 'desc' }),
      findFirst: async ({ where, orderBy }: any = {}) =>
        applyOrder(versions.filter((v) => matchWhere(v, where)), orderBy ?? { createdAt: 'desc' })[0] ?? null,
      findUnique: async ({ where }: any) => versions.find((v) => v.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const idx = versions.findIndex((v) => v.id === where.id);
        versions[idx] = { ...versions[idx], ...data, updatedAt: new Date() };
        return versions[idx];
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        versions.forEach((v, i) => {
          if (!matchWhere(v, where)) return;
          versions[i] = { ...v, ...data, updatedAt: new Date() };
          count += 1;
        });
        return { count };
      },
    },
    evaluationRun: {
      findFirst: async ({ where }: any) => {
        const matches = runs.filter((r) => r.promptVersionId === where.promptVersionId);
        return matches.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
      },
    },
  };
  return fake;
}

function makeService(prisma: any) {
  return new PromptRegistryService(prisma, { record: async () => ({}) } as any);
}

describe('PromptRegistryService', () => {
  it('отклоняет операции для пользователя без isOperator', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'u1', isOperator: false });
    const service = makeService(prisma);

    await expect(service.createDraft('u1', 'my-prompt', 'v1', 'template text')).rejects.toThrow(ForbiddenException);
  });

  it('создаёт draft и позволяет редактировать, пока статус draft', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const service = makeService(prisma);

    const draft = await service.createDraft('op1', 'my-prompt', 'v1', 'original template');
    expect(draft.status).toBe('DRAFT');

    const updated = await service.updateDraft('op1', draft.id, { template: 'edited template' });
    expect(updated.template).toBe('edited template');
  });

  it('запрещает PATCH после перехода в testing — контент не должен тихо меняться', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const service = makeService(prisma);

    const draft = await service.createDraft('op1', 'my-prompt', 'v1', 'template');
    await service.promoteToTesting('op1', draft.id);

    await expect(service.updateDraft('op1', draft.id, { template: 'sneaky edit' })).rejects.toThrow(BadRequestException);
  });

  it('promoteToActive отклоняется без EvaluationRun вообще (acceptance-тест §6.1 ТЗ)', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const service = makeService(prisma);

    const draft = await service.createDraft('op1', 'my-prompt', 'v1', 'template');
    await service.promoteToTesting('op1', draft.id);

    await expect(service.promoteToActive('op1', draft.id)).rejects.toThrow(BadRequestException);
  });

  it('promoteToActive отклоняется, если ReleaseGate.passed = false, с указанием непройденной метрики', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const service = makeService(prisma);

    const draft = await service.createDraft('op1', 'my-prompt', 'v1', 'template');
    await service.promoteToTesting('op1', draft.id);

    prisma._seedRun({
      id: 'run1',
      promptVersionId: draft.id,
      startedAt: new Date(),
      releaseGate: { passed: false },
      results: [{ passed: false, value: 0.12, evaluationMetric: { name: 'false_positive_rate' } }],
    });

    await expect(service.promoteToActive('op1', draft.id)).rejects.toThrow(ForbiddenException);
    try {
      await service.promoteToActive('op1', draft.id);
    } catch (err: any) {
      expect(err.message).toContain('false_positive_rate');
    }
  });

  it('promoteToActive проходит при passed=true и деактивирует предыдущую ACTIVE-версию', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const service = makeService(prisma);

    // Уже есть активная версия v1
    const oldActive = await service.createDraft('op1', 'my-prompt', 'v1', 'old template');
    await prisma.promptVersion.update({ where: { id: oldActive.id }, data: { status: 'ACTIVE' } });

    const draft = await service.createDraft('op1', 'my-prompt', 'v2', 'new template');
    await service.promoteToTesting('op1', draft.id);
    prisma._seedRun({
      id: 'run1',
      promptVersionId: draft.id,
      startedAt: new Date(),
      releaseGate: { passed: true },
      results: [],
    });

    const activated = await service.promoteToActive('op1', draft.id);
    expect(activated.status).toBe('ACTIVE');

    const oldNow = await prisma.promptVersion.findUnique({ where: { id: oldActive.id } });
    expect(oldNow.status).toBe('DEPRECATED');
  });

  it('регресійний тест (Пункт [audit-log]): promoteToActive РЕАЛЬНО викликає auditLog.record — найвпливовіша з чотирьох аудитованих дій', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const recordedCalls: any[] = [];
    const auditLog = { record: async (input: any) => { recordedCalls.push(input); return {}; } };
    const service = new PromptRegistryService(prisma as any, auditLog as any);

    const draft = await service.createDraft('op1', 'my-prompt', 'v1', 'template');
    await service.promoteToTesting('op1', draft.id);
    prisma._seedRun({ id: 'run1', promptVersionId: draft.id, startedAt: new Date(), releaseGate: { passed: true }, results: [] });

    await service.promoteToActive('op1', draft.id);

    expect(recordedCalls.length).toBe(1);
    expect(recordedCalls[0].action).toBe('prompt_version.promoted_to_active');
    expect(recordedCalls[0].resource).toBe('PromptVersion');
  });

  it('регресійний тест (Пункт [audit-log]): rollback РЕАЛЬНО викликає auditLog.record', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const recordedCalls: any[] = [];
    const auditLog = { record: async (input: any) => { recordedCalls.push(input); return {}; } };
    const service = new PromptRegistryService(prisma as any, auditLog as any);

    const v1 = await service.createDraft('op1', 'my-prompt', 'v1', 't1');
    await prisma.promptVersion.update({ where: { id: v1.id }, data: { status: 'DEPRECATED' } });
    const v2 = await service.createDraft('op1', 'my-prompt', 'v2', 't2');
    await prisma.promptVersion.update({ where: { id: v2.id }, data: { status: 'ACTIVE' } });

    await service.rollback('op1', 'my-prompt');

    expect(recordedCalls.length).toBe(1);
    expect(recordedCalls[0].action).toBe('prompt_version.rolled_back');
  });

  it('rollback возвращает предыдущую DEPRECATED-версию в ACTIVE одной операцией', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const service = makeService(prisma);

    const v1 = await service.createDraft('op1', 'my-prompt', 'v1', 'template v1');
    await prisma.promptVersion.update({ where: { id: v1.id }, data: { status: 'DEPRECATED' } });
    const v2 = await service.createDraft('op1', 'my-prompt', 'v2', 'template v2');
    await prisma.promptVersion.update({ where: { id: v2.id }, data: { status: 'ACTIVE' } });

    const rolledBack = await service.rollback('op1', 'my-prompt');
    expect(rolledBack.id).toBe(v1.id);
    expect(rolledBack.status).toBe('ACTIVE');

    const v2Now = await prisma.promptVersion.findUnique({ where: { id: v2.id } });
    expect(v2Now.status).toBe('ROLLBACK');
  });

  it('rollback без предыдущей DEPRECATED-версии — честная ошибка, не тихий no-op', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const service = makeService(prisma);

    const v1 = await service.createDraft('op1', 'my-prompt', 'v1', 'template');
    await prisma.promptVersion.update({ where: { id: v1.id }, data: { status: 'ACTIVE' } });

    await expect(service.rollback('op1', 'my-prompt')).rejects.toThrow(BadRequestException);
  });

  it('promoteToTesting требует статус draft', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const service = makeService(prisma);

    const draft = await service.createDraft('op1', 'my-prompt', 'v1', 'template');
    await service.promoteToTesting('op1', draft.id);

    await expect(service.promoteToTesting('op1', draft.id)).rejects.toThrow(BadRequestException);
  });

  it('операции с несуществующим id дают NotFoundException', async () => {
    const prisma = createFakePrisma();
    prisma._seedUser({ id: 'op1', isOperator: true });
    const service = makeService(prisma);

    await expect(service.updateDraft('op1', 'nonexistent', { template: 'x' })).rejects.toThrow(NotFoundException);
  });
});

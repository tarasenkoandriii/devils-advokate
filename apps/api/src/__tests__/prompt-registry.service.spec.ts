import { PromptRegistryService } from '../prompt-registry/prompt-registry.service';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const users = new Map<string, any>();
  const versions: any[] = [];
  const runs: any[] = [];
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    _seedUser(u: any) { users.set(u.id, { isOperator: false, ...u }); },
    _seedRun(r: any) { runs.push(r); },
    _getVersions() { return versions; },

    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
    },
    promptVersion: {
      create: async ({ data }: any) => {
        const v = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        versions.push(v);
        return v;
      },
      findMany: async ({ where }: any) =>
        versions.filter((v) => v.promptId === where.promptId).sort((a, b) => b.createdAt - a.createdAt),
      findFirst: async ({ where }: any) => {
        const matches = versions.filter((v) => {
          if (where.promptId && v.promptId !== where.promptId) return false;
          if (where.status && v.status !== where.status) return false;
          return true;
        });
        return matches.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      },
      findUnique: async ({ where }: any) => versions.find((v) => v.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const idx = versions.findIndex((v) => v.id === where.id);
        versions[idx] = { ...versions[idx], ...data };
        return versions[idx];
      },
    },
    evaluationRun: {
      findFirst: async ({ where }: any) => {
        const matches = runs.filter((r) => r.promptVersionId === where.promptVersionId);
        return matches.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
      },
    },
  };
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

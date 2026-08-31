import { DecisionObjectiveService } from '../decision-objective/decision-objective.service';
import { NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const objectives = new Map<string, any>();
  let idCounter = 0;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return p;
      },
    },
    decisionObjective: {
      findUnique: async ({ where }: any) => objectives.get(where.projectId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const existing = objectives.get(where.projectId);
        const merged = existing
          ? { ...existing, ...update, updatedAt: new Date() }
          : { id: `obj-${++idCounter}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        objectives.set(where.projectId, merged);
        return merged;
      },
    },
  };
}

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';

describe('DecisionObjectiveService', () => {
  it('get() возвращает null, если ещё не сохранено', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const service = new DecisionObjectiveService(prisma as any);

    const result = await service.get(USER_ID, PROJECT_ID);
    expect(result).toBeNull();
  });

  it('save() создаёт объект при первом сохранении', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const service = new DecisionObjectiveService(prisma as any);

    const saved = await service.save(USER_ID, PROJECT_ID, {
      desiredOutcome: 'Повышение на 20%',
      constraints: ['Бюджет команды ограничен'],
      nonNegotiables: ['Остаться в текущей роли'],
    });

    expect(saved.desiredOutcome).toBe('Повышение на 20%');
    expect(saved.constraints).toEqual(['Бюджет команды ограничен']);
    expect(saved.nonNegotiables).toEqual(['Остаться в текущей роли']);
  });

  it('save() второй раз обновляет, а не создаёт дубликат (upsert)', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const service = new DecisionObjectiveService(prisma as any);

    await service.save(USER_ID, PROJECT_ID, { desiredOutcome: 'Первая версия' });
    const updated = await service.save(USER_ID, PROJECT_ID, { desiredOutcome: 'Вторая версия' });

    expect(updated.desiredOutcome).toBe('Вторая версия');
    const fetched = await service.get(USER_ID, PROJECT_ID);
    expect(fetched!.desiredOutcome).toBe('Вторая версия');
  });

  it('save() отклоняет чужой проект', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const service = new DecisionObjectiveService(prisma as any);

    await expect(
      service.save(USER_ID, PROJECT_ID, { desiredOutcome: 'Взлом' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('save() парсит deadline из ISO-строки в Date', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const service = new DecisionObjectiveService(prisma as any);

    const saved = await service.save(USER_ID, PROJECT_ID, { deadline: '2026-12-31T00:00:00.000Z' });
    expect(saved.deadline instanceof Date).toBe(true);
  });
});

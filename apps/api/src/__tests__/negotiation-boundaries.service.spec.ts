import { NegotiationBoundariesService } from '../negotiation-boundaries/negotiation-boundaries.service';
import { NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  const boundaries = new Map<string, any>();
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
    negotiationBoundaries: {
      findUnique: async ({ where }: any) => boundaries.get(where.projectId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const existing = boundaries.get(where.projectId);
        const merged = existing
          ? { ...existing, ...update, updatedAt: new Date() }
          : { id: `nb-${++idCounter}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        boundaries.set(where.projectId, merged);
        return merged;
      },
    },
  };
}

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';

describe('NegotiationBoundariesService', () => {
  it('get() возвращает null, если ещё не сохранено', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const service = new NegotiationBoundariesService(prisma as any);

    expect(await service.get(USER_ID, PROJECT_ID)).toBeNull();
  });

  it('save() создаёт и позволяет читать BATNA/WATNA/walkAwayPoint', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const service = new NegotiationBoundariesService(prisma as any);

    const saved = await service.save(USER_ID, PROJECT_ID, {
      batna: 'Остаться на текущей позиции ещё год',
      watna: 'Уволиться без нового предложения',
      walkAwayPoint: 'Отказ без объяснений или угрозы',
    });

    expect(saved.batna).toBe('Остаться на текущей позиции ещё год');
    expect(saved.watna).toBe('Уволиться без нового предложения');
    expect(saved.walkAwayPoint).toBe('Отказ без объяснений или угрозы');
  });

  it('save() второй раз обновляет (upsert), не дублирует', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: USER_ID });
    const service = new NegotiationBoundariesService(prisma as any);

    await service.save(USER_ID, PROJECT_ID, { batna: 'Первая версия' });
    const updated = await service.save(USER_ID, PROJECT_ID, { batna: 'Вторая версия' });

    expect(updated.batna).toBe('Вторая версия');
  });

  it('save() отклоняет чужой проект', async () => {
    const prisma = createFakePrisma();
    prisma._seedProject({ id: PROJECT_ID, ownerId: 'other-user' });
    const service = new NegotiationBoundariesService(prisma as any);

    await expect(service.save(USER_ID, PROJECT_ID, { batna: 'X' })).rejects.toThrow(NotFoundException);
  });
});

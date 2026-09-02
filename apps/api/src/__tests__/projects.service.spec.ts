import { ProjectsService } from '../projects/projects.service';
import { NotFoundException } from '@nestjs/common';

function createFakePrisma() {
  const projects = new Map<string, any>();
  let idCounter = 0;

  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    project: {
      create: async ({ data }: any) => {
        const p = { id: `proj-${++idCounter}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        projects.set(p.id, p);
        return p;
      },
      findMany: async ({ where, take, skip }: any) => {  // фейк не воспроизводит orderBy — порядок здесь не проверяется
        let items = [...projects.values()].filter((p) => p.ownerId === where.ownerId);
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        items = items.slice(skip ?? 0, (skip ?? 0) + (take ?? items.length));
        return items.map((p) => ({ ...p, _count: { arguments: 0, people: 0 } }));
      },
      count: async ({ where }: any) => [...projects.values()].filter((p) => p.ownerId === where.ownerId).length,
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p || p.ownerId !== where.ownerId) return null;
        return { ...p, arguments: [], people: [] };
      },
      update: async ({ where, data }: any) => {
        const p = projects.get(where.id);
        const merged = { ...p, ...data, updatedAt: new Date() };
        projects.set(where.id, merged);
        return merged;
      },
      delete: async ({ where }: any) => {
        const p = projects.get(where.id);
        projects.delete(where.id);
        return p;
      },
    },
  };
}

function fakeCleanup() {
  const calls: string[] = [];
  return { calls, discardForProject: async (id: string) => { calls.push(id); return {} as never; } } as any;
}

describe('ProjectsService', () => {
  it('create() создаёт проект с ownerId = userId', async () => {
    const prisma = createFakePrisma();
    const service = new ProjectsService(prisma as any, fakeCleanup());
    const project = await service.create('user-1', { question: 'Разговор о зарплате' });
    expect(project.ownerId).toBe('user-1');
    expect(project.question).toBe('Разговор о зарплате');
  });

  it('list() возвращает только проекты владельца', async () => {
    const prisma = createFakePrisma();
    const service = new ProjectsService(prisma as any, fakeCleanup());
    await service.create('user-1', { question: 'Q1' });
    await service.create('user-1', { question: 'Q2' });
    await service.create('user-2', { question: 'Чужой проект' });

    const result = await service.list('user-1');
    expect(result.total).toBe(2);
    expect(result.items.every((p) => p.question !== 'Чужой проект')).toBe(true);
  });

  it('list() ограничивает take потолком 100', async () => {
    const prisma = createFakePrisma();
    const service = new ProjectsService(prisma as any, fakeCleanup());
    await service.create('user-1', { question: 'Q1' });
    const result = await service.list('user-1', { take: 99999 });
    expect(result.take).toBe(100);
  });

  it('getDetail() бросает NotFoundException для чужого проекта', async () => {
    const prisma = createFakePrisma();
    const service = new ProjectsService(prisma as any, fakeCleanup());
    const project = await service.create('user-2', { question: 'Чужой' });

    await expect(service.getDetail('user-1', project.id)).rejects.toThrow(NotFoundException);
  });

  it('getDetail() бросает NotFoundException для несуществующего id (не отличимо от "чужой")', async () => {
    const prisma = createFakePrisma();
    const service = new ProjectsService(prisma as any, fakeCleanup());
    await expect(service.getDetail('user-1', 'does-not-exist')).rejects.toThrow(NotFoundException);
  });

  it('update() не позволяет изменить чужой проект', async () => {
    const prisma = createFakePrisma();
    const service = new ProjectsService(prisma as any, fakeCleanup());
    const project = await service.create('user-2', { question: 'Чужой' });

    await expect(service.update('user-1', project.id, { question: 'Взлом' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('update() успешно меняет свой проект', async () => {
    const prisma = createFakePrisma();
    const service = new ProjectsService(prisma as any, fakeCleanup());
    const project = await service.create('user-1', { question: 'Старый вопрос' });

    const updated = await service.update('user-1', project.id, { question: 'Новый вопрос' });
    expect(updated.question).toBe('Новый вопрос');
  });

  it('remove() не позволяет удалить чужой проект — и не трогает внешние артефакты', async () => {
    const prisma = createFakePrisma();
    const cleanup = fakeCleanup();
    const service = new ProjectsService(prisma as any, cleanup);
    const project = await service.create('user-2', { question: 'Чужой' });

    await expect(service.remove('user-1', project.id)).rejects.toThrow(NotFoundException);
    expect(cleanup.calls).toEqual([]);
  });

  it('remove() успешно удаляет свой проект, сначала убрав внешние артефакты (аудит 2026-09-02)', async () => {
    const prisma = createFakePrisma();
    const cleanup = fakeCleanup();
    const service = new ProjectsService(prisma as any, cleanup);
    const project = await service.create('user-1', { question: 'Мой проект' });

    await service.remove('user-1', project.id);
    // Каскад БД не видит файлы в хранилище и задачи у STT-провайдера —
    // «Удалить всё» без этого шага оставляло их навсегда.
    expect(cleanup.calls).toEqual([project.id]);
    await expect(service.getDetail('user-1', project.id)).rejects.toThrow(NotFoundException);
  });
});

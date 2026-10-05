// Сверка 2026-09-04, серверная половина — что человек может узнать о
// том, что сам отправил.
//
// НАЙДЕННОЕ. `LibraryEntry.submittedByUserId` записывался при создании и
// НЕ ЧИТАЛСЯ НИГДЕ во всём проекте: ни эндпоинта, ни экрана, ни даже
// обёртки в клиенте. Человек отдавал свой набор аргументов в публичную
// библиотеку — и больше не мог узнать о нём ничего. Экран отправки при
// этом утверждал: «ожидает модерации ИЛИ УЖЕ ОПУБЛИКОВАН» — два исхода
// из трёх, и отсутствовал единственный плохой.
//
// И вторая половина того же: отказ повторной отправки говорил «Этот
// проект уже отправлен в библиотеку». После отклонения это неправда по
// смыслу — человек читает «ждёт своей очереди» и ждёт решения, которое
// уже принято.

import { BadRequestException } from '@nestjs/common';
import { LibraryService } from '../library/library.service';

function fakePrisma() {
  const entries: any[] = [];
  const projects = new Map<string, any>();
  const argumentsStore: any[] = [];
  let n = 0;
  return {
    _seedProject(p: any) { projects.set(p.id, p); },
    _seedArgument(a: any) { argumentsStore.push(a); },
    _seedEntry(e: any) {
      entries.push({ id: `e-${++n}`, status: 'PENDING', moderatedAt: null, createdAt: new Date(2026, 0, ++n), ...e });
    },
    project: {
      findFirst: async ({ where }: any) => {
        const p = projects.get(where.id);
        return p && p.ownerId === where.ownerId ? p : null;
      },
    },
    argument: { findMany: async ({ where }: any) => argumentsStore.filter((a) => a.projectId === where.projectId) },
    libraryEntry: {
      findFirst: async ({ where }: any) =>
        entries.find((e) => (where.sourceProjectId === undefined || e.sourceProjectId === where.sourceProjectId)) ?? null,
      findMany: async ({ where, orderBy }: any) => {
        let rows = entries;
        if (where?.submittedByUserId !== undefined) {
          rows = rows.filter((e) => e.submittedByUserId === where.submittedByUserId);
        }
        rows = [...rows];
        if (orderBy?.createdAt === 'desc') rows.sort((a, b) => b.createdAt - a.createdAt);
        return rows;
      },
      create: async ({ data }: any) => {
        const e = { id: `e-${++n}`, status: 'PENDING', moderatedAt: null, createdAt: new Date(), ...data };
        entries.push(e);
        return e;
      },
    },
    libraryArgument: { create: async ({ data }: any) => data },
    $transaction: async (ops: any[]) => Promise.all(ops),
    // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05: под замком
    // счётчика расходов идёт сырой запрос — заглушка обязана знать и его.
    $executeRaw: async () => 1,
  };
}

function setup() {
  const prisma = fakePrisma();
  const service = new LibraryService(prisma as any, { record: async () => ({}) } as any);
  return { prisma, service };
}

describe('Своя отправка: человек может узнать, что с ней стало', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: человек видит СВОИ отправки и не видит чужих', async () => {
    const s = setup();
    s.prisma._seedEntry({ submittedByUserId: 'me', title: 'Моя', category: 'к', status: 'REJECTED' });
    s.prisma._seedEntry({ submittedByUserId: 'someone-else', title: 'Чужая', category: 'к' });

    const mine = await s.service.listMySubmissions('me');
    expect(mine.map((e: any) => e.title)).toEqual(['Моя']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отклонение видно — раньше человек не мог узнать о нём никак', async () => {
    // До этой сверки `submittedByUserId` писался и не читался нигде:
    // единственный плохой исход был единственным, о котором нельзя было
    // узнать.
    const s = setup();
    const decided = new Date('2026-08-01T00:00:00Z');
    s.prisma._seedEntry({ submittedByUserId: 'me', title: 'Т', category: 'к', status: 'REJECTED', moderatedAt: decided });

    const [row] = await s.service.listMySubmissions('me');
    expect(row.status).toBe('REJECTED');
    expect(row.moderatedAt).toEqual(decided);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отказ повторной отправки называет НАСТОЯЩЕЕ состояние', async () => {
    // «Уже отправлен» после отклонения человек читает как «ждёт своей
    // очереди» — и ждёт решения, которое уже принято.
    const s = setup();
    s.prisma._seedProject({ id: 'p1', ownerId: 'me' });
    s.prisma._seedArgument({ projectId: 'p1', text: 'а', stance: 'PRO', targetPersonId: null });

    s.prisma._seedEntry({ sourceProjectId: 'p1', submittedByUserId: 'me', status: 'REJECTED' });
    await expect(s.service.submitProject('me', 'p1', 'т', 'к')).rejects.toThrow(/отклонили/);

    const s2 = setup();
    s2.prisma._seedProject({ id: 'p1', ownerId: 'me' });
    s2.prisma._seedArgument({ projectId: 'p1', text: 'а', stance: 'PRO', targetPersonId: null });
    s2.prisma._seedEntry({ sourceProjectId: 'p1', submittedByUserId: 'me', status: 'ACCEPTED' });
    await expect(s2.service.submitProject('me', 'p1', 'т', 'к')).rejects.toThrow(/опубликован/);

    const s3 = setup();
    s3.prisma._seedProject({ id: 'p1', ownerId: 'me' });
    s3.prisma._seedArgument({ projectId: 'p1', text: 'а', stance: 'PRO', targetPersonId: null });
    s3.prisma._seedEntry({ sourceProjectId: 'p1', submittedByUserId: 'me', status: 'PENDING' });
    await expect(s3.service.submitProject('me', 'p1', 'т', 'к')).rejects.toThrow(/ждёт решения/);
  });

  it('повторная отправка по-прежнему ОТКЛОНЯЕТСЯ — правило не ослаблено ради формулировки', async () => {
    const s = setup();
    s.prisma._seedProject({ id: 'p1', ownerId: 'me' });
    s.prisma._seedArgument({ projectId: 'p1', text: 'а', stance: 'PRO', targetPersonId: null });
    s.prisma._seedEntry({ sourceProjectId: 'p1', submittedByUserId: 'me', status: 'REJECTED' });
    await expect(s.service.submitProject('me', 'p1', 'т', 'к')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('список своих отправок НЕ требует прав модератора — это своё о своём', async () => {
    // Соседний метод того же сервиса (`listPendingForModeration`) зовёт
    // assertModerator; здесь его быть не должно, иначе человек снова не
    // узнает о своей записи ничего.
    const s = setup();
    s.prisma._seedEntry({ submittedByUserId: 'me', title: 'Моя', category: 'к' });
    await expect(s.service.listMySubmissions('me')).resolves.toHaveLength(1);
  });
});

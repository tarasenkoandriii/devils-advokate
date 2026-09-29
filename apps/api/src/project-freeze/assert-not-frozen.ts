// Аудит заморозки 2026-09-03 — там, где guard физически не видит проект.
//
// `ProjectFrozenGuard` находит проект ПО URL. Это покрывает 151 мутирующий
// маршрут из 154, но не покрывает три вида действий, где проект в адресе не
// назван вовсе: принятие приглашения/самошеринга по токену (проект-получатель
// приходит телом запроса) и передача копии второй стороне (проект получателя
// вычисляется из шеринга). Guard про них не узнает никогда — это не пробел
// таблицы, а граница самого приёма «резолвить по URL».
//
// Правило одно и без исключений: в замороженный проект не пишут — ни его
// владелец, ни вторая сторона. «Изменения недоступны» — про данные проекта,
// а не про то, кто именно их инициировал.
//
// Но текст ответа разный, и это не косметика. Своему владельцу мы называем
// причину и заметку оператора: он имеет право знать, что с его проектом.
// Второй стороне — нейтрально, без слова «заморожен» и без заметки:
// статус чужого проекта в модерации не наше дело сообщать, а сообщение
// «оператор заморозил проект такого-то» превратило бы отправку оффера в
// способ узнать чужой модерационный статус.

import { PrismaService } from '../prisma/prisma.service';
import { ProjectFrozenException } from './project-frozen.guard';

/** Проект самого пользователя: причина и заметка оператора называются. */
export async function assertProjectNotFrozen(prisma: PrismaService, projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { frozenAt: true, frozenNote: true } });
  if (project?.frozenAt) throw new ProjectFrozenException(project.frozenNote);
}

/** Проект второй стороны: отправитель узнаёт, что доставки не произошло, и
 * ничего сверх этого. */
export async function assertCounterpartyProjectNotFrozen(prisma: PrismaService, projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { frozenAt: true } });
  if (project?.frozenAt) {
    throw new ProjectFrozenException(null, 'Проект второй стороны сейчас не принимает изменения — передача не выполнена. Свяжитесь с ней напрямую.');
  }
}

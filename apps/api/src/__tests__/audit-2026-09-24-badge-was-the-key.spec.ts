// Пункт [badge-was-the-key] 2026-09-24 — поведенческая половина.
//
// КАК СВЕРКА ВЫРОСЛА ИЗ ПРЕДЫДУЩЕЙ. [ceiling-hid-inside-a-total] нашёл
// механизм, у которого была вторая половина, и её не вызвали. Здесь —
// ВЫВОД, который был записан и применён к одной поверхности из трёх.
//
// Сверка 2026-09-06 («публичная витрина отдавала строку целиком»)
// закончилась выводом про ИЗМЕРЕНИЕ: считать чувствительным надо не по
// названию поля, а по ПОВЕРХНОСТИ — что уходит туда, где нет
// аутентификации. Публичных поверхностей в проекте три. Вывод применили
// к витрине заведений.
//
// НАЙДЕННОЕ НА ОСТАВШИХСЯ ДВУХ.
//
// 1. УДОСТОВЕРЕНИЕ, НАПЕЧАТАННОЕ НА СТРАНИЦЕ. Право участника
//    публичного обсуждения «забрать своё» проверялось по его
//    `participantId` — и тот же `participantId` уходил в ответ
//    публичной страницы для КАЖДОГО участника. Открывший ссылку
//    получал список чужих удостоверений и мог удалить любой
//    комментарий и забрать любую непринятую заявку.
//
//    Проверка `where: { participantId }` и текст ошибки «написан не
//    вами» выглядели правом собственности, а проверяли ровно одно:
//    знает ли спрашивающий число, только что ему показанное. Это
//    «проверка, которая выглядит существующей», в самом дорогом месте —
//    на маршруте без аутентификации.
//
//    А рядом, в контроллере, написано: идентификатор передаётся телом,
//    а не путём, «чтобы не оседал в логах прокси». Берегли от логов то,
//    что печатали на экране.
//
// 2. НЕВИДИМАЯ НА СТРАНИЦЕ ВЫДАЧА. Аргумент уходил строкой целиком,
//    вместе с `weight` — субъективной оценкой силы, которую автор
//    проекта ставит для себя. В публичной библиотеке так же уходили
//    `submittedByUserId` (внутренний идентификатор живого человека) и
//    `sourceProjectId` (ссылка на частный проект).
//
// 3. НИТЬ, СШИВАВШАЯ ДВА СПИСКА. Заявки показываются БЕЗ имени — это
//    решение пункта [public-name]; комментарии — С именем. Общий
//    `participantId` в обоих списках возвращал имя к «безымянной»
//    заявке. Прямой путь тогда закрыли, обходной остался.
//
// ПРАВИЛО: ОПОЗНАВАТЬ МОЖНО ТОЛЬКО ПО ТОМУ, ЧЕГО НЕ ОТДАВАЛ ДРУГИМ.

import { NotFoundException } from '@nestjs/common';
import { PublicDiscussionService } from '../public-discussion/public-discussion.service';
import { LibraryService } from '../library/library.service';

/** Сравнение КАК У PRISMA, и это здесь главное.
 *
 * `where: { participantId: undefined }` для Prisma значит «условия нет»
 * — фильтр просто выпадает, и запрос совпадает с ЛЮБОЙ строкой. Первая
 * редакция этой заглушки сравнивала `===` напрямую, то есть считала
 * `undefined` значением, которое ни с чем не совпадает, — ровно
 * наоборот. Мутация «пропустить проверку удостоверения» на такой
 * заглушке проходила незамеченной: в production она открыла бы удаление
 * чужого по пустому токену, а в тесте дала бы «не найдено».
 *
 * Заглушка, добрее production, — знакомая форма: «заглушка беднее
 * production», только с другой стороны. */
function matches(row: any, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue; // Prisma: условие выпадает
    if (row[key] !== value) return false;
  }
  return true;
}

function fakePrisma() {
  const comments = [
    { id: 'c1', projectId: 'p1', text: 'подписанный', participantId: 'p-me', displayName: 'Пётр' },
    { id: 'c2', projectId: 'p1', text: 'чужой', participantId: 'p-other', displayName: 'Анна' },
  ];
  const submissions = [
    { id: 's1', projectId: 'p1', text: 'моя заявка', participantId: 'p-me', status: 'PENDING' },
    { id: 's2', projectId: 'p1', text: 'чужая заявка', participantId: 'p-other', status: 'PENDING' },
  ];
  const project = (row: any, select?: any) => {
    if (!select) return { ...row };
    const out: any = {};
    for (const [k, v] of Object.entries(select)) {
      if (v === true) out[k] = row[k];
      else if (typeof v === 'object' && v && 'select' in (v as any)) {
        const nested = row[k];
        out[k] = nested ? project(nested, (v as any).select) : null;
      }
    }
    return out;
  };
  return {
    _comments: comments,
    _submissions: submissions,
    project: { findFirst: async ({ where }: any) => (where.publicShareToken === 'tok' ? { id: 'p1', question: 'в?', goal: null } : null) },
    // Строка БОГАЧЕ публичного ответа: сервис, вернувший то, что дала
    // база, будет на этом пойман.
    argument: {
      findMany: async ({ select }: any) =>
        [{ id: 'a1', text: 'аргумент', stance: 'PRO', weight: 0.92, projectId: 'p1', targetPersonId: null, scriptureReference: null }].map((r) =>
          project(r, select),
        ),
    },
    publicArgumentSubmission: {
      findMany: async ({ select }: any) => submissions.map((r) => project(r, select)),
      findFirst: async ({ where }: any) => submissions.find((r) => matches(r, where)) ?? null,
      delete: async ({ where }: any) => submissions.splice(submissions.findIndex((r) => r.id === where.id), 1)[0],
    },
    publicComment: {
      findMany: async ({ select }: any) =>
        comments.map((c) => project({ ...c, createdAt: new Date(), participant: { displayName: c.displayName } }, select)),
      findFirst: async ({ where }: any) => comments.find((c) => matches(c, where)) ?? null,
      delete: async ({ where }: any) => comments.splice(comments.findIndex((c) => c.id === where.id), 1)[0],
    },
    publicParticipant: {
      findFirst: async ({ where }: any) => (where.withdrawToken === 'secret-of-me' ? { id: 'p-me' } : null),
    },
    protocol: { findFirst: async () => null },
    closingMessage: { findFirst: async () => null },
  } as any;
}

function libraryPrisma() {
  const row: Record<string, unknown> = {
    id: 'e1', title: 'разбор', category: 'семья', status: 'ACCEPTED',
    upvotes: 3, downvotes: 0, createdAt: new Date(), updatedAt: new Date(),
    submittedByUserId: 'user-42', sourceProjectId: 'proj-77', moderatedAt: new Date(),
  };
  const project = (select?: any) => {
    if (!select) return { ...row };
    const out: any = {};
    for (const k of Object.keys(select)) out[k] = (row as any)[k] ?? [];
    return out;
  };
  return {
    _row: row,
    libraryEntry: {
      findMany: async ({ select }: any) => [project(select)],
      findFirst: async ({ select }: any) => project(select),
    },
  } as any;
}

/** Всё, что ушло наружу, одной строкой — так проверка не зависит от
 * того, в каком именно поле спряталось лишнее. */
function payload(view: unknown): string {
  return JSON.stringify(view);
}

describe('[badge-was-the-key] опознавать можно только по тому, чего не отдавал другим', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: удостоверение участника не выходит наружу ни в одном списке', async () => {
    const service = new PublicDiscussionService(fakePrisma(), {} as any);

    const view = await service.publicView('tok', 'p-me');

    const out = payload(view);
    expect(out.includes('p-me')).toBe(false);
    expect(out.includes('p-other')).toBe(false);
    expect(out.includes('secret-of-me')).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: чужое не забрать, зная только то, что показано на странице', async () => {
    const prisma = fakePrisma();
    const service = new PublicDiscussionService(prisma, {} as any);
    const view: any = await service.publicView('tok', 'p-me');
    // Всё, что открывший ссылку получил: идентификаторы записей.
    const otherComment = view.comments.find((c: any) => !c.mine).id;

    await expect(service.withdrawComment('tok', otherComment, 'p-other')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.withdrawComment('tok', otherComment, otherComment)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma._comments).toHaveLength(2);
  });

  it('своё по-прежнему можно забрать — по секрету, выданному при входе', async () => {
    const prisma = fakePrisma();
    const service = new PublicDiscussionService(prisma, {} as any);
    const view: any = await service.publicView('tok', 'p-me');
    const mine = view.comments.find((c: any) => c.mine).id;

    await service.withdrawComment('tok', mine, 'secret-of-me');

    expect(prisma._comments).toHaveLength(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: пустое удостоверение не удаляет НИЧЕГО', async () => {
    // Проверяется не только исключение, но и то, что в базе всё на
    // месте: дефект этого класса выглядит как «фильтр выпал», и тогда
    // исключения не будет вовсе, а запись исчезнет.
    const prisma = fakePrisma();
    const service = new PublicDiscussionService(prisma, {} as any);

    await expect(service.withdrawComment('tok', 'c1', '   ')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.withdrawComment('tok', 'c1', '')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.withdrawSubmission('tok', 's1', '')).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma._comments).toHaveLength(2);
    expect(prisma._submissions).toHaveLength(2);
  });

  it('«это моё» отмечает сервер, и без спрашивающего своим не оказывается ничто', async () => {
    const service = new PublicDiscussionService(fakePrisma(), {} as any);

    const anonymous: any = await service.publicView('tok');

    expect(anonymous.comments.every((c: any) => c.mine === false)).toBe(true);
    expect(anonymous.submissions.every((s: any) => s.mine === false)).toBe(true);
  });

  it('субъективный вес аргумента не уходит на страницу, которую открывает кто угодно', async () => {
    const service = new PublicDiscussionService(fakePrisma(), {} as any);

    const view: any = await service.publicView('tok');

    expect(payload(view).includes('0.92')).toBe(false);
    expect(view.arguments[0].text).toBe('аргумент');
  });

  it('публичная библиотека не отдаёт идентификатор автора и ссылку на частный проект', async () => {
    const prisma = libraryPrisma();
    const service = new LibraryService(prisma, {} as any);

    const browsed = payload(await service.browse());
    const entry = payload(await service.getEntry('e1'));

    for (const out of [browsed, entry]) {
      expect(out.includes('user-42')).toBe(false);
      expect(out.includes('proj-77')).toBe(false);
    }
    expect(browsed.includes('разбор')).toBe(true);
  });
});

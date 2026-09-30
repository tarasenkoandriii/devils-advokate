// Сверка 2026-09-05 — имя, отданное без предупреждения, и слова, которые
// нельзя забрать.
//
// Публичное обсуждение — самая открытая поверхность продукта: её
// открывает кто угодно по ссылке, без аккаунта, часто из пересланного
// сообщения. И у этого человека было МЕНЬШЕ всего прав из всех
// участников продукта.
//
// НАЙДЕННОЕ.
//
//  1. ИМЯ БРАЛИ, НЕ СКАЗАВ, ГДЕ ОНО ПОЯВИТСЯ. Поле «Ваше имя
//     (необязательно)» стояло без единого слова о том, что этим именем
//     подписывается каждый комментарий и что видит его каждый, кто
//     откроет ссылку. Человек вводит имя, чтобы представиться автору, —
//     а подписывает им публичную запись.
//  2. ИМЯ УХОДИЛО И ТУДА, ГДЕ ЕГО НЕ ПОКАЗЫВАЮТ. Заявки участников
//     отдавались с `include: { participant: true }`, хотя экран имя у
//     них не рисует: оно ехало в ответе каждому открывшему ссылку.
//     Невидимая на странице выдача — человек не мог даже узнать, что его
//     имя путешествует.
//  3. ЗАБРАТЬ НАПИСАННОЕ БЫЛО НЕЛЬЗЯ. Ни комментарий, ни заявку. Та же
//     форма, что в пункте [candidate-rights] и в [no-correction]: у
//     человека, который продукту не пользователь, прав меньше всех.
//
// ЧЕГО ЭТО НЕ ДЕЛАЕТ. Принятую автором заявку удалить отсюда нельзя: она
// уже стала аргументом проекта, отдельной записью со своей жизнью.
// Сказать «удалено» и оставить её там было бы обещанием без исполнения.

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PublicDiscussionService } from '../public-discussion/public-discussion.service';

/** Проекция по `select` / `include`, как это делает настоящая Prisma.
 *
 * Пункт [leak-was-checked-by-regexp] 2026-09-30: прежде фейк отдавал
 * ФИКСИРОВАННУЮ форму строки, и поведенческий тест на утечку имени был
 * бы круговым — что бы сервис ни попросил, фейк вернул бы своё. Поэтому
 * утечка проверялась регуляркой по исходнику, а регулярка искала ровно
 * одну форму записи (`include: { participant: true }`), которую рядом с
 * `select` даже не скомпилировать. Теперь фейк отдаёт то, что спросили,
 * и утечку видно на результате. */
function project(row: any, args: any): any {
  const shape = { ...(args?.select ?? {}), ...(args?.include ?? {}) };
  const keys = Object.keys(shape).filter((k) => shape[k]);
  if (keys.length === 0) return { ...row };
  const out: any = {};
  for (const k of keys) {
    if (row[k] === undefined) continue;
    out[k] = shape[k] === true ? row[k] : project(row[k], shape[k]);
  }
  return out;
}

function fakePrisma() {
  const comments: any[] = [];
  const submissions: any[] = [];
  let n = 0;
  return {
    _seedComment(c: any) { comments.push({ id: `c-${++n}`, projectId: 'p1', ...c }); },
    _seedSubmission(sub: any) { submissions.push({ id: `s-${++n}`, projectId: 'p1', status: 'PENDING', ...sub }); },
    _comments() { return comments; },
    _submissions() { return submissions; },
    project: {
      findFirst: async ({ where }: any) => (where.publicShareToken === 'tok' ? { id: 'p1', question: 'в?' } : null),
    },
    // Пункт [badge-was-the-key] 2026-09-24: удостоверение участника —
    // отдельный секрет, а не его `id`. Здесь «me-secret» принадлежит
    // участнику «me»; чужого секрета в проекте нет.
    publicParticipant: {
      findFirst: async ({ where }: any) =>
        where.withdrawToken === 'me-secret' && where.projectId === 'p1' ? { id: 'me' } : null,
    },
    argument: { findMany: async () => [] },
    protocol: { findFirst: async () => null },
    closingMessage: { findFirst: async () => null },
    publicComment: {
      findMany: async (args: any) =>
        comments.map((c) =>
          project(
            {
              id: c.id,
              text: c.text,
              createdAt: new Date(),
              participantId: c.participantId,
              participant: {
                id: c.participantId,
                displayName: c.participantId === 'me' ? 'Пётр' : 'Другой',
              },
            },
            args,
          ),
        ),
      findFirst: async ({ where }: any) =>
        comments.find(
          (c) => c.id === where.id && c.projectId === where.projectId && c.participantId === where.participantId,
        ) ?? null,
      delete: async ({ where }: any) => comments.splice(comments.findIndex((c) => c.id === where.id), 1)[0],
    },
    publicArgumentSubmission: {
      findMany: async (args: any) =>
        submissions.map((sub) =>
          project(
            {
              id: sub.id, text: sub.text, stance: 'PRO', status: sub.status,
              upvotes: 0, downvotes: 0, participantId: sub.participantId, createdAt: new Date(),
              participant: {
                id: sub.participantId,
                displayName: sub.participantId === 'me' ? 'Пётр' : 'Другой',
              },
            },
            args,
          ),
        ),
      findFirst: async ({ where }: any) =>
        submissions.find(
          (sub) => sub.id === where.id && sub.projectId === where.projectId && sub.participantId === where.participantId,
        ) ?? null,
      delete: async ({ where }: any) => submissions.splice(submissions.findIndex((sub) => sub.id === where.id), 1)[0],
    },
  };
}

function setup() {
  const prisma = fakePrisma();
  return { prisma, service: new PublicDiscussionService(prisma as any, {} as any) };
}

describe('Публичный участник: своё имя и свои слова', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: участник может забрать свой комментарий', async () => {
    const s = setup();
    s.prisma._seedComment({ participantId: 'me', text: 'мой' });
    await s.service.withdrawComment('tok', 'c-1', 'me-secret');
    expect(s.prisma._comments()).toHaveLength(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: чужой комментарий не забрать', async () => {
    // Опознание по удостоверению участника — оно же и граница.
    //
    // ПОПРАВКА, Пункт [badge-was-the-key] 2026-09-24: удостоверением
    // был `participantId`, а публичная страница печатала его для
    // КАЖДОГО участника. Этот тест проходил и тогда: он проверял, что
    // чужой id не подходит, и не мог проверить того, что чужой id был
    // у всех на виду.
    const s = setup();
    s.prisma._seedComment({ participantId: 'someone-else', text: 'чужой' });
    await expect(s.service.withdrawComment('tok', 'c-1', 'me-secret')).rejects.toBeInstanceOf(NotFoundException);
    expect(s.prisma._comments()).toHaveLength(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: нерассмотренную заявку забрать можно', async () => {
    const s = setup();
    s.prisma._seedSubmission({ participantId: 'me', text: 'аргумент', status: 'PENDING' });
    await s.service.withdrawSubmission('tok', 's-1', 'me-secret');
    expect(s.prisma._submissions()).toHaveLength(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: принятую — нельзя, и сказано почему', async () => {
    // Она уже стала аргументом проекта, отдельной записью. Сказать
    // «удалено» и оставить её там было бы обещанием без исполнения —
    // ровно то, что разобрано в пункте [candidate-rights].
    const s = setup();
    s.prisma._seedSubmission({ participantId: 'me', text: 'аргумент', status: 'ACCEPTED' });
    await expect(s.service.withdrawSubmission('tok', 's-1', 'me-secret')).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.service.withdrawSubmission('tok', 's-1', 'me-secret')).rejects.toThrow(/стала аргументом проекта/);
    expect(s.prisma._submissions()).toHaveLength(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: имя не уезжает туда, где его не показывают', async () => {
    // Заявки отдавались с participant: true, хотя экран имя у них не
    // рисует. Невидимая на странице выдача.
    //
    // ПОПРАВКА, Пункт [leak-was-checked-by-regexp] 2026-09-30. Прежде
    // здесь стояла регулярка по исходнику, и у неё было два изъяна
    // разом. Первый: она искала ОДНУ форму записи — `include: {
    // participant: true }` — рядом с `select`, а Prisma запрещает
    // `select` и `include` вместе, то есть ловимую форму нельзя было
    // даже скомпилировать. Второй: реалистичная утечка
    // (`participant: { select: { displayName: true } }` ВНУТРИ
    // `select`, ровно как у соседнего комментария) проходила мимо.
    // Проверка была написана на форму записи, а не на то, дойдёт ли
    // имя до ответа. Теперь спрашивается ответ.
    //
    // Смотреть надо в ПУБЛИЧНОЕ чтение, а не в соседний метод
    // `listSubmissions` — тот для АВТОРА проекта, за гвардом, и там имя
    // на месте по праву.
    const s = setup();
    s.prisma._seedSubmission({ participantId: 'me', text: 'аргумент', status: 'PENDING' });

    const view: any = await s.service.publicView('tok');
    const submission = view.submissions[0];

    // Закрытый список полей, а не «нет одного известного поля»: любое
    // новое поле в публичной выдаче заявки обязано быть названо здесь.
    expect(Object.keys(submission).sort()).toEqual(
      ['createdAt', 'downvotes', 'id', 'mine', 'stance', 'status', 'text', 'upvotes'].sort(),
    );
    expect(submission.participant).toBe(undefined);
    // И обратная половина того же вопроса: у комментария имя ДОЛЖНО
    // дойти — иначе этот тест был бы зелен и на сервисе, который не
    // отдаёт ничего.
    s.prisma._seedComment({ participantId: 'me', text: 'мой' });
    const withComment: any = await s.service.publicView('tok');
    expect(withComment.comments[0].authorName).toBe('Пётр');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у комментариев имя ОСТАЁТСЯ — его там показывают', async () => {
    // Обратная половина: убрать имя и оттуда значило бы сломать
    // подпись, которую человек сам поставил и которую видит на экране.
    //
    // ПОПРАВКА, Пункт [badge-was-the-key] 2026-09-24. Прежде здесь
    // утверждалось наличие строки `include: { participant: true }` в
    // исходнике — то есть МЕХАНИЗМ, а не результат. Такая проверка
    // запрещает любое сужение выборки, даже правильное, и при этом
    // ничего не говорит о том, дойдёт ли имя до страницы. Теперь
    // спрашивается результат.
    const s = setup();
    s.prisma._seedComment({ participantId: 'me', text: 'мой' });

    const view: any = await s.service.publicView('tok');

    expect(view.comments[0].authorName).toBe('Пётр');
  });
});

// Пункт [the-open-door-had-no-counter] 2026-09-30 — у публичной двери не
// было счётчика.
//
// ЧТО ПРОВЕРЯЕТСЯ. Потолок СРАБАТЫВАЕТ (вызовом, а не чтением
// исходника), ноль его отключает, отказ говорит человеческим текстом, и
// ни один публичный маршрут записи не остался без записи в реестре.
//
// ЧЕГО ЗДЕСЬ НЕТ. Проверки, что потолок нельзя обойти: обойти его можно
// — заводя новых участников подряд, — и это записано словами, а не
// закрыто зелёным.

import { BadRequestException } from '@nestjs/common';

import {
  PUBLIC_WRITE_LIMITS,
  PUBLIC_WRITE_NOT_LIMITED_HERE,
  assertUnderPublicWriteLimit,
  publicWriteLimit,
} from '../common/public-write-limits';
import { LibraryService } from '../library/library.service';
import { PublicDiscussionService } from '../public-discussion/public-discussion.service';
import { ceilingsState } from '../admin-db-state/spend-ceilings-state';

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

/** Фейк обсуждения: считает столько, сколько скажут, и записывает, что
 *  создали. */
function discussion(counts: Record<string, number>) {
  const created: string[] = [];
  const counter = (model: string) => ({
    count: async () => counts[model] ?? 0,
    create: async () => {
      created.push(model);
      return { id: `${model}-1` };
    },
  });
  const prisma = {
    project: { findFirst: async () => ({ id: 'proj-1', publicShareToken: 't' }) },
    publicParticipant: counter('publicParticipant'),
    publicArgumentSubmission: counter('publicArgumentSubmission'),
    publicComment: counter('publicComment'),
  };
  return { service: new PublicDiscussionService(prisma as never, {} as never), created, prisma };
}

describe('[the-open-door-had-no-counter] потолки публичной записи', () => {
  it('проба механизма: заглушка обсуждения и правда считает и правда создаёт', () => {
    // Проба ТОЙ ЖЕ машинерии, на которой стоят ключевые тесты ниже:
    // если `discussion()` не считает или не записывает создание, «на
    // потолке не создалось» зеленело бы само собой.
    const fake = discussion({ publicParticipant: 7 });
    expect(fake.created).toEqual([]);
    return fake.prisma.publicParticipant.count().then(async (n) => {
      expect(n).toBe(7);
      await fake.prisma.publicParticipant.create();
      expect(fake.created).toEqual(['publicParticipant']);
      // И потолки читаются: умолчания не нулевые, иначе всё ниже
      // проходило бы через отключённый потолок.
      // 2026-09-30, Пункт [the-ceiling-lived-in-two-places]: стало
      // семь. Прибавились комментарии заказчика по ссылке на вычитку
      // вакансии — их потолок существовал зашитым числом 100 прямо в
      // `vacancy-posting.service.ts` и не значился ни в реестре, ни на
      // экране оператора.
      expect(PUBLIC_WRITE_LIMITS.length).toBe(7);
      expect(PUBLIC_WRITE_LIMITS.filter((l) => publicWriteLimit(l.key).value !== l.fallback)).toEqual([]);
      expect(PUBLIC_WRITE_LIMITS.filter((l) => l.fallback <= 0)).toEqual([]);
    });
  });

  it('КЛЮЧЕВОЙ ТЕСТ: на потолке запись отклоняется, под потолком — принимается', async () => {
    const calls: number[] = [];
    const under = assertUnderPublicWriteLimit('comments-per-participant', async () => {
      calls.push(1);
      return 99;
    });
    await expect(under).resolves.toBeUndefined();

    let refused: unknown = null;
    try {
      await assertUnderPublicWriteLimit('comments-per-participant', async () => 100);
    } catch (e) {
      refused = e;
    }
    expect(refused instanceof BadRequestException).toBe(true);
    // Проба: счёт и правда запрашивался, а не пропущен.
    expect(calls.length).toBe(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отказ написан человеку, а не оператору', async () => {
    for (const l of PUBLIC_WRITE_LIMITS) {
      let message = '';
      try {
        await assertUnderPublicWriteLimit(l.key, async () => l.fallback);
      } catch (e) {
        message = (e as BadRequestException).message;
      }
      expect(message).toBe(l.refusal);
      // Ни одного машинного слова: человек, упёршийся в потолок, ничего
      // плохого не сделал — он пришёл последним.
      expect(/limit|quota|rate|exceeded|[A-Z_]{4,}/.test(message)).toBe(false);
      expect(message.length > 40).toBe(true);
    }
  });

  it('ноль отключает потолок совсем', async () => {
    await withEnv('PUBLIC_COMMENTS_PER_DISCUSSION', '0', async () => {
      expect(publicWriteLimit('comments-per-discussion').value).toBe(0);
      await expect(
        assertUnderPublicWriteLimit('comments-per-discussion', async () => 1_000_000),
      ).resolves.toBeUndefined();
    });
  });

  it('опечатка в имени потолка падает громко, а не означает «без потолка»', () => {
    expect(() => publicWriteLimit('comments-per-discusion')).toThrow(/не описан/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: обсуждение и правда перестаёт принимать участников на потолке', async () => {
    const full = discussion({ publicParticipant: 200 });
    await expect(full.service.joinAsParticipant('t', 'Гость')).rejects.toThrow(/столько участников/);
    expect(full.created).toEqual([]);

    const room = discussion({ publicParticipant: 199 });
    await room.service.joinAsParticipant('t', 'Гость');
    expect(room.created).toEqual(['publicParticipant']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: потолок на участника считает ПО УЧАСТНИКУ, а не по обсуждению', async () => {
    const seen: unknown[] = [];
    const prisma = {
      project: { findFirst: async () => ({ id: 'proj-1' }) },
      publicParticipant: { findFirst: async () => ({ id: 'p-1', projectId: 'proj-1' }) },
      publicComment: {
        count: async ({ where }: { where: unknown }) => {
          seen.push(where);
          return 0;
        },
        create: async () => ({ id: 'c-1' }),
      },
    };
    const service = new PublicDiscussionService(prisma as never, {} as never);
    await service.addComment('t', 'текст', 'p-1');
    expect(seen).toEqual([{ projectId: 'proj-1' }, { projectId: 'proj-1', participantId: 'p-1' }]);
  });

  it('обратная проба: без участника личный потолок считается по АНОНИМНОЙ корзине', async () => {
    // ПЕРЕПИСАНО Пунктом [the-ceiling-asked-you-to-identify-yourself]
    // 2026-09-30, и это стоит прочитать целиком.
    //
    // Прежняя версия этой пробы утверждала: «без участника потолок „на
    // участника" не считается ВОВСЕ» — и была зелёной, потому что так и
    // было. То есть проба СМОТРЕЛА ПРЯМО НА ОБХОД и удостоверяла его как
    // ожидаемое поведение: клиент, не приславший необязательный
    // `participantId`, не попадал под личный потолок, и его держал только
    // общий (500 заявок, 1000 комментариев вместо 20 и 100).
    //
    // Проба была написана честно: она фиксировала то, что делает код.
    // Но записанное поведение никто не сверил с ОБЕЩАНИЕМ потолка —
    // «не больше N от одного», — а обещание обходилось пустым полем
    // бесплатно. Урок общий: обратная проба, закрепляющая наблюдение,
    // закрепляет и дефект, если рядом не спрошено «а так и должно
    // быть?».
    //
    // Теперь анонимные записи считаются одной корзиной того же размера,
    // и проба проверяет именно это: второй запрос счёта идёт с
    // `participantId: null`, а не отсутствует.
    const seen: unknown[] = [];
    const prisma = {
      project: { findFirst: async () => ({ id: 'proj-1' }) },
      publicComment: {
        count: async ({ where }: { where: unknown }) => {
          seen.push(where);
          return 0;
        },
        create: async () => ({ id: 'c-1' }),
      },
    };
    await new PublicDiscussionService(prisma as never, {} as never).addComment('t', 'текст');
    expect(seen).toEqual([{ projectId: 'proj-1' }, { projectId: 'proj-1', participantId: null }]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: публичная библиотека тоже перестаёт принимать на потолке', async () => {
    const make = (existing: number) => {
      const created: string[] = [];
      const prisma = {
        libraryEntry: { findFirst: async () => ({ id: 'e-1' }) },
        libraryExperience: {
          count: async () => existing,
          create: async () => {
            created.push('libraryExperience');
            return { id: 'x-1' };
          },
        },
      };
      return { service: new LibraryService(prisma as never, {} as never), created };
    };

    const full = make(300);
    await expect(full.service.addExperience('e-1', 'текст', 'Гость')).rejects.toThrow(/столько рассказов/);
    expect(full.created).toEqual([]);

    const room = make(299);
    await room.service.addExperience('e-1', 'текст', 'Гость');
    expect(room.created).toEqual(['libraryExperience']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: потолки публичной записи доезжают до оператора и считаются в общей тревоге', () => {
    const clean = ceilingsState();
    expect(clean.publicWrite.length).toBe(PUBLIC_WRITE_LIMITS.length);
    expect(clean.publicWrite.map((r) => r.env).sort()).toEqual(PUBLIC_WRITE_LIMITS.map((l) => l.env).sort());
    expect(clean.misconfigured).toBe(0);

    // Ошибка во ВТОРОЙ таблице обязана попасть в то же число: свой счёт
    // по первой таблице её не видел, и оператор не узнал бы о ней.
    const broken = withEnv('PUBLIC_COMMENTS_PER_DISCUSSION', 'много', () => ceilingsState());
    expect(broken.misconfigured).toBe(1);
    expect(broken.publicWrite.find((r) => r.env === 'PUBLIC_COMMENTS_PER_DISCUSSION')?.raw).toBe('много');

    // И «без потолка» из второй таблицы — в том же счётчике снятых.
    const off = withEnv('PUBLIC_COMMENTS_PER_DISCUSSION', '0', () => ceilingsState());
    expect(off.off).toBe(1);
  });

  it('записано, чего эти потолки НЕ делают', () => {
    // 2026-09-30, Пункт [measured-three-said-none]: стало шесть. Две
    // новые строки называют то, чего этот реестр НЕ покрывает:
    // публичную анкету кандидата (её держит одноразовость ссылки) и
    // отзыв согласия по той же ссылке (его упирать в потолок нельзя).
    // Прежде список молчал о том, что половина публичных поверхностей
    // записи не считается — а сам объявлен как страховка «на случай,
    // если следующий читатель решит, что публичная дверь защищена».
    // Седьмая строка добавлена Пунктом
    // [the-ceiling-asked-you-to-identify-yourself] 2026-09-30: она
    // называет размен анонимной корзины (одна на обсуждение, не на
    // человека).
    expect(PUBLIC_WRITE_NOT_LIMITED_HERE.length).toBe(7);
    expect(PUBLIC_WRITE_NOT_LIMITED_HERE.filter((s) => s.trim().length === 0)).toEqual([]);
    // Самое важное из непокрытого названо прямо: потолок обходится
    // новыми участниками.
    expect(PUBLIC_WRITE_NOT_LIMITED_HERE.some((s) => s.includes('заводить новых участников'))).toBe(true);
  });
});

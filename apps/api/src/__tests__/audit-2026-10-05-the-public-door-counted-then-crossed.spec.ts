// Пункт [the-public-door-counted-then-crossed] 2026-10-05 — та же
// болезнь у потолков ПУБЛИЧНОЙ записи.
//
// НАЙДЕННОЕ. Днём раньше Пункт [the-ceiling-was-counted-then-crossed]
// измерил на живом Postgres 16, что «посчитать, сравнить, вставить»
// тремя обращениями не держит потолок вовсе: двадцать одновременных
// попыток при потолке пять дают двадцать записей, под замком — пять.
// Шесть потолков публичной записи устроены ровно так же: проверка
// `assertUnderPublicWriteLimit`, а запись — следующим, отдельным
// обращением.
//
// ЦЕНА ЗДЕСЬ НЕ ДЕНЬГИ, А СМЫСЛ ПОТОЛКА. Каждый из них заведён затем,
// чтобы очередь разобрал человек: «модерация заявок — ручная работа
// владельца; неограниченная очередь означает, что её не сделают
// никогда». Потолок, не держащий при одновременных запросах, — это
// неисполненное обещание человеку, что его прочитают. И дверь
// ПУБЛИЧНАЯ: одновременность достигает любой, кто знает ссылку, без
// аутентификации и без цены.
//
// ЧЕСТНАЯ ГРАНИЦА. Настоящая одновременность на фейковой БД не
// проверяется ничем — замок это семантика Postgres. Здесь проверяется,
// что счёт и запись идут ОДНОЙ транзакцией и что замок берётся первым;
// доказательство, что такая форма держит потолок, получено прогоном на
// живом Postgres и записано числами в `TODO.md`.

import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { insertUnderPublicWriteLimit, PUBLIC_WRITE_LIMITS } from '../common/public-write-limits';
import { withCeilingLock } from '../common/ceiling-lock';

const API_SRC = path.join(__dirname, '..');
const code = (rel: string) => fs.readFileSync(path.join(API_SRC, rel), 'utf8');
const withoutComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function makePrisma(rowsInScope: number) {
  const trace: string[] = [];
  let rows = rowsInScope;
  const tx: Record<string, unknown> = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      trace.push('tx.lock');
      trace.push(`tx.lockKey:${String(values[0])}`);
      trace.push(`tx.sql:${strings.join('?')}`);
      return 1;
    }),
    publicComment: {
      count: jest.fn(async () => {
        trace.push('tx.count');
        return rows;
      }),
      create: jest.fn(async () => {
        trace.push('tx.create');
        rows += 1;
        return { id: 'c1' };
      }),
    },
  };
  const prisma = {
    _trace: trace,
    $transaction: jest.fn(async (body: (t: unknown) => Promise<unknown>, opts?: { timeout?: number }) => {
      trace.push(`transaction(timeout=${String(opts?.timeout)})`);
      return body(tx);
    }),
    // Внешний объект умеет то же самое — ровно затем, чтобы уход мимо
    // транзакции был ВИДЕН, а не упал на отсутствующем методе.
    publicComment: {
      count: jest.fn(async () => {
        trace.push('prisma.count');
        return rows;
      }),
      create: jest.fn(async () => {
        trace.push('prisma.create');
        return { id: 'c1' };
      }),
    },
  };
  return prisma;
}

/** Шаги без значений и без строки о самой транзакции: порядок внутри
 *  неё — вот предмет. Сравнение точное, список короткий. */
const steps = (trace: string[]) => trace.filter((t) => !t.includes(':') && !t.startsWith('transaction'));

/** Места, где проверка потолка стои́т БЕЗ записи рядом, и почему это
 *  допустимо. Реестр, а не «разрешаем везде»: проверка без записи — это
 *  два события, и каждое исключение обязано объясниться. */
const ASSERT_WITHOUT_INSERT: Array<{ file: string; key: string; why: string }> = [
  {
    file: 'vacancy-posting/vacancy-posting.service.ts',
    key: 'comments-per-posting-review',
    why:
      'запись здесь САМА атомарна и САМА держит потолок: один UPDATE с проверкой длины массива в условии ' +
      '(posting-review-comments.ts, Пункт [two-comments-one-survived]). Этот вызов нужен только чтобы взять ТЕКСТ ОТКАЗА из реестра.',
  },
  {
    file: 'employer-hiring/engagement.service.ts',
    key: 'comments-per-posting-review',
    why:
      'тот же атомарный помощник на той же колонке, второй путь к ней — внутренний, которым комментирует работодатель ' +
      '(Пункт [the-atomic-fix-stayed-on-one-path]). Потолок держит сам UPDATE, вызов нужен только для текста отказа.',
  },
  {
    file: 'public-discussion/public-discussion.service.ts',
    key: 'submissions-per-participant и comments-per-participant',
    why:
      'личные потолки считаются ВНУТРИ замка обсуждения, по той же транзакции tx. Брать второй замок по участнику значило бы ' +
      'завести порядок взятия двух замков, то есть способ получить взаимную блокировку.',
  },
];

describe('[the-public-door-counted-then-crossed] потолок публичной записи и запись — одно событие', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: замок берётся первым, счёт и запись идут по tx, мимо транзакции — ничего', async () => {
    const prisma = makePrisma(0);
    await insertUnderPublicWriteLimit(
      prisma as never,
      'comments-per-discussion',
      'proj-1',
      (tx) => tx.publicComment.count({ where: {} } as never),
      (tx) => tx.publicComment.create({ data: {} } as never),
    );
    expect(steps(prisma._trace)).toEqual(['tx.lock', 'tx.count', 'tx.create']);
    expect(prisma._trace[0].startsWith('transaction(timeout=')).toBe(true);
    expect(prisma._trace.filter((t) => t.startsWith('prisma.'))).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ключ замка включает И потолок, И область — разные обсуждения друг друга не ждут', async () => {
    const prisma = makePrisma(0);
    await insertUnderPublicWriteLimit(
      prisma as never,
      'comments-per-discussion',
      'proj-1',
      (tx) => tx.publicComment.count({ where: {} } as never),
      (tx) => tx.publicComment.create({ data: {} } as never),
    );
    const key = prisma._trace.find((t) => t.startsWith('tx.lockKey:'))!;
    expect(key).toBe('tx.lockKey:public|comments-per-discussion|proj-1');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: потолок достигнут → отказ из реестра и НИ ОДНОЙ записи', async () => {
    const limit = PUBLIC_WRITE_LIMITS.find((l) => l.key === 'comments-per-discussion')!;
    const prisma = makePrisma(limit.fallback);
    await expect(
      insertUnderPublicWriteLimit(
        prisma as never,
        'comments-per-discussion',
        'proj-1',
        (tx) => tx.publicComment.count({ where: {} } as never),
        (tx) => tx.publicComment.create({ data: {} } as never),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(steps(prisma._trace)).toEqual(['tx.lock', 'tx.count']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ноль отключает потолок — и тогда замок не берётся вовсе', async () => {
    const prisma = makePrisma(10_000);
    process.env.PUBLIC_COMMENTS_PER_DISCUSSION = '0';
    try {
      await insertUnderPublicWriteLimit(
        prisma as never,
        'comments-per-discussion',
        'proj-1',
        (tx) => tx.publicComment.count({ where: {} } as never),
        (tx) => tx.publicComment.create({ data: {} } as never),
      );
    } finally {
      delete process.env.PUBLIC_COMMENTS_PER_DISCUSSION;
    }
    // Запись прошла, транзакции и замка нет: «не ограничивай» значит не
    // ограничивай, а не «ограничивай бесконечностью под замком».
    expect(prisma._trace).toEqual(['prisma.create']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: замок живёт в ОДНОМ месте — сырой pg_advisory_xact_lock больше нигде', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file === 'common/ceiling-lock.ts') continue;
      if (/pg_advisory_xact_lock/.test(withoutComments(code(file)))) offenders.push(file);
    }
    // Две копии замка — это два таймаута и два ключа, которые разъедутся.
    expect(offenders).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: проверка БЕЗ записи осталась только там, где объявлена причина', () => {
    const declared = new Set(ASSERT_WITHOUT_INSERT.map((a) => a.file));
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file === 'common/public-write-limits.ts') continue;
      if (!/assertUnderPublicWriteLimit\(/.test(withoutComments(code(file)))) continue;
      if (!declared.has(file)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    for (const a of ASSERT_WITHOUT_INSERT) expect([a.file, a.why.length > 120]).toEqual([a.file, true]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: все шесть потолков обсуждений и библиотеки идут через запись под потолком', () => {
    const files = ['public-discussion/public-discussion.service.ts', 'library/library.service.ts'];
    for (const f of files) {
      const src = withoutComments(code(f));
      expect([f, /insertUnderPublicWriteLimit\(/.test(src)]).toEqual([f, true]);
    }
    // И ни одна запись публичной поверхности не осталась снаружи: счёт
    // вызовов сверяется с числом потолков, которые их требуют.
    const discussion = withoutComments(code(files[0]));
    expect((discussion.match(/insertUnderPublicWriteLimit\(/g) ?? []).length).toBe(3);
  });

  it('ОБРАТНАЯ ПРОБА: тот же обход находит сырой замок в подложенном тексте', () => {
    // Иначе «нигде больше нет» означало бы сломанный разбор.
    expect(/pg_advisory_xact_lock/.test(withoutComments('await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;'))).toBe(true);
    // А в КОММЕНТАРИИ — не находит: шапка `outward-spend.ts` называет
    // замок по имени, объясняя, почему он переехал.
    expect(/pg_advisory_xact_lock/.test(withoutComments('// ЧЕМ СДЕЛАНО. `pg_advisory_xact_lock` по паре\n'))).toBe(false);
    expect(sourceFiles().length).toBeGreaterThan(400);
  });

  it('ОБРАТНАЯ ПРОБА: тот же проход через withCeilingLock берёт замок и на пустом теле', async () => {
    const prisma = makePrisma(0);
    await withCeilingLock(prisma as never, 'проба|область', async () => undefined);
    expect(prisma._trace.find((t) => t.startsWith('tx.lockKey:'))).toBe('tx.lockKey:проба|область');
    expect(prisma._trace.find((t) => t.startsWith('tx.sql:'))).toContain('hashtextextended');
  });
});

function sourceFiles(dir: string = API_SRC, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(path.relative(API_SRC, full));
  }
  return out;
}

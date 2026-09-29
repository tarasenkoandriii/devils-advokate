// Сверка чтений без потолка 2026-09-04.
//
// 318 вызовов `findMany` без `take` и 19 с потолком, который молчит.
// Опаснее всего сочетание «растит посторонний + читается целиком»: заявки
// и комментарии публичного обсуждения пишет любой, у кого есть ссылка, а
// `publicView()` отдавал их все и сразу, при каждом открытии страницы
// каждым участником.
//
// Но главный инвариант этого захода не про объём, а про честность:
// **обрезанный список обязан говорить, что он обрезан**. Список, молча
// показанный не полностью, читается как полный — модератор решает, что
// рассмотрел все заявки; оператор по журналу решает, что такого действия
// не было. Это тот же дефект, который заход [silent-failure-sweep]
// закрывал для пустых экранов, только про объём.

import { DEFAULT_PAGE_LIMIT, pagedList, takeWithProbe } from '../common/page';
import { AuditLogService } from '../audit-log/audit-log.service';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

/** Фейк журнала: важно только сколько строк вернула база и что отдал сервис. */
function auditFake(rowCount: number) {
  const queries: any[] = [];
  const prisma: any = {
    user: { findUnique: async () => ({ isOperator: true }) },
    auditLogEntry: {
      findMany: async (args: any) => {
        queries.push(args);
        const take = args.take ?? rowCount;
        return Array.from({ length: Math.min(rowCount, take) }, (_, i) => ({
          id: `e-${i}`,
          resource: 'User',
          action: 'user.restricted',
          createdAt: new Date(),
        }));
      },
    },
  };
  return { svc: new AuditLogService(prisma), queries };
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('КЛЮЧЕВОЙ ТЕСТ: список, обрезанный потолком, честно говорит об этом', async () => {
    const rows = Array.from({ length: DEFAULT_PAGE_LIMIT + 1 }, (_, i) => i);
    const page = pagedList(rows);
    assertEqual(page.items.length, DEFAULT_PAGE_LIMIT, 'отдаётся ровно потолок, не потолок+1');
    assertEqual(page.hasMore, true, 'и сказано, что за ним есть ещё');
    assertEqual(page.limit, DEFAULT_PAGE_LIMIT, 'потолок назван — клиенту не нужно его угадывать');
  });

  test('список ровно в потолок — это «показано всё», а не «возможно, есть ещё»', async () => {
    // Граница именно точная: если бы «есть ещё» ставилось при ==, каждый
    // полный экран пугал бы человека несуществующим продолжением.
    const page = pagedList(Array.from({ length: DEFAULT_PAGE_LIMIT }, (_, i) => i));
    assertEqual(page.hasMore, false, 'ровно потолок — это полный список');
    assertEqual(page.items.length, DEFAULT_PAGE_LIMIT, 'ничего не отрезано');
  });

  test('короткий список не обрастает флагами: hasMore=false и все строки на месте', async () => {
    const page = pagedList([1, 2, 3]);
    assertEqual(page.items, [1, 2, 3], 'строки как есть');
    assertEqual(page.hasMore, false, 'ничего не скрыто');
  });

  test('у базы спрашивается на одну строку больше — иначе «есть ещё» пришлось бы считать вторым запросом', async () => {
    assertEqual(takeWithProbe(), DEFAULT_PAGE_LIMIT + 1, 'потолок по умолчанию + 1');
    assertEqual(takeWithProbe(10), 11, 'и для явно заданного потолка тоже');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: журнал аудита перестал молчать о своём потолке', async () => {
    // Потолок в 200 записей стоял здесь с самого начала и не был назван в
    // ответе. По журналу разбирают жалобу: список, выглядящий полным, —
    // основание для вывода «такого действия не было».
    const many = auditFake(DEFAULT_PAGE_LIMIT + 50);
    const page = await many.svc.list('op-1');
    assertEqual(page.items.length, DEFAULT_PAGE_LIMIT, 'отдан потолок');
    assertEqual(page.hasMore, true, 'и сказано, что записей больше');
    assertEqual(many.queries[0].take, DEFAULT_PAGE_LIMIT + 1, 'у базы запрошено на одну больше');

    const few = auditFake(3);
    const small = await few.svc.list('op-1');
    assertEqual(small.hasMore, false, 'короткий журнал не помечается обрезанным');
  });

  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  const failed = results.filter((r) => r.error);
  console.log(`\nПотолки списков: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

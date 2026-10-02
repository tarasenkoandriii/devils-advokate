// Пункт [the-poller-polled-it-twice] 2026-10-02 — опрос асинхронных
// задач мог обработать одну задачу дважды.
//
// НАЙДЕННОЕ. Комментарий в `pollRunning` утверждал «кто поднял — тот и
// опрашивает». Вне транзакции это неправда: блокировка строки живёт
// ровно до конца `UPDATE`, а дальше цикл СЕКУНДАМИ ждёт провайдера на
// каждой задаче. Единственной защитой оставался `ORDER BY "updatedAt"
// LIMIT`, и он помогает ТОЛЬКО когда RUNNING-задач больше лимита — то
// есть защищал загруженный случай и не защищал обычный. Второй
// вызывающий не теоретический: операторская «Диагностика» зовёт тот же
// путь вне расписания.
//
// ЧЕМ ЭТО КОНЧАЛОСЬ. Два опроса одной задачи → два `AIInference`, два
// перевода в COMPLETED и два `notifyCompletion`. У паралингвистики это
// значит повторную запись сигналов о человеке и двойной
// `releaseConsumer`, а он может удалить аудио, пока вебхук расшифровки
// его ещё ждёт.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ЧЕГО ЭТА СПЕКА НЕ УМЕЕТ. Забор — предикат
// Postgres, и `SKIP LOCKED` на фейковой БД не проверяется ничем: та же
// честная граница уже записана в шапке `ai-router-async.spec.ts`.
// Поэтому механически проверяется ФОРМА запроса (условие стоит во
// ВЛОЖЕННОМ отборе, окно передаётся параметром и равно
// `POLL_CLAIM_MS`, запрос не трогает срок аренды), отдельно —
// СООТНОШЕНИЕ окна с расписанием ПО РЕЕСТРУ, а не по комментарию, и
// отдельно, уже поведением, — что поднятый опросом `updatedAt` не
// прячет зависшую задачу от сторожевой. Настоящая проверка двойного
// забора возможна только против живой БД.
//
// ЧТО ОСТАЛОСЬ ОТКРЫТЫМ, И ЭТО НАЗВАНО В КОДЕ: проход по одной задаче
// длиннее окна по-прежнему даёт второму вызывающему её подобрать.
// Закрыть полностью можно только отдельной колонкой-замком с
// владельцем и TTL, то есть миграцией.

import { AIRouterService, POLL_CLAIM_MS } from '../ai-router/ai-router.service';
import { EXPECTED_CRON_JOBS } from '../admin-db-state/expected-cron-jobs';

/** Имя задания опроса в реестре расписаний. */
const POLL_JOB = 'ai-jobs-poll';

interface Recorded {
  sql: string;
  values: unknown[];
}

/** Фейк, записывающий ТЕКСТ запроса и ПРИВЯЗАННЫЕ значения отдельно:
 *  окно забора уходит параметром, и без значений проверить можно было
 *  бы только наличие знака вопроса. */
function makeDeps(jobs: Array<Record<string, unknown>> = []) {
  const recorded: Recorded[] = [];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const prisma = {
    $queryRaw: jest.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<{ id: string }>> => {
        recorded.push({ sql: strings.join('?'), values });
        return [];
      },
    ),
    aIJob: {
      // Фильтр читается ИЗ `where` механически: поле отбора не зашито в
      // фейк, поэтому отбор по ДРУГОМУ полю фикстуру не пройдёт.
      findMany: jest.fn(async ({ where, take }: any): Promise<any[]> => {
        const statuses: string[] = where?.status?.in ?? [];
        const dateKeys = Object.keys(where ?? {}).filter((k) => k !== 'status');
        return jobs
          .filter((j) => statuses.includes(j.status as string))
          .filter((j) =>
            dateKeys.every((k) => {
              const cond = where[k] as { lt?: Date } | undefined;
              if (!cond || typeof cond !== 'object' || !('lt' in cond)) return true;
              const value = j[k];
              return value instanceof Date && value.getTime() < (cond.lt as Date).getTime();
            }),
          )
          .slice(0, take ?? jobs.length);
      }),
      update: jest.fn(async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        return { id: where.id };
      }),
    },
  };
  return { prisma, recorded, updates };
}

function makeRouter(deps: ReturnType<typeof makeDeps>) {
  return new AIRouterService(deps.prisma as any, {} as any, {} as any, {} as any, {} as any);
}

/** Запрос опроса RUNNING-задач среди записанных. */
function pollStatement(recorded: Recorded[]): Recorded {
  const found = recorded.find((r) => r.sql.includes("status = 'RUNNING'"));
  if (!found) throw new Error('запрос опроса RUNNING не отправлялся вовсе');
  return found;
}

/** Текст ВЛОЖЕННОГО отбора — от `WHERE id IN (` до парной скобки.
 *  Глубина считается, а не берётся первая закрывающая: внутри отбора
 *  есть свои скобки. */
function nestedSelect(sql: string): string {
  const head = 'WHERE id IN (';
  const start = sql.indexOf(head);
  if (start < 0) throw new Error('вложенного отбора в запросе нет');
  let depth = 1;
  let i = start + head.length;
  for (; i < sql.length && depth > 0; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') depth--;
  }
  return sql.slice(start + head.length, i - 1);
}

/** Значение, привязанное к последнему `?` маркера: номер параметра —
 *  это число знаков вопроса до конца маркера, а не догадка о порядке
 *  аргументов. */
function boundAt(entry: Recorded, marker: string): unknown {
  const at = entry.sql.indexOf(marker);
  if (at < 0) throw new Error(`в запросе нет «${marker}»`);
  const n = (entry.sql.slice(0, at + marker.length).match(/\?/g) ?? []).length;
  return entry.values[n - 1];
}

/** Период задания из cron-выражения, в минутах. Разбирается только то,
 *  что реестр действительно содержит; всё прочее — отказ, а не
 *  молчаливое «одна минута». */
function cronPeriodMinutes(schedule: string): number {
  const minute = schedule.trim().split(/\s+/)[0];
  if (minute === '*') return 1;
  const every = /^\*\/(\d+)$/.exec(minute);
  if (every) return Number(every[1]);
  throw new Error(`минутное поле «${minute}» этот разбор не понимает`);
}

const WINDOW_MARKER = "interval '1 millisecond' * ?";

describe('[the-poller-polled-it-twice] опрос забирает задачу себе', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: условие забора стоит во ВЛОЖЕННОМ отборе — иначе LIMIT считал бы строки, которые забрать нельзя', async () => {
    const deps = makeDeps();
    await makeRouter(deps).pollRunning(10);
    const inner = nestedSelect(pollStatement(deps.recorded).sql);
    expect(inner).toContain('"updatedAt" <');
    expect(inner).toContain(WINDOW_MARKER);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: окно забора — это POLL_CLAIM_MS параметром, а тот же запрос поднимает updatedAt (забор ЗАПИСЫВАЕТСЯ, а не только читается)', async () => {
    const deps = makeDeps();
    await makeRouter(deps).pollRunning(10);
    const poll = pollStatement(deps.recorded);
    expect(boundAt(poll, WINDOW_MARKER)).toBe(POLL_CLAIM_MS);
    expect(poll.sql.trim().startsWith('UPDATE ai_jobs SET "updatedAt" = now()')).toBe(true);
    expect(poll.sql).toContain('RETURNING id');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: запрос опроса НЕ трогает срок аренды — иначе зависшая задача стала бы невидимой для сторожевой навсегда', async () => {
    const deps = makeDeps();
    await makeRouter(deps).pollRunning(10);
    expect(pollStatement(deps.recorded).sql).not.toContain('leaseExpiresAt');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: окно КОРОЧЕ периода опроса — соотношение берётся из реестра расписаний, а не из комментария', () => {
    const job = EXPECTED_CRON_JOBS.find((j) => j.jobname === POLL_JOB);
    expect(job).toBeDefined();
    const periodMs = cronPeriodMinutes(job!.schedule) * 60 * 1000;
    // Окно не короче периода означало бы, что очередной тик не может
    // опросить то, что забрал предыдущий, и готовый ответ ждёт круг.
    expect(POLL_CLAIM_MS).toBeLessThan(periodMs);
    expect(POLL_CLAIM_MS).toBeGreaterThan(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (поведение): поднятый опросом updatedAt НЕ прячет зависшую задачу от сторожевой — она по-прежнему идёт по сроку аренды', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const deps = makeDeps([
      // Зависшая: аренда истекла, а updatedAt только что поднят опросом.
      { id: 'stuck', status: 'RUNNING', taskType: null, pendingRequest: { userId: 'u' }, leaseExpiresAt: past, updatedAt: new Date() },
      // Живая: аренда цела, а updatedAt давний — отбор по updatedAt
      // подобрал бы именно её.
      { id: 'alive', status: 'RUNNING', taskType: null, pendingRequest: { userId: 'u' }, leaseExpiresAt: future, updatedAt: past },
    ]);

    const res = await makeRouter(deps).reapExpired();

    expect(res.reaped).toBe(1);
    expect(deps.updates.map((u) => u.id)).toEqual(['stuck']);
  });

  it('ОБРАТНАЯ ПРОБА: тот же разбор не находит условие, вынесенное НАРУЖУ вложенного отбора', () => {
    const outside = `
      UPDATE ai_jobs SET "updatedAt" = now()
      WHERE id IN (
        SELECT id FROM ai_jobs
        WHERE status = 'RUNNING' AND "externalInteractionId" IS NOT NULL
        ORDER BY "updatedAt"
        LIMIT ?
        FOR UPDATE SKIP LOCKED
      )
        AND "updatedAt" < now() - ${WINDOW_MARKER}
      RETURNING id`;
    const inner = nestedSelect(outside);
    expect(inner).toContain("status = 'RUNNING'");
    expect(inner).not.toContain(WINDOW_MARKER);
    // Иначе зелёный ключевой тест означал бы не форму запроса, а то, что
    // разбор берёт весь текст и условие нашлось бы где угодно.
    expect(outside).toContain(WINDOW_MARKER);
  });

  it('ОБРАТНАЯ ПРОБА: boundAt привязывает значение к маркеру, а не к первому параметру', () => {
    const entry: Recorded = { sql: `LIMIT ? AND x < now() - ${WINDOW_MARKER}`, values: [10, POLL_CLAIM_MS] };
    expect(boundAt(entry, WINDOW_MARKER)).toBe(POLL_CLAIM_MS);
    expect(boundAt(entry, 'LIMIT ?')).toBe(10);
  });

  it('ОБРАТНАЯ ПРОБА: то же сравнение падает, если период расписания короче окна', () => {
    expect(cronPeriodMinutes('*/3 * * * *')).toBe(3);
    expect(cronPeriodMinutes('* * * * *')).toBe(1);
    // Минутное расписание сделало бы двухминутное окно неверным — и
    // ключевой тест выше это бы увидел.
    expect(POLL_CLAIM_MS).toBeGreaterThanOrEqual(cronPeriodMinutes('* * * * *') * 60 * 1000);
    expect(() => cronPeriodMinutes('0,30 * * * *')).toThrow();
  });

  it('ОБРАТНАЯ ПРОБА: фейк сторожевой действительно фильтрует — задача с целой арендой не подбирается', async () => {
    const deps = makeDeps([
      { id: 'alive', status: 'RUNNING', taskType: null, pendingRequest: { userId: 'u' }, leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000), updatedAt: new Date() },
    ]);
    const res = await makeRouter(deps).reapExpired();
    expect(res.reaped).toBe(0);
    expect(deps.updates).toEqual([]);
  });
});

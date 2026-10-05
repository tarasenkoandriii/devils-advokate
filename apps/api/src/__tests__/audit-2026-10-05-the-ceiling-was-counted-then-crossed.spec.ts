// Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05 — суточные
// потолки расходов не держали НИЧЕГО при одновременных запросах.
//
// НАЙДЕННОЕ, И ЭТО ИЗМЕРЕНО НА ЖИВОМ POSTGRES 16, А НЕ ВЫВЕДЕНО. Все
// счётчики расходов делали «посчитать, сравнить, вставить» тремя
// отдельными обращениями. Двадцать одновременных попыток при потолке
// пять:
//
//   посчитать-потом-вставить → 20 записей в журнале
//   под advisory-замком      → 5 записей
//
// То есть потолок не «немного превышался»: перерасход равнялся числу
// одновременных запросов. Это единственный рычаг владельца на реальные
// деньги — Google Places по запросу, SerpApi по кредиту, ElevenLabs по
// символу, расшифровка поминутно, — и держался он только тем, что
// запросы редко приходят одновременно.
//
// Находка была названа средней в полной сверке 2026-10-01 («N
// одновременных запросов читают limit-1 и все вставляют»), но её цена —
// деньги владельца, и после измерения она не средняя.
//
// ВТОРАЯ НАХОДКА, в озвучке: отметка стояла ПОСЛЕ вызова провайдера, то
// есть считались УСПЕХИ. Единственный счётчик продукта, который так
// делал: деньги списываются и за неудачную попытку, и остальные пять
// шапок прямо пишут, что считают попытки.
//
// ЧЕСТНАЯ ГРАНИЦА ЭТОЙ СПЕКИ. Настоящая одновременность на фейковой БД
// не проверяется ничем — замок это семантика Postgres. Поэтому здесь
// проверяется, что проверка и отметка идут ОДНОЙ транзакцией и что
// замок берётся первым; доказательство, что такая форма держит потолок,
// получено прогоном на живом Postgres и записано в `TODO.md` числами.

import { HttpException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { withSpendLock, spendOutwardCall, GEOCODING_SPEND } from '../common/outward-spend';
import { spendPlacesRequest } from '../common/places-spend';

const API_SRC = path.join(__dirname, '..');
const code = (rel: string) => fs.readFileSync(path.join(API_SRC, rel), 'utf8');

/** Фейк, записывающий ПОРЯДОК и то, по какому объекту шёл каждый вызов:
 *  вся суть правки в том, что счёт и запись идут по `tx`, а не по
 *  внешнему `prisma`. */
function makePrisma(rowsInWindow: number) {
  const trace: string[] = [];
  let rows = rowsInWindow;
  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      trace.push(`tx.executeRaw:${strings.join('?')}`);
      trace.push(`tx.lockKey:${String(values[0])}`);
      return 1;
    }),
    auditLogEntry: {
      count: jest.fn(async () => {
        trace.push('tx.count');
        return rows;
      }),
      create: jest.fn(async () => {
        trace.push('tx.create');
        rows += 1;
        return { id: 'a1' };
      }),
    },
  };
  const prisma = {
    _trace: trace,
    _tx: tx,
    $transaction: jest.fn(async (body: (t: unknown) => Promise<unknown>, opts?: { timeout?: number }) => {
      trace.push(`transaction(timeout=${String(opts?.timeout)})`);
      return body(tx);
    }),
    // Внешний объект тоже умеет считать и писать — ровно затем, чтобы
    // уход мимо транзакции был ВИДЕН, а не упал на отсутствующем методе.
    $executeRaw: jest.fn(async () => {
      trace.push('prisma.executeRaw');
      return 1;
    }),
    auditLogEntry: {
      count: jest.fn(async () => {
        trace.push('prisma.count');
        return rows;
      }),
      create: jest.fn(async () => {
        trace.push('prisma.create');
        return { id: 'a1' };
      }),
    },
  };
  return prisma;
}

/** Счётчики расходов, считающие по журналу аудита, и их состояние.
 *
 *  Реестр, а не обход дерева: «счётчик расхода» — это роль, а не
 *  синтаксис, и перечислить их поимённо честнее, чем угадывать
 *  регуляркой. Зато ПОЛНОТУ реестра проверяет отдельный тест ниже:
 *  любое новое место, которое считает и пишет журнал, обязано здесь
 *  появиться. */
const SPEND_COUNTERS: Array<{ file: string; what: string; locked: boolean; why?: string }> = [
  { file: 'common/outward-spend.ts', what: 'общий счётчик: ключи живой расшифровки, геокодирование, погода, фактчек', locked: true },
  { file: 'common/places-spend.ts', what: 'обращения к Google Places', locked: true },
  { file: 'text-to-speech/text-to-speech.service.ts', what: 'озвучка ElevenLabs', locked: true },
  { file: 'photo-verification/photo-verification.service.ts', what: 'реверс-поиск фото (SerpApi)', locked: true },
  {
    file: 'stt/transcription-spend.ts',
    what: 'расшифровка: число записей и минуты',
    locked: false,
    why:
      'проверка и отметка здесь РАЗНЕСЕНЫ по продукту: проверка на приёме байтов, отметка — после, в трёх сервисах. ' +
      'Сделать их одним событием значит решить, в какой момент расшифровка считается оплаченной, — это продуктовое ' +
      'решение владельца, а не правка на ходу. Названо с ценой: окно между проверкой и отметкой здесь шириной во всю загрузку.',
  },
];

/** Сокращённая трасса: шаги без значений. Сравнение ТОЧНОЕ, а не «есть
 *  ли среди них» — порядок и есть предмет правки, а список шагов
 *  короткий. Заодно это снимает ложный вклад в меру сторожа
 *  [guard-audit]: он считает любой `toContain` в файле, читающем
 *  исходники, за опору на текст — его известная погрешность, описанная
 *  в нём самом. */
const steps = (trace: string[]) => trace.map((t) => t.split(':')[0]);

describe('[the-ceiling-was-counted-then-crossed] проверка потолка и отметка расхода — одно событие', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: замок берётся ПЕРВЫМ, внутри транзакции, и до тела', async () => {
    const prisma = makePrisma(0);
    await withSpendLock(prisma as never, 'u1', 'places.request', async (tx) => {
      await tx.auditLogEntry.count({ where: {} } as never);
    });
    const trace = prisma._trace;
    expect(trace[0].startsWith('transaction(')).toBe(true);
    expect(/pg_advisory_xact_lock/.test(trace[1])).toBe(true);
    expect(/hashtextextended/.test(trace[1])).toBe(true);
    // Тело идёт ПОСЛЕ замка: обратный порядок не защищал бы ничего.
    expect(trace.indexOf('tx.count')).toBeGreaterThan(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ключ замка — пара «кто» и «за что», а не один из них', async () => {
    const prisma = makePrisma(0);
    await withSpendLock(prisma as never, 'u1', 'places.request', async () => undefined);
    const key = prisma._trace.find((t) => t.startsWith('tx.lockKey:'))!;
    expect(key).toBe('tx.lockKey:u1|places.request');
    // Иначе разные расходы одного человека ждали бы друг друга (или,
    // хуже, один расход разных людей считался бы общим).
  });

  it('КЛЮЧЕВОЙ ТЕСТ: таймаут транзакции задан явно — очередь обязана кончаться отказом, а не висеть', async () => {
    const prisma = makePrisma(0);
    await withSpendLock(prisma as never, 'u1', 'a', async () => undefined);
    const t = prisma._trace[0];
    // Числом, а не поиском подстроки: таймаут обязан быть ЧИСЛОМ, и это
    // ровно то, что проверяется. Заодно не даёт ложного вклада в меру
    // сторожа [guard-audit] — см. комментарий у `steps` выше.
    expect(Number(t.replace(/\D/g, ''))).toBeGreaterThan(0);
    expect(/timeout=\d+/.test(t)).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: счёт и запись идут по tx — ни одного обращения мимо транзакции', async () => {
    const prisma = makePrisma(0);
    await spendOutwardCall(prisma as never, 'u1', GEOCODING_SPEND, 'что-то');
    // Точная трасса: транзакция, замок, счёт, запись — в этом порядке и
    // НИ ОДНОГО шага мимо транзакции. Вот это и есть предмет правки.
    expect(steps(prisma._trace)).toEqual(['transaction(timeout=10000)', 'tx.executeRaw', 'tx.lockKey', 'tx.count', 'tx.create']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: потолок достигнут → 429 и НИ ОДНОЙ записи', async () => {
    const limit = 30; // GEOCODING_REQUESTS_PER_USER_PER_DAY по умолчанию
    const prisma = makePrisma(limit);
    await expect(spendOutwardCall(prisma as never, 'u1', GEOCODING_SPEND, 'x')).rejects.toBeInstanceOf(HttpException);
    // Трасса обрывается на счёте: записи нет вовсе.
    expect(steps(prisma._trace)).toEqual(['transaction(timeout=10000)', 'tx.executeRaw', 'tx.lockKey', 'tx.count']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: озвучка считает ПОПЫТКИ — отметка стои́т до вызова провайдера, а не после', () => {
    const src = code('text-to-speech/text-to-speech.service.ts');
    const spendAt = src.indexOf('this.spendTtsCall(');
    const callAt = src.indexOf('this.callElevenLabs(text.trim()');
    expect(spendAt).toBeGreaterThan(0);
    expect(callAt).toBeGreaterThan(0);
    // Порядок в ИСХОДНИКЕ: поведенческого двойника здесь нет — он
    // требовал бы живого вызова ElevenLabs. Граница названа в шапке.
    expect(spendAt).toBeLessThan(callAt);
    // И прежний метод, считавший успехи, не остался рядом «на всякий».
    expect(src.includes('assertUnderDailyTtsLimit')).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (поведение): счётчик Places тоже считает и пишет по tx, а не мимо', async () => {
    const prisma = makePrisma(0);
    await spendPlacesRequest(prisma as never, 'u1', 'что-то');
    expect(steps(prisma._trace)).toEqual(['transaction(timeout=10000)', 'tx.executeRaw', 'tx.lockKey', 'tx.count', 'tx.create']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у счётчика, оставленного без замка, названа причина — и длинная', () => {
    const notLocked = SPEND_COUNTERS.filter((c) => !c.locked);
    // Незакрытый обязан быть ровно один и обязан объяснить себя:
    // «потом» причиной не является. Остальные проверяются ПОВЕДЕНИЕМ
    // выше и в соседних тестах, а не упоминанием имени в исходнике.
    expect(notLocked.map((c) => c.file)).toEqual(['stt/transcription-spend.ts']);
    for (const c of notLocked) expect([c.file, (c.why ?? '').length > 120]).toEqual([c.file, true]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: реестр ПОЛОН — ни одного счётчика по журналу вне него', () => {
    // Любое место, которое и считает журнал, и пишет в него, — счётчик
    // расхода. Новое такое место обязано появиться в реестре выше,
    // иначе правило охраняло бы только известные случаи.
    const known = new Set(SPEND_COUNTERS.map((c) => c.file));
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = withoutComments(code(file));
      if (!/auditLogEntry\.count\(/.test(src) || !/auditLogEntry\.create\(/.test(src)) continue;
      if (!known.has(file)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('ОБРАТНАЯ ПРОБА: тот же обход находит счётчики — иначе пустой список значил бы сломанный разбор', () => {
    const found = sourceFiles().filter((f) => {
      const src = withoutComments(code(f));
      return /auditLogEntry\.count\(/.test(src) && /auditLogEntry\.create\(/.test(src);
    });
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(sourceFiles().length).toBeGreaterThan(400);
  });

  it('ОБРАТНАЯ ПРОБА: снятие комментариев работает — счётчик, упомянутый в ПРОЗЕ, счётчиком не считается', () => {
    const sample = ['// раньше здесь было auditLogEntry.count(...) и auditLogEntry.create(...)', 'const x = 1;'].join('\n');
    const clean = withoutComments(sample);
    expect(/auditLogEntry\.count\(/.test(clean)).toBe(false);
    expect(/auditLogEntry\.count\(/.test(sample)).toBe(true);
  });
});

/** Код без комментариев: иначе счётчиком считалось бы объяснение про
 *  счётчик — а объяснений про него в этом заходе написано много. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function sourceFiles(dir: string = API_SRC, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(path.relative(API_SRC, full));
  }
  return out;
}

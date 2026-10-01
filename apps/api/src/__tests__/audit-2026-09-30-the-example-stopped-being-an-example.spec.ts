// Пункт [the-example-stopped-being-an-example] 2026-09-30 — обоснование,
// сославшееся на образец, который сам перестал так делать.
//
// НАЙДЕННОЕ. В шапке `TelemetryService` стояло: «Вычисление в JS, а не
// raw SQL GROUP BY/percentile_cont — тот же выбор тестируемости, что уже
// сделан в CalibrationService». К этому дню `CalibrationService` считает
// в базе через `groupBy`, и изменили его ИМЕННО ЗА ЭТО: сверка фоновых
// чтений записала «было: findMany без потолка по всей таблице — все
// подтверждённые исходы всех пользователей в память ради четырёх
// средних». То есть пример, приведённый в оправдание, к моменту чтения
// доказывал обратное.
//
// Это та же порода, что ловили два захода назад («утверждение о
// проверке перестало быть правдой»), но на шаг дальше: не утверждение о
// себе, а ССЫЛКА НА СОСЕДА. Сосед изменился — обоснование осталось, и
// заметить это можно только сверив два файла, чего не делает никто.
//
// ВТОРАЯ ПОЛОВИНА, про поведение. Чтение под сводкой шло БЕЗ ПОТОЛКА, а
// `from`/`to` необязательны: по умолчанию экран телеметрии читал ВСЮ
// таблицу `AIJob` — строка на каждый AI-вызов каждого пользователя,
// чистки нет. Числа при этом честные (итог по всему), но в пределе это
// не «медленно», а 504: агрегат считается внутри функции с потолком
// 60 с. Теперь выборка ограничена, упорядочена по свежести, и ответ
// НАЗЫВАЕТ покрытие. Это не «потолок, спрятанный внутри итога» (Пункт
// [ceiling-hid-inside-a-total]): там срез выдавали за целое, здесь срез
// назван вслух и печатается оператору.
//
// ТРЕТЬЕ: у проекта не было СПИСКА чтений, которые обязаны быть
// ограничены. Механизм честной обрезки есть с 2026-09-04, правило «кто
// взял зонд, тот обязан его съесть» — с 2026-09-24, а перечисления нет,
// значит новый экран с чтением всей таблицы появляется молча. Реестр —
// `common/growing-reads.ts`.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { ForbiddenException } from '@nestjs/common';
import { GROWING_READS, GROWING_READS_NOT_COVERED } from '../common/growing-reads';
import { TELEMETRY_MAX_JOBS, TelemetryService } from '../telemetry/telemetry.service';

const API_SRC = join(__dirname, '..');
const source = (rel: string) => readFileSync(join(API_SRC, rel), 'utf8');

/** Фейк: считает, с какими аргументами спросили задачи, и отдаёт столько
 *  строк, сколько попросили. */
function fakePrisma(totalJobs: number) {
  const calls: Array<{ take?: number; orderBy?: unknown }> = [];
  const base = new Date('2026-09-01T00:00:00.000Z');
  return {
    calls,
    user: { findUnique: async () => ({ isOperator: true }) },
    aIJob: {
      findMany: async (args: any) => {
        calls.push({ take: args?.take, orderBy: args?.orderBy });
        const take = args?.take ?? totalJobs;
        return Array.from({ length: Math.min(totalJobs, take) }, (_, i) => ({
          id: `j-${i}`,
          status: 'COMPLETED',
          retryCount: 0,
          schemaValidation: 'PASS',
          inputScanStatus: 'PASSED',
          taskType: 'argument-generation',
          modelVersionId: 'mv-1',
          createdAt: base,
          completedAt: new Date(base.getTime() + 1000),
        }));
      },
    },
    aIModelVersion: { findMany: async () => [{ id: 'mv-1', version: 'gpt-4.1' }] },
  };
}

describe('Пункт [the-example-stopped-being-an-example]: сводка телеметрии не читает всю таблицу', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: у чтения есть потолок и порядок по свежести', async () => {
    const prisma = fakePrisma(10);
    await new TelemetryService(prisma as never).getSummary('op');
    expect(prisma.calls.length).toBe(1);
    // Потолок с зондом: на одну строку больше, чтобы узнать про «есть
    // ещё» без второго запроса к базе.
    expect(prisma.calls[0].take).toBe(TELEMETRY_MAX_JOBS + 1);
    // Порядок обязателен: без него «последние N» — это произвольные N,
    // и агрегат говорит о случайной выборке, а не о недавней работе.
    // Второй ключ — уникальный столбец: требование сверки
    // [tie-is-random], и она поймала первую версию этой правки, где
    // стоял только createdAt. Задачи создаются пачками и попадают в одну
    // миллисекунду легко.
    expect(prisma.calls[0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: когда задач больше потолка — ответ говорит об этом, и зонд съеден', async () => {
    // Мутация «вернуть findMany без take» и мутация «не отдавать
    // coverage» обе падают здесь.
    const prisma = fakePrisma(TELEMETRY_MAX_JOBS + 500);
    const { rows, coverage } = await new TelemetryService(prisma as never).getSummary('op');
    expect(coverage.truncated).toBe(true);
    expect(coverage.limit).toBe(TELEMETRY_MAX_JOBS);
    // Зонд съеден: в расчёт ушёл ровно потолок, не потолок плюс один.
    expect(coverage.jobsCounted).toBe(TELEMETRY_MAX_JOBS);
    expect(rows[0].totalCalls).toBe(TELEMETRY_MAX_JOBS);
  });

  it('обратная проба: когда задач меньше потолка — truncated=false и посчитаны все', async () => {
    const prisma = fakePrisma(7);
    const { rows, coverage } = await new TelemetryService(prisma as never).getSummary('op');
    expect(coverage.truncated).toBe(false);
    expect(coverage.jobsCounted).toBe(7);
    expect(rows[0].totalCalls).toBe(7);
  });

  it('разбивка по моделям ограничена тем же потолком и тоже несёт покрытие', async () => {
    const prisma = fakePrisma(TELEMETRY_MAX_JOBS + 1);
    const { rows, coverage } = await new TelemetryService(prisma as never).getByModel('op');
    expect(prisma.calls[0].take).toBe(TELEMETRY_MAX_JOBS + 1);
    expect(coverage.truncated).toBe(true);
    expect(rows.length).toBe(1);
  });

  it('право оператора проверяется ДО чтения — иначе потолок защищал бы чужие числа', async () => {
    const prisma = { ...fakePrisma(5), user: { findUnique: async () => ({ isOperator: false }) } };
    await expect(new TelemetryService(prisma as never).getSummary('u')).rejects.toThrow(ForbiddenException);
    expect(prisma.calls.length).toBe(0);
  });

  it('потолок телеметрии НЕ равен страничному: двести вызовов — не выборка для перцентиля', () => {
    // Если кто-то «унифицирует» его с DEFAULT_PAGE_LIMIT, перцентиль
    // начнёт говорить о вчерашнем дне одного человека. Причина записана
    // рядом с константой.
    expect(TELEMETRY_MAX_JOBS).toBeGreaterThan(1000);
    const src = source('telemetry/telemetry.service.ts');
    expect(src.includes('двести AI-вызовов')).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: обоснование в шапке больше не ссылается на образец, который изменился', () => {
    const telemetry = source('telemetry/telemetry.service.ts');
    const calibration = source('calibration/calibration.service.ts');
    // Калибровка действительно считает в базе — значит ссылаться на неё
    // как на пример JS-агрегации нельзя.
    expect(calibration.includes('groupBy')).toBe(true);
    // Утверждение проверяется СТРУКТУРНО, а не запретом фразы, и это
    // стоило первой версии этой проверки: конвенция проекта — цитировать
    // то, что было неверно, поэтому поправка САМА содержит прежнюю
    // формулировку в кавычках. Сверка, запрещающая фразу, наказывала за
    // цитату и требовала переписать историю вместо ошибки. (Та же
    // ловушка, что «комментарий считается кодом», только про кавычки.)
    //
    // Инвариант, который действительно нужен: любое упоминание
    // CalibrationService в этом файле стои́т ПОСЛЕ метки поправки — то
    // есть внутри объяснения, а не в роли действующего обоснования.
    const marker = telemetry.indexOf('[the-example-stopped-being-an-example]');
    expect(marker).toBeGreaterThan(0);
    const mentions: number[] = [];
    for (let at = telemetry.indexOf('CalibrationService'); at >= 0; at = telemetry.indexOf('CalibrationService', at + 1)) {
      mentions.push(at);
    }
    expect(mentions.length).toBeGreaterThan(0);
    expect(mentions.every((at) => at > marker)).toBe(true);
  });

  it('экран админки печатает покрытие, а не принимает срез молча', () => {
    const page = readFileSync(join(API_SRC, '..', '..', 'admin', 'src', 'app', 'telemetry', 'page.tsx'), 'utf8');
    expect(page.includes('coverage.truncated')).toBe(true);
    expect(page.includes('Посчитано по последним')).toBe(true);
    expect(page.includes('Посчитано по всем')).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни одна подпись в админке не выключена заведомо ложным условием', () => {
    // НАЙДЕНО МУТАЦИЕЙ этого же захода. Первая версия проверки выше
    // требовала, чтобы в файле ВСТРЕЧАЛОСЬ `coverage.truncated`, —
    // и мутация `{false && coverage && coverage.truncated && (`
    // прошла насквозь: текст на месте, подпись не рисуется никогда.
    // Наличие строки в файле не значит, что человек её увидит.
    //
    // У tma такое правило есть с давних сверок
    // (`silent-failure-conventions.spec.ts`), но оно обходит
    // `components`/`app` ТОЛЬКО мини-приложения. Админка не покрыта
    // ничем — то есть правило существовало и смотрело не на все экраны.
    // Здесь закрыт узкий, но настоящий случай: заведомо ложное условие
    // перед подписью.
    const adminApp = join(API_SRC, '..', '..', 'admin', 'src', 'app');
    const screens: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.tsx')) screens.push(full);
      }
    };
    walk(adminApp);
    expect(screens.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of screens) {
      const src = readFileSync(file, 'utf8');
      if (/\{\s*false\s*&&/.test(src) || /&&\s*false\s*&&/.test(src)) {
        offenders.push(file.slice(adminApp.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('Реестр растущих чтений: полнота и честность', () => {
  it('у каждой записи названо, ЧТО её растит, и состояние с причиной', () => {
    expect(GROWING_READS.length >= 8).toBe(true);
    for (const read of GROWING_READS) {
      expect(read.grows.length > 20).toBe(true);
      expect(read.why.length > 30).toBe(true);
      expect(['bounded-and-says-so', 'unbounded-on-purpose'].includes(read.state)).toBe(true);
    }
  });

  it('каждый названный файл существует, и модель в нём действительно читается', () => {
    const missing: string[] = [];
    for (const read of GROWING_READS) {
      let src = '';
      try {
        src = source(read.file);
      } catch {
        missing.push(`${read.file}: файла нет`);
        continue;
      }
      // Модель записана как «a / b» там, где чтений два.
      const models = read.model.split('/').map((m) => m.trim().replace(/\s*\(.*\)$/, ''));
      if (!models.some((m) => src.includes(`${m}.findMany(`))) {
        missing.push(`${read.file}: ${read.model} не читается через findMany`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('ограниченные чтения и правда несут признак неполноты', () => {
    const offenders: string[] = [];
    for (const read of GROWING_READS.filter((r) => r.state === 'bounded-and-says-so')) {
      const src = source(read.file);
      const saysSo = src.includes('takeWithProbe') || src.includes('pagedList') || src.includes('truncated') || src.includes('hasMore');
      if (!saysSo) offenders.push(read.file);
    }
    expect(offenders).toEqual([]);
  });

  it('чего реестр НЕ делает — сказано отдельным списком', () => {
    // Реестр, не назвавший своих пределов, читается как гарантия.
    expect(GROWING_READS_NOT_COVERED.length >= 3).toBe(true);
    const joined = GROWING_READS_NOT_COVERED.join(' ');
    expect(joined.includes('курсора')).toBe(true);
  });

  it('обратная проба: выдуманный файл в реестре роняет сверку полноты', () => {
    // Иначе «каждый названный файл существует» могло бы означать «файлов
    // никто не проверял».
    let threw = false;
    try {
      source('no-such-module/no-such.service.ts');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// Сверка фоновых задач 2026-09-04 — «то, что работает, пока никто не
// смотрит».
//
// ПОЧЕМУ ИМЕННО ЭТОТ КЛАСС. Предыдущие заходы разбирали то, что человек
// видит на экране: обрезанные списки, удаление проекта, выгрузку данных,
// пропущенного кандидата. Общая форма у всех одна — ПРОБЕЛ ВЫГЛЯДИТ КАК
// ПОЛНОТА. Фоновые задачи — та же форма в чистом виде: у них вообще нет
// зрителя. Если тик ничего не сделал, никто об этом не узнает; если
// плановое задание не поставили на инстанс, оно не сломается — его
// просто не будет.
//
// НАЙДЕНО (все четыре — измерением, не ощущением):
//
// 1. ГЛАВНОЕ. Вкладка «БД» сверяла расписание с ТРЕМЯ именами, зашитыми
//    в код экрана, — джобами из pg_cron_ai_jobs.sql. В репозитории их
//    семь, в пяти файлах. Джоба, которую забыли применить, не давала ни
//    одной строки: оператор видел таблицу из трёх зелёных «совпадает» и
//    читал её как «всё настроено», хотя напоминания о разговорах могли
//    не уходить ни разу с самого деплоя. Наши же четыре джобы из других
//    файлов помечались «не наша (другой файл)».
//
// 2. `dispatchDueReminders()` — два `findMany` без `take` и без
//    `orderBy`. Хуже: строка прошедшего разговора, которой напоминание
//    так и не ушло, оставалась в выборке НАВСЕГДА (отметка null) и
//    отбрасывалась уже в JS — рабочий набор рос вместе с возрастом
//    проекта. А постфактум-напоминание при постоянном сбое отправки
//    (человек заблокировал бота) снимало отметку обратно и повторялось
//    каждую минуту, вечно.
//
// 3. `recomputeCalibration()`/`getStatus()` — читали ВСЕ подтверждённые
//    исходы всех пользователей продукта в память ради четырёх средних.
//
// 4. Обе сторожевые (`reapExpired`, `reapExpiredMediaLeases`) — без
//    потолка порции и без защиты от одной упавшей строки: отказ
//    хранилища или Telegram ронял тик целиком, следующий тик начинал с
//    той же битой строки.
//
// НЕ ИСПРАВЛЕНО НАМЕРЕННО (называется, чтобы не выглядело сделанным):
//  • отсчёт попыток отправки («перестать после третьего отказа») — нужна
//    отдельная колонка, то есть пятая ручная миграция; четыре уже ждут
//    применения, решение о пятой за владельцем;
//  • оповещение оператора о том, что плановая задача не подаёт признаков
//    жизни. Вкладка «БД» теперь ПОКАЗЫВАЕТ это тому, кто зашёл; кому и
//    куда об этом писать — решение о мониторинге, а не про код.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { EXPECTED_CRON_JOBS, compareCronJobs } from '../admin-db-state/expected-cron-jobs';

const API_SRC = join(__dirname, '..');
const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'manual-migrations');

/** Все cron.schedule() из всех pg_cron_*.sql — источник правды на диске. */
function cronJobsInSqlFiles(): Array<{ jobname: string; schedule: string; file: string }> {
  const out: Array<{ jobname: string; schedule: string; file: string }> = [];
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.startsWith('pg_cron_') && f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    // SELECT cron.schedule(\n  'имя',\n  'расписание',
    const re = /cron\.schedule\(\s*'([^']+)'\s*,\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) out.push({ jobname: m[1], schedule: m[2], file });
  }
  return out;
}

describe('Фоновые задачи: то, что работает, пока никто не смотрит', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: список ожидаемых плановых задач совпадает с pg_cron_*.sql — имя, расписание и файл', () => {
    // Этот тест и есть механизм, который не даёт списку отстать. Раньше
    // роль «списка» играли три строки в коде экрана, и отставание от
    // репозитория никто не замечал именно потому, что отставание было
    // невидимым: недостающая джоба просто не рисовалась.
    const inFiles = cronJobsInSqlFiles()
      .map((j) => `${j.jobname} | ${j.schedule} | ${j.file}`)
      .sort();
    const inCode = EXPECTED_CRON_JOBS.map((j) => `${j.jobname} | ${j.schedule} | ${j.file}`).sort();
    expect(inCode).toEqual(inFiles);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отсутствующая на инстансе задача попадает в ответ строкой, а не исчезает из него', () => {
    // Инстанс, на котором стоят только джобы ai-jobs — ровно тот случай,
    // который экран показывал как «всё в порядке».
    const actual = EXPECTED_CRON_JOBS.filter((j) => j.file === 'pg_cron_ai_jobs.sql').map((j) => ({
      jobname: j.jobname,
      schedule: j.schedule,
      active: true,
    }));
    const result = compareCronJobs(actual);

    expect(result.jobs).toHaveLength(EXPECTED_CRON_JOBS.length);
    expect(result.missing).toContain('dispatch-scheduled-conversation-reminders');
    expect(result.missing.length).toBe(EXPECTED_CRON_JOBS.length - actual.length);
    const reminders = result.jobs.find((j) => j.jobname === 'dispatch-scheduled-conversation-reminders')!;
    expect(reminders.actualSchedule).toBeNull();
    // И у каждой отсутствующей сказано, что именно из-за этого не работает.
    // Сверка конвенционных проверок 2026-09-04 ([guard-audit]): раньше
    // здесь стояла только длина, и мутация «заменить объяснение общей
    // отпиской» («Задача не выполняется, требуется применить файл на
    // инстансе») её проходила. Отписка длиннее тридцати символов и
    // бесполезна ровно так же, как пустая строка.
    //
    // ЧЕСТНАЯ ГРАНИЦА: качество текста тестом не проверяется — можно
    // проверить только его отсутствие. Поэтому здесь список формул,
    // которые ничего не сообщают: они запрещены прямо, а всё остальное
    // остаётся на совести пишущего.
    const EMPTY_FORMULAS = /^(задача не выполняется|не выполняется|не работает|требуется|нужно применить)/i;
    for (const name of result.missing) {
      const job = result.jobs.find((j) => j.jobname === name)!;
      expect(job.breaksWhenMissing.length).toBeGreaterThan(60);
      expect(job.breaksWhenMissing).not.toMatch(EMPTY_FORMULAS);
    }
  });

  it('расхождение расписания и выключенная задача различаются между собой и от отсутствия', () => {
    const result = compareCronJobs([
      { jobname: 'ai-jobs-submit', schedule: '*/5 * * * *', active: true }, // не то расписание
      { jobname: 'ai-jobs-poll', schedule: '*/3 * * * *', active: false }, // стоит, но выключена
      { jobname: 'ai-jobs-reap', schedule: '* * * * *', active: true }, // в порядке
      { jobname: 'чужая-джоба', schedule: '* * * * *', active: true }, // не наша — не должна попасть в сверку
    ]);
    expect(result.mismatched).toEqual(['ai-jobs-submit']);
    expect(result.disabled).toEqual(['ai-jobs-poll']);
    expect(result.missing).not.toContain('ai-jobs-reap');
    expect(result.jobs.map((j) => j.jobname)).not.toContain('чужая-джоба');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни одна фоновая выборка не читает таблицу без потолка', () => {
    // Измерение по коду, а не по вере. Каждая пара «файл + метод» —
    // конкретная точка, где раньше стоял findMany без take.
    const bounded: Array<{ file: string; method: string; marker: RegExp }> = [
      {
        file: 'scheduler/scheduler.service.ts',
        method: 'dispatchDueReminders (спарринг)',
        marker: /sparringReminderSentAt: null[\s\S]{0,300}?take: DISPATCH_BATCH/,
      },
      {
        file: 'scheduler/scheduler.service.ts',
        method: 'dispatchDueReminders (постфактум)',
        marker: /postMortemReminderSentAt: null[\s\S]{0,300}?take: DISPATCH_BATCH/,
      },
      {
        file: 'ai-router/ai-router.service.ts',
        method: 'reapExpired',
        marker: /leaseExpiresAt: \{ lt: new Date\(\) \}[\s\S]{0,200}?take: REAP_BATCH/,
      },
      {
        file: 'conversations/conversations.service.ts',
        method: 'reapExpiredMediaLeases',
        marker: /mediaLeaseExpiresAt: \{ lt: new Date\(\) \}[\s\S]{0,300}?take: MEDIA_LEASE_REAP_BATCH/,
      },
    ];
    const unbounded: string[] = [];
    for (const b of bounded) {
      const src = readFileSync(join(API_SRC, b.file), 'utf8');
      if (!b.marker.test(src)) unbounded.push(`${b.file} → ${b.method}`);
    }
    expect(unbounded).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: потолок — это число, а не слово `take`', () => {
    // Сверка конвенционных проверок 2026-09-04 ([guard-audit]): проверка
    // выше ловит только НАЛИЧИЕ `take`. Мутация «оставить take, поднять
    // константу до 1_000_000» проходила мимо неё — то есть проверка
    // подтверждала потолок, которого фактически нет. Числа проверяются
    // здесь, у своих объявлений.
    //
    // Верхняя граница взята не с потолка: тик крона ходит раз в минуту и
    // каждая строка тянет сетевой вызов (Telegram, хранилище, провайдер),
    // так что порция крупнее тысячи не помещается в отведённое функции
    // время ни при каких условиях — а значит, перестаёт быть порцией.
    const limits: Array<{ file: string; name: string }> = [
      { file: 'scheduler/scheduler.service.ts', name: 'DISPATCH_BATCH' },
      { file: 'ai-router/ai-router.service.ts', name: 'REAP_BATCH' },
      { file: 'conversations/conversations.service.ts', name: 'MEDIA_LEASE_REAP_BATCH' },
    ];
    for (const { file, name } of limits) {
      const src = readFileSync(join(API_SRC, file), 'utf8');
      const m = src.match(new RegExp(`const ${name} = ([\\d_]+);`));
      expect(m).not.toBeNull();
      const value = Number((m as RegExpMatchArray)[1].replace(/_/g, ''));
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1000);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: сторожевые переживают одну упавшую строку и называют число неудач', () => {
    // Раньше отказ хранилища или Telegram на одной строке выбрасывал
    // исключение из всего тика: соседние строки оставались необработанными,
    // и это выглядело не как «сторожевая не справилась», а как «сторожевая
    // ничего не нашла».
    const aiRouter = readFileSync(join(API_SRC, 'ai-router/ai-router.service.ts'), 'utf8');
    expect(aiRouter).toMatch(/reaped: number; reapFailed: number/);
    expect(aiRouter).toMatch(/catch \(err\) \{[\s\S]{0,200}reapFailed\+\+/);

    const conversations = readFileSync(join(API_SRC, 'conversations/conversations.service.ts'), 'utf8');
    expect(conversations).toMatch(/mediaReaped: number; mediaReapFailed: number/);
    expect(conversations).toMatch(/catch \(err\) \{[\s\S]{0,200}mediaReapFailed\+\+/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: калибровка считает агрегатами, а не читает все исходы продукта', () => {
    const src = readFileSync(join(API_SRC, 'calibration/calibration.service.ts'), 'utf8');
    expect(src).toContain('groupBy');
    // Ни одного ВЫЗОВА findMany не осталось — иначе неограниченное чтение
    // вернётся незаметно. Упоминание в комментарии («было: findMany»)
    // проверку не ломает: ищется именно обращение к модели.
    expect(src).not.toMatch(/outcomeScenario\.findMany/);
    expect(src).not.toMatch(/findMany\(/);
  });

  it('постфактум-напоминание ограничено окном, и потерянное за окном — посчитано', () => {
    const src = readFileSync(join(API_SRC, 'scheduler/scheduler.service.ts'), 'utf8');
    expect(src).toMatch(/POST_MORTEM_WINDOW_MS = \d+ \* 24 \* 60 \* 60 \* 1000/);
    expect(src).toMatch(/gte: postMortemWindowStart/);
    // Выпавшее за окно не исчезает молча: тик возвращает его число.
    expect(src).toMatch(/postMortemExpiredTotal/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: экран сверки рисует именно отсутствующие задачи, а не только найденные', () => {
    // Читается как ТЕКСТ по тому же основанию, что в
    // intake-scenarios-have-ui.spec.ts: apps/api не импортирует код
    // админки, а разъезжаются именно эти две стороны. У самой админки
    // прогона тестов нет — иначе проверка жила бы там.
    const page = readFileSync(
      join(__dirname, '..', '..', '..', 'admin', 'src', 'app', 'db', 'page.tsx'),
      'utf8',
    );
    expect(page).toContain('expectedCron');
    expect(page).toContain('Не найдено на инстансе');
    expect(page).toContain('breaksWhenMissing');
    // Прежний зашитый список ушёл целиком — иначе на экране осталось бы
    // два источника правды, и разошёлся бы именно невидимый.
    expect(page).not.toContain('EXPECTED_SCHEDULES');
    // И «джоб нет» больше не означает «не применяли pg_cron_ai_jobs.sql»:
    // файлов пять, и молчать про остальные четыре — то же самое молчание.
    expect(page).not.toMatch(/Джоб нет — pg_cron_ai_jobs\.sql/);
  });

  it('ИЗМЕРЕНИЕ: сколько всего плановых задач поставляет репозиторий', () => {
    // Число живёт здесь, чтобы следующая сверка начинала с факта. Рост
    // сам по себе нормален; ненормально, когда новая задача появилась в
    // SQL-файле, а на экране сверки её нет — это ловит первый тест.
    expect(cronJobsInSqlFiles().length).toBe(7);
    expect(new Set(cronJobsInSqlFiles().map((j) => j.file)).size).toBe(5);
  });
});

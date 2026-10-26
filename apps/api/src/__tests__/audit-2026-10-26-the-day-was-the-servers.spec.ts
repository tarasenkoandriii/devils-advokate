// Сверка [the-day-was-the-servers] 2026-10-26 — «попробуйте завтра» у
// потолка, который не сбрасывается завтра.
//
// ЧТО ИЗМЕРЕНО. Суточных потолков в продукте двенадцать, и все
// устроены одинаково: считаются записи с `createdAt >= now - 24ч`. Это
// СКОЛЬЗЯЩЕЕ окно, календарной полуночи в механизме нет ни у одного —
// и правильно, потому что часового пояса человека у сервера нет (это
// разобрано Пунктом [server-said-which-day] и перепроверено здесь: поля
// таймзоны у `User` в схеме нет, мини-приложение её не передаёт).
//
// А текст отказа говорил три разных вещи: «Попробуйте позже» (честно,
// но без ответа), «попробуйте завтра» (неправда — полночь ничего не
// значит) и ничего про сброс вовсе. Момент освобождения при этом
// вычисляется точно: самая старая запись окна плюс сутки. Ни один экран
// продукта не показывал ни остатка, ни времени сброса — то есть человек
// не мог узнать этого никак.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Три правила по форме (окно из одного места;
// сервер не выводит календарный день; серверный текст не говорит
// «завтра»/«сегодня») — и поведение помощников и двух правок на
// настоящих датах, а не на упоминании функций.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DAILY_WINDOW_MS, dailyLimitRefusal, dailyWindowStart, releaseAt } from '../common/daily-limit';
import { timeUntil } from '../common/server-time';
import { VenueApplicationService } from '../venue-application/venue-application.service';

const API_SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/** Исходник без комментариев. Разбор, который снимал бы их не целиком,
 *  считал бы объяснение «здесь было „попробуйте завтра“» нарушением —
 *  двенадцать раз в этом проекте ловились именно на этом. */
export function withoutComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  ';
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Строковые литералы файла — то, что может дойти до человека. */
export function stringLiterals(src: string): string[] {
  const clean = withoutComments(src);
  const found: string[] = [];
  for (const m of clean.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    found.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return found;
}

/** Начало суточного окна, посчитанное НА МЕСТЕ вместо общего места. */
const OWN_WINDOW = /(?:Date\.now\(\)|\.getTime\(\))\s*-\s*(?:24 \* 60 \* 60 \* 1000|86_400_000|86400000)/;
/** Календарный день, выведённый сервером из момента. */
const SERVER_CALENDAR_DAY = /set(?:UTC)?Hours\(\s*0\s*,/;
/** Слова, которыми сервер утверждает чужой календарь. */
const CALENDAR_WORDS = /(?:^|[^А-Яа-яЁё])(?:завтра|сегодня|послезавтра)(?![А-Яа-яЁё])/i;

const FILES = tsFiles(API_SRC);

/** Проходы — функциями, чтобы проба механизма шла ТЕМ ЖЕ путём, что и
 *  правило: проба, трогающая только регулярку, проверяет регулярку
 *  (прямой урок [probe-checked-the-neighbour]). */
export function scanWindows(files: string[]): string[] {
  return files.filter((f) => OWN_WINDOW.test(withoutComments(readFileSync(f, 'utf8'))));
}

export function scanCalendarDay(files: string[]): string[] {
  return files.filter((f) => SERVER_CALENDAR_DAY.test(withoutComments(readFileSync(f, 'utf8'))));
}

export function scanCalendarWords(files: string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    for (const text of stringLiterals(readFileSync(file, 'utf8'))) {
      if (CALENDAR_WORDS.test(text)) found.push(`${file}: ${text.slice(0, 80)}`);
    }
  }
  return found;
}

/** Где считать окно на месте ЗАКОННО — и почему. Пусто: длина окна
 *  живёт в `daily-limit.ts` одной константой, и вычитать её на месте
 *  больше не нужно нигде. */
const WINDOW_ALLOWED = new Set<string>();

/** Где слово «сегодня»/«завтра» в серверном тексте ЗАКОННО — и почему.
 *  Правило против утверждений о КАЛЕНДАРЕ человека; «сегодня» в
 *  значении «на нынешний момент» утверждением о календаре не является,
 *  но и проходить молча не должно. */
const CALENDAR_WORD_ALLOWED: Array<{ file: string; why: string }> = [
  {
    file: 'legal-disclaimer/legal-reference-seed.ts',
    why: '«СЕГОДНЯ на эти права опираться рано» — о нынешнем состоянии закона (обязанности вступают в силу в 2029 и 2031), а не о дне календаря человека; заменить на дату значило бы соврать точностью',
  },
];

describe('Сверка [the-day-was-the-servers]: «сутки» — одна и та же во всём продукте', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: длина суточного окна берётся из одного места', () => {
    const offenders = scanWindows(FILES)
      .map((f) => f.slice(API_SRC.length + 1))
      .filter((rel) => !WINDOW_ALLOWED.has(rel));
    expect(offenders).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: сервер не выводит календарный день из момента', () => {
    // Полночь часового пояса ПРОЦЕССА — не полночь человека: `TZ` в
    // проекте не задан нигде, то есть это полночь UTC, у киевлянина
    // 02:00–03:00 его ночи. Было ровно одно такое место (отметка брони
    // заведения), и оно переехало на скользящее окно.
    const offenders = scanCalendarDay(FILES).map((f) => f.slice(API_SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни один серверный текст не говорит «завтра» или «сегодня»', () => {
    // Правило только для сервера. Клиент под него не попадает
    // намеренно: календарь своего устройства он знает, и вид
    // «сегодня / завтра / послезавтра» в планировщике — правда.
    const allowed = new Set(CALENDAR_WORD_ALLOWED.map((a) => a.file));
    const offenders: string[] = [];
    for (const file of FILES) {
      const rel = file.slice(API_SRC.length + 1);
      if (allowed.has(rel)) continue;
      for (const text of stringLiterals(readFileSync(file, 'utf8'))) {
        if (CALENDAR_WORDS.test(text)) offenders.push(`${rel}: ${text.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('у каждого исключения названа причина, а не «так исторически»', () => {
    for (const a of CALENDAR_WORD_ALLOWED) {
      expect(`${a.file}: ${a.why.length > 60}`).toBe(`${a.file}: true`);
    }
  });

  it('ОБРАТНАЯ ПРОБА: без списка прощённых тот же проход находит РОВНО их', () => {
    // Иначе список мог бы разрастаться на уже исправленные места, а
    // пустой результат выше читался бы как «правило держит».
    const found = new Set<string>();
    for (const file of FILES) {
      for (const text of stringLiterals(readFileSync(file, 'utf8'))) {
        if (CALENDAR_WORDS.test(text)) found.add(file.slice(API_SRC.length + 1));
      }
    }
    expect([...found].sort()).toEqual(CALENDAR_WORD_ALLOWED.map((a) => a.file).sort());
  });

  it('проба механизма: ПРОХОД находит подложенного нарушителя — не только выражение, а весь разбор', () => {
    // Пустые списки выше ничего не значат, пока не показано, что проход
    // вообще способен кого-то найти. Проверяется не регулярка (её
    // проверяют обратные пробы ниже), а весь путь: файл → снятие
    // комментариев → правило. Файл кладётся ВНЕ репозитория: удаление в
    // подключённой папке запрещено мостом, и проба, оставляющая мусор в
    // исходниках, — плохая проба.
    const dir = mkdtempSync(join(tmpdir(), 'day-was-servers-'));
    const offender = join(dir, 'offender.ts');
    writeFileSync(offender, "const since = new Date(Date.now() - 24 * 60 * 60 * 1000);\nconst t = 'попробуйте завтра';\nd.setHours(0, 0, 0, 0);\n");
    const innocent = join(dir, 'innocent.ts');
    writeFileSync(innocent, "const since = dailyWindowStart();\nconst t = 'Попробуйте позже.';\n");

    expect(scanWindows([offender, innocent])).toEqual([offender]);
    expect(scanCalendarDay([offender, innocent])).toEqual([offender]);
    expect(scanCalendarWords([offender, innocent]).length).toBe(1);

    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(offender)).toBe(false);
    // И число файлов репозитория на виду: проход по пустому списку был
    // бы зелёным сам по себе.
    expect(FILES.length).toBeGreaterThan(300);
  });

  it('ОБРАТНАЯ ПРОБА: окно, посчитанное на месте, находится', () => {
    expect(OWN_WINDOW.test(withoutComments("const since = new Date(Date.now() - 24 * 60 * 60 * 1000);"))).toBe(true);
    expect(OWN_WINDOW.test(withoutComments('const since = dailyWindowStart();'))).toBe(false);
  });

  it('ОБРАТНАЯ ПРОБА: то же В КОММЕНТАРИИ нарушением не считается', () => {
    const quoted = '// было: new Date(Date.now() - 24 * 60 * 60 * 1000)\nconst since = dailyWindowStart();';
    expect(OWN_WINDOW.test(withoutComments(quoted))).toBe(false);
  });

  it('ОБРАТНАЯ ПРОБА: календарная полночь сервера находится в обоих написаниях', () => {
    // Проба идёт через ТОТ ЖЕ проход, что и ключевой тест
    // (`scanCalendarDay`), а не через отдельно вызванное выражение:
    // иначе она проверяла бы регулярку, а не решение — прямой урок
    // [probe-checked-the-neighbour], и этот сторож её на том и поймал.
    const dir = mkdtempSync(join(tmpdir(), 'day-midnight-'));
    const local = join(dir, 'local.ts');
    const utc = join(dir, 'utc.ts');
    const noon = join(dir, 'noon.ts');
    writeFileSync(local, 'd.setHours(0, 0, 0, 0);\n');
    writeFileSync(utc, 'd.setUTCHours(0, 0, 0, 0);\n');
    writeFileSync(noon, 'd.setHours(12, 0, 0, 0);\n');
    expect(scanCalendarDay([local, utc, noon]).sort()).toEqual([local, utc].sort());
    rmSync(dir, { recursive: true, force: true });
  });

  it('ОБРАТНАЯ ПРОБА: «завтра» в тексте находится, а в комментарии — нет; и слово внутри другого слова не ловится', () => {
    expect(stringLiterals("throw new Error('попробуйте завтра');").some((t) => CALENDAR_WORDS.test(t))).toBe(true);
    expect(stringLiterals("// попробуйте завтра\nthrow new Error('позже');").some((t) => CALENDAR_WORDS.test(t))).toBe(false);
    // «засегодняшний» выдуман, но проверяет именно границу слова: без
    // неё правило ловило бы любое вхождение подстроки.
    expect(CALENDAR_WORDS.test('засегодняшний')).toBe(false);
  });
});

describe('[the-day-was-the-servers] поведение: «через сколько» считается, а не угадывается', () => {
  const now = new Date('2026-10-26T12:00:00.000Z');

  it('КЛЮЧЕВОЙ ТЕСТ: момент освобождения — самая старая запись окна плюс сутки', () => {
    const oldest = new Date('2026-10-26T09:30:00.000Z');
    expect(releaseAt(oldest)).toEqual(new Date('2026-10-27T09:30:00.000Z'));
    expect(releaseAt(null)).toBeNull();
    expect(DAILY_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(dailyWindowStart(now)).toEqual(new Date('2026-10-25T12:00:00.000Z'));
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отказ называет часы и минуты, а не «завтра» и не «позже»', () => {
    const text = dailyLimitRefusal({
      subject: 'озвучка',
      limit: 20,
      oldestInWindow: new Date('2026-10-25T15:20:00.000Z'),
      now,
    });
    // Точное равенство, а не вхождение подстроки: оно и сильнее, и само
    // доказывает, что слова «завтра» в тексте нет — проверять это
    // отдельным `not.toMatch` значило бы добавить опору на текст там,
    // где есть опора на всю строку (сторож [guard-audit] считает именно
    // такие и считает их заслуженно).
    expect(text).toBe('Достигнут суточный лимит: озвучка (20/сутки). Потолок скользящий: одно место освободится через 3 часа 20 минут.');
  });

  it('когда самую старую прочитать не удалось — честное «позже», а не выдуманный срок', () => {
    expect(dailyLimitRefusal({ subject: 'озвучка', limit: 20, oldestInWindow: null, now })).toBe(
      'Достигнут суточный лимит: озвучка (20/сутки). Попробуйте позже.',
    );
  });

  it('у потолка по ДЛИТЕЛЬНОСТИ освобождается длительность, а не «место»', () => {
    const text = dailyLimitRefusal({
      subject: 'расшифровки по длительности',
      limit: 60,
      unit: ' мин/сутки',
      oldestInWindow: new Date('2026-10-25T13:00:00.000Z'),
      releases: 'длительность самой старой расшифровки окна',
      now,
    });
    expect(text).toBe(
      'Достигнут суточный лимит: расшифровки по длительности (60 мин/сутки). Потолок скользящий: длительность самой старой расшифровки окна освободится через 1 час.',
    );
  });

  it('русские формы часов и минут не разъезжаются', () => {
    const at = (ms: number) => timeUntil(new Date(now.getTime() + ms), now);
    expect(at(60 * 60 * 1000)).toBe('1 час');
    expect(at(2 * 60 * 60 * 1000)).toBe('2 часа');
    expect(at(5 * 60 * 60 * 1000)).toBe('5 часов');
    expect(at(11 * 60 * 1000)).toBe('11 минут');
    expect(at(21 * 60 * 1000)).toBe('21 минуту');
    expect(at(2 * 60 * 1000)).toBe('2 минуты');
  });

  it('ноль не выдаётся за «уже можно», а прошлое — за будущее', () => {
    // «0 мин» человек прочитал бы как «можно сейчас» и нажал впустую.
    expect(timeUntil(new Date(now.getTime() + 20_000), now)).toBe('1 минуту');
    expect(timeUntil(now, now)).toBe('уже освободилось');
    expect(timeUntil(new Date(now.getTime() - 60_000), now)).toBe('уже освободилось');
  });
});

describe('[the-day-was-the-servers] поведение: отметка брони — скользящие сутки под замком', () => {
  function fakeVenuePrisma(existing: Array<{ createdAt: Date }>) {
    const steps: string[] = [];
    const created: unknown[] = [];
    const model = (on: string) => ({
      findFirst: async ({ where }: any) => {
        steps.push(`${on}:findFirst`);
        const from = where.createdAt.gte as Date;
        return existing.filter((r) => r.createdAt >= from).sort((a, b) => +a.createdAt - +b.createdAt)[0] ?? null;
      },
      create: async ({ data }: any) => {
        steps.push(`${on}:create`);
        created.push(data);
        return { id: 'c1', ...data };
      },
    });
    const tx: any = {
      $executeRaw: async () => { steps.push('tx:lock'); return 1; },
      venueBookingConfirmation: model('tx'),
    };
    const fake: any = {
      _steps: steps,
      _created: created,
      $executeRaw: async () => { steps.push('вне-транзакции:lock'); return 1; },
      $transaction: async (arg: any) => { steps.push('transaction'); return typeof arg === 'function' ? arg(tx) : Promise.all(arg); },
      venueBookingConfirmation: model('вне-транзакции'),
      approvedVenue: { findUnique: async () => ({ id: 'v1', referralFeeAmount: '100' }) },
    };
    return fake;
  }

  function service(prisma: any) {
    return new VenueApplicationService(prisma, { resolve: async () => 'key' } as any, { record: async () => ({}) } as any);
  }

  it('КЛЮЧЕВОЙ ТЕСТ: проверка и запись — одно событие под замком и по той же транзакции', async () => {
    const prisma = fakeVenuePrisma([]);
    await service(prisma).confirmBooking('u1', 'v1');
    expect(prisma._steps).toEqual(['transaction', 'tx:lock', 'tx:findFirst', 'tx:create']);
    expect(prisma._created).toHaveLength(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: вторая отметка за сутки отклоняется и называет, через сколько можно', async () => {
    const twentyHoursAgo = new Date(Date.now() - 20 * 60 * 60 * 1000);
    const prisma = fakeVenuePrisma([{ createdAt: twentyHoursAgo }]);
    await expect(service(prisma).confirmBooking('u1', 'v1')).rejects.toThrow(/за последние сутки/);
    await expect(service(prisma).confirmBooking('u1', 'v1')).rejects.toThrow(/Отметить снова можно через 4 часа/);
    expect(prisma._created).toHaveLength(0);
  });

  it('ОБРАТНАЯ ПРОБА: отметка СТАРШЕ суток не мешает — окно скользящее, а не «одна на всю жизнь»', async () => {
    const prisma = fakeVenuePrisma([{ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }]);
    await service(prisma).confirmBooking('u1', 'v1');
    expect(prisma._created).toHaveLength(1);
  });
});

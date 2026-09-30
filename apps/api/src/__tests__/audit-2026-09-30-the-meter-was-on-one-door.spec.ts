// Сверка 2026-09-30 — счётчик стоял на одной двери.
//
// ЗАМЕР. Точек, из которых продукт обращается наружу к платному или
// квотируемому сервису, сорок пять. Под потолком из реестра расходов
// было одиннадцать, ограничены иначе (кэш, идемпотентность, интервал,
// порция, потолок на сессию) — пятнадцать, НЕ ОГРАНИЧЕНЫ ПО ЧАСТОТЕ
// НИЧЕМ — девятнадцать.
//
// ЧТО ЗАКРЫТО ЭТИМ ЗАХОДОМ, по убыванию цены:
//
//  1. [the-meter-was-on-one-door] Голосовые реплики спарринга и чата по
//     материалам уходили в ПОМИНУТНО тарифицируемое распознавание без
//     потолка. Единственным пределом было `MAX_MESSAGES_PER_SESSION`
//     (40) на сессию, а потолка на создание сессий нет вовсе. Потолок
//     транскрибации существовал и стоял в одном месте из трёх.
//
//  2. [the-priciest-door-had-no-lock] Шесть маршрутов к Google Places
//     без единого ограничения. Places тарифицируется ЗА КАЖДЫЙ ЗАПРОС —
//     самая дорогая единица обращения из всех неограниченных путей, и
//     подбор заведений делает до четырёх обращений за одно нажатие.
//
//  3. [the-meter-counted-rows] Потолок проверок фото считал СТРОКИ
//     `PhotoVerification`, а не вызовы. Следствия два: упавший до
//     записи вызов потолок не тратил (то есть серия падающих вызовов
//     жгла кредиты SerpApi неограниченно), а один успешный поиск с
//     двадцатью совпадениями съедал суточный потолок 5 целиком.
//
//  4. [the-ceiling-lived-in-two-places] Зашитые потолки OCR и YouTube
//     существовали ВТОРЫМИ КОПИЯМИ чисел: реестр объявлял себя
//     единственным местом, где потолки перечислены, а места применения
//     читали свои константы, потому что `spendLimit()` искал запись по
//     имени переменной, а у зашитых его нет. Числа совпадали; правка
//     разъехалась бы молча. Тем же Пунктом в реестр публичной записи
//     перенесён седьмой потолок — зашитое `> 100` комментариев по
//     ссылке на вычитку вакансии.
//
// ЧТО ИЗ ЗАМЕРА СОЗНАТЕЛЬНО НЕ ЗАКРЫТО — перечислено в TODO.md
// (загрузка аудио провайдеру без потолка байтов, ключи живой
// транскрибации, длительность медиа-разбора со слов клиента, Nominatim,
// Windy, Fact Check, число файлов в Blob). Не закрыто не потому, что
// мелочь, а потому, что каждое требует своего решения, а не ещё одной
// строки в реестре.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { SPEND_LIMITS, spendLimitByKey } from '../common/spend-limits';
import { PLACES_USAGE_ACTION, placesRequestsLeft, spendPlacesRequest } from '../common/places-spend';
import {
  TRANSCRIPTION_USAGE_ACTION,
  assertUnderDailyTranscriptionLimit,
  recordTranscriptionSpend,
} from '../stt/transcription-spend';

const API_SRC = join(__dirname, '..');

function code(rel: string): string {
  return readFileSync(join(API_SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(full.slice(API_SRC.length + 1));
    }
  })(API_SRC);
  return out;
}

/** Журнал расхода: считает и пишет, как настоящий. */
function fakeLog(initial = 0) {
  const rows: Array<{ action: string; after?: unknown }> = [];
  for (let i = 0; i < initial; i++) rows.push({ action: 'заполнение' });
  return {
    rows,
    prisma: {
      auditLogEntry: {
        count: async ({ where }: any) => rows.filter((r) => r.action === where.action).length,
        findMany: async ({ where }: any) => rows.filter((r) => r.action === where.action),
        create: async ({ data }: any) => {
          rows.push(data);
          return data;
        },
      },
    } as any,
  };
}

describe('[the-meter-was-on-one-door] потолки стоят у каждой платной двери', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: потолок транскрибации — один помощник, и он считает попытки', async () => {
    const log = fakeLog();
    // Пусто — проходит.
    await assertUnderDailyTranscriptionLimit(log.prisma, 'u1');
    // Набиваем ровно до потолка ЧУЖИМИ отметками того же действия.
    const limit = spendLimitByKey('transcriptions');
    expect(limit).toBeGreaterThan(0);
    for (let i = 0; i < limit; i++) {
      await recordTranscriptionSpend(log.prisma, 'u1', 'SparringSession', `s-${i}`, null);
    }
    await expect(assertUnderDailyTranscriptionLimit(log.prisma, 'u1')).rejects.toThrow(/лимит расшифровок/);
    // И записи — с тем же именем действия во всех трёх дверях: разные
    // имена означали бы, что каждая дверь считает только себя.
    expect([...new Set(log.rows.map((r) => r.action))]).toEqual([TRANSCRIPTION_USAGE_ACTION]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: все три двери транскрибации зовут потолок, а не только разговоры', () => {
    // Правило по дереву: файл, отправляющий задачу распознавания
    // (`submitWebhookJob`), обязан звать потолок. Ценность — в
    // ЧЕТВЁРТОЙ двери, которой ещё нет: именно так и появились вторая
    // с третьей.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.startsWith('stt/')) continue; // сам модуль распознавания и есть провайдер
      const src = code(file);
      if (!src.includes('submitWebhookJob(')) continue;
      if (!src.includes('assertUnderDailyTranscriptionLimit(')) offenders.push(`${file}: нет потолка`);
      if (!src.includes('recordTranscriptionSpend(')) offenders.push(`${file}: нет отметки расхода`);
    }
    expect(offenders).toEqual([]);
    // Обратная проба: дверей действительно три, а не ноль (иначе
    // пустой список выше означал бы сломанный разбор).
    const doors = sourceFiles().filter((f) => !f.startsWith('stt/') && code(f).includes('submitWebhookJob('));
    expect(doors.length).toBe(3);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: обращение к картам проверяет потолок и отмечает расход, в этом порядке', async () => {
    const limit = spendLimitByKey('places-requests');
    expect(limit).toBeGreaterThan(0);
    // Потолок уже выбран чужими отметками — отказ до запроса.
    const full = fakeLog();
    for (let i = 0; i < limit; i++) await spendPlacesRequest(full.prisma, 'u1', 'проба');
    expect(full.rows.length).toBe(limit);
    await expect(spendPlacesRequest(full.prisma, 'u1', 'ещё')).rejects.toThrow(/лимит обращений к картам/);
    // И отметка не добавилась: отказ не должен тратить потолок.
    expect(full.rows.length).toBe(limit);
    expect([...new Set(full.rows.map((r) => r.action))]).toEqual([PLACES_USAGE_ACTION]);
    // Остаток считается от того же журнала.
    expect(await placesRequestsLeft(full.prisma, 'u1')).toBe(0);
    const fresh = fakeLog();
    expect(await placesRequestsLeft(fresh.prisma, 'u1')).toBe(limit);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: каждое место, вызывающее платные карты, считает расход', () => {
    // Числа, а не наличие слова: у подбора заведений обращений ДВА
    // вида (Nearby плюс Details в цикле), и «в файле есть
    // spendPlacesRequest» прошло бы даже если считать стали одно из
    // двух.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.startsWith('common/places-spend') || file.includes('google-places-client')) continue;
      const src = code(file);
      const calls = (src.match(/\b(getPlaceDetails|searchByText|searchNearbyVenues|searchNearestByDistance)\(/g) ?? [])
        .length;
      if (calls === 0) continue;
      const spends = (src.match(/spendPlacesRequest\(/g) ?? []).length;
      if (spends < calls) offenders.push(`${file}: обращений ${calls}, отметок ${spends}`);
    }
    expect(offenders).toEqual([]);
    // Обратная проба: мест действительно три.
    const sites = sourceFiles().filter(
      (f) =>
        !f.startsWith('common/places-spend') &&
        !f.includes('google-places-client') &&
        /\b(getPlaceDetails|searchByText|searchNearbyVenues|searchNearestByDistance)\(/.test(code(f)),
    );
    expect(sites.length).toBe(3);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: зашитые потолки читаются из реестра, а не второй копией числа', () => {
    // Места применения обязаны спрашивать реестр по ключу. Мутация
    // «вернуть зашитое число обратно в сервис» роняет этот тест
    // числом, а не словом: значение сверяется с реестром.
    const byKey = Object.fromEntries(SPEND_LIMITS.map((l) => [l.key, l.fallback]));
    expect(spendLimitByKey('ocr-documents')).toBe(byKey['ocr-documents']);
    expect(spendLimitByKey('youtube-search')).toBe(byKey['youtube-search']);
    expect(spendLimitByKey('photo-verification')).toBe(byKey['photo-verification']);
    // И в дереве не осталось зашитых копий этих чисел рядом с их
    // именами.
    const offenders: string[] = [];
    for (const file of ['health/health.service.ts', 'media-review/youtube-search.service.ts', 'photo-verification/photo-verification.service.ts']) {
      const src = code(file);
      if (!src.includes('spendLimitByKey(')) offenders.push(`${file}: потолок не спрашивает реестр`);
      if (/DAILY_LIMIT_PER_USER = \d/.test(src)) offenders.push(`${file}: число снова зашито`);
    }
    expect(offenders).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у каждой записи реестра есть ключ, и ключи не повторяются', () => {
    // Иначе `spendLimitByKey` нашёл бы не ту запись, оставаясь зелёным.
    const keys = SPEND_LIMITS.map((l) => l.key);
    expect(keys.filter((k) => !k || k.length < 3)).toEqual([]);
    expect([...new Set(keys)].length).toBe(keys.length);
    expect(() => spendLimitByKey('такого-ключа-нет')).toThrow(/не описан/);
  });
});

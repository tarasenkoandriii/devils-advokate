// Сверка 2026-09-30 (второй заход дня) — остаток неограниченных выходов
// наружу.
//
// Первый заход дня закрыл девять точек из девятнадцати и НАЗВАЛ
// остальные в TODO.md. Этот закрывает пять из них — те, у которых
// механизм уже есть, — и оставляет пять названными, потому что там
// нужен не потолок, а решение владельца.
//
// ЧТО ЗАКРЫТО.
//
//  1. [the-lever-took-the-clients-word] Потолок длительности
//     медиа-разбора — «единственный рычаг стоимости одного разбора» —
//     проверялся против числа ИЗ ТЕЛА ЗАПРОСА. Хуже, чем «нет
//     проверки»: настоящую длительность сервер ПОЛУЧАЛ от
//     `videos.list` на шаге поиска, отдавал клиенту и не сохранял ни в
//     одном поле, а потом принимал обратно с его слов. Валидатор
//     `@Max(43_200)` проверял форму, и его потолок в 36 раз выше
//     потолка стоимости. Клиент, приславший 60 для трёхчасового
//     ролика, проходил целиком; останавливали его только 20
//     медиа-вызовов в сутки — двадцать трёхчасовых роликов вместо
//     расчётных двадцатиминутных. Ложь уезжала и в
//     `Conversation.durationSeconds`.
//
//  2. [the-stream-had-no-bottom] `SttService.uploadAudio` читал стрим
//     В ПАМЯТЬ ЦЕЛИКОМ без предела байтов — три маршрута. Асимметрия,
//     которая и выдаёт пропуск: у прямой записи в Blob предел 500 МБ
//     ЗАШИТ В ТОКЕН, потому что там байты идут мимо нас; здесь они
//     идут ЧЕРЕЗ нас, и предела не было.
//
//  3. [the-key-was-free-to-mint] Ключи живой расшифровки выдавались
//     без счёта. У Soniox ущерб ограничен провайдером (`single_use`,
//     три часа), у AssemblyAI — нет.
//
//  4. [the-policy-was-obeyed-by-hope] Nominatim без потолка. Цена не
//     деньги, а блокировка по IP ВСЕГО продукта: шапка клиента сама
//     называет правило OSM Foundation и обосновывает его соблюдение
//     словами «разовый запрос при онбординге» — разовым его не делало
//     ничто. Там же: Windy (платный ключ, вызывается ПЕРВЫМ, когда
//     ключ задан) и Fact Check Tools, чья квота ОБЩАЯ с OCR и поиском
//     YouTube.
//
//  5. [five-copies-of-one-counter] И один счётчик вместо пяти копий:
//     четыре новых потолка — это был выбор между четырьмя новыми
//     копиями одного и того же тела и одним общим местом
//     (`common/outward-spend.ts`).

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { SPEND_LIMITS, spendLimitByKey } from '../common/spend-limits';
import {
  FACT_CHECK_SPEND,
  GEOCODING_SPEND,
  OUTWARD_SPENDS,
  REALTIME_TOKEN_SPEND,
  WEATHER_SPEND,
  assertOutwardCallsLeft,
  outwardCallsLeft,
  spendOutwardCall,
} from '../common/outward-spend';

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
function fakeLog() {
  const rows: Array<{ action: string }> = [];
  // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05: счёт и
  // отметка идут ОДНОЙ транзакцией под advisory-замком, и заглушка
  // обязана знать ту же форму, что production. Прежняя не знала
  // `$transaction` вовсе — то есть описывала базу, которой не бывает, и
  // этот тест проходил бы и на коде БЕЗ замка. Тело исполняется на том
  // же объекте: атомарность здесь не изображается, её проверяет спека
  // пункта, а доказательство на живом Postgres записано числами в
  // `TODO.md`.
  const prisma: any = {
    auditLogEntry: {
      count: async ({ where }: any) => rows.filter((r) => r.action === where.action).length,
      create: async ({ data }: any) => {
        rows.push(data);
        return data;
      },
    },
    $executeRaw: async () => 1,
    $transaction: async (arg: any): Promise<any> => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
  };
  return { rows, prisma: prisma as any };
}

describe('[the-policy-was-obeyed-by-hope] остаток выходов наружу под потолком', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: общий счётчик проверяет потолок, отмечает расход и отказывает 429-м', async () => {
    const limit = spendLimitByKey(GEOCODING_SPEND.limitKey);
    expect(limit).toBeGreaterThan(0);
    const log = fakeLog();
    for (let i = 0; i < limit; i++) await spendOutwardCall(log.prisma, 'u1', GEOCODING_SPEND, 'проба');
    expect(log.rows.length).toBe(limit);
    await expect(spendOutwardCall(log.prisma, 'u1', GEOCODING_SPEND, 'ещё')).rejects.toThrow(/лимит/);
    // Отказ не тратит потолок: иначе отказ был бы расходом.
    expect(log.rows.length).toBe(limit);
    expect([...new Set(log.rows.map((r) => r.action))]).toEqual([GEOCODING_SPEND.action]);
    expect(await outwardCallsLeft(log.prisma, 'u1', GEOCODING_SPEND)).toBe(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: проверка БЕЗ отметки не тратит потолок', async () => {
    // Приём байтов сам ничего не тратит, но не имеет смысла при
    // выбранном потолке. Если бы `assertOutwardCallsLeft` отмечала
    // расход, один расход считался бы дважды.
    const log = fakeLog();
    await assertOutwardCallsLeft(log.prisma, 'u1', WEATHER_SPEND);
    expect(log.rows.length).toBe(0);
    const limit = spendLimitByKey(WEATHER_SPEND.limitKey);
    for (let i = 0; i < limit; i++) await spendOutwardCall(log.prisma, 'u1', WEATHER_SPEND, 'проба');
    await expect(assertOutwardCallsLeft(log.prisma, 'u1', WEATHER_SPEND)).rejects.toThrow(/лимит/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у каждого расхода свой ключ реестра и своё имя действия', () => {
    // Разъехавшиеся имена означали бы, что два вызова одного расхода
    // считаются порознь — потолок вдвое выше заявленного. А общий
    // ключ у двух расходов означал бы обратное: один потолок на два
    // кошелька.
    const keys = OUTWARD_SPENDS.map((s) => s.limitKey);
    const actions = OUTWARD_SPENDS.map((s) => s.action);
    expect([...new Set(keys)].length).toBe(keys.length);
    expect([...new Set(actions)].length).toBe(actions.length);
    for (const s of OUTWARD_SPENDS) {
      // Ключ обязан существовать в реестре — иначе `spendLimitByKey`
      // бросит в рантайме, на живом человеке.
      expect(spendLimitByKey(s.limitKey)).toBeGreaterThan(0);
      expect(s.refusalSubject.length).toBeGreaterThan(10);
    }
    expect(OUTWARD_SPENDS.length).toBe(4);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: каждый из четырёх потолков стоит у своего вызова наружу', () => {
    // Правило по дереву: файл, который ходит к этому сервису, обязан
    // звать счётчик. Ценность — в ПЯТОМ вызове, которого ещё нет.
    const sites: Array<{ file: string; outward: RegExp; spend: string }> = [
      { file: 'live-session/live-session.service.ts', outward: /mintRealtimeToken\(/, spend: 'REALTIME_TOKEN_SPEND' },
      { file: 'onboarding/onboarding.service.ts', outward: /reverseGeocode\(/, spend: 'GEOCODING_SPEND' },
      { file: 'weather-forecast/weather-forecast.service.ts', outward: /getWindyForecast\(/, spend: 'WEATHER_SPEND' },
      {
        file: 'discrepancy-analysis/discrepancy-analysis.service.ts',
        outward: /fetchAllPages\(/,
        spend: 'FACT_CHECK_SPEND',
      },
    ];
    const offenders: string[] = [];
    for (const s of sites) {
      const src = code(s.file);
      if (!s.outward.test(src)) offenders.push(`${s.file}: вызова наружу больше нет — правило смотрит не туда`);
      if (!src.includes('spendOutwardCall(')) offenders.push(`${s.file}: расход не считается`);
      if (!src.includes(s.spend)) offenders.push(`${s.file}: считается не тот расход`);
    }
    expect(offenders).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: длительность медиа-разбора берётся у ПРОВАЙДЕРА, а не из тела запроса', () => {
    const auto = code('media-review/media-review-auto.service.ts');
    // Провайдера спрашивают.
    expect(auto.includes('this.youtube.fetchDurations([item.youtubeVideoId])')).toBe(true);
    // И решение принимается по его ответу, а не по слову клиента: ни
    // `item.durationSeconds` в сравнении с потолком, ни «наибольшее из
    // двух» (это выглядело бы осторожностью, а на деле оставляло бы
    // рычаг в руках того, чьё число мы и перестали принимать).
    expect(/\(item\.durationSeconds \?\? 0\) > maxDurationSeconds/.test(auto)).toBe(false);
    expect(auto.includes('Math.max(verified')).toBe(false);
    // Метод запроса длительностей публичный и НЕ висит на потолке
    // поиска: он стоит одну единицу квоты против ста у search.list.
    const yt = code('media-review/youtube-search.service.ts');
    expect(yt.includes('async fetchDurations(')).toBe(true);
    const body = yt.slice(yt.indexOf('async fetchDurations('));
    expect(body.slice(0, body.indexOf('\n  }')).includes('assertUnderRateLimit')).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: приём байтов ограничен по размеру и проверяет потолок расшифровки', () => {
    const stt = code('stt/stt.service.ts');
    expect(stt.includes('MAX_UPLOAD_BYTES')).toBe(true);
    // Предел проверяется НА ЧТЕНИИ: иначе «слишком большой файл»
    // означало бы «уже в памяти».
    expect(/totalBytes > MAX_UPLOAD_BYTES/.test(stt)).toBe(true);
    // И все три двери приёма байтов смотрят на суточный потолок
    // расшифровки, не отмечая расход (отметка принадлежит шагу
    // отправки задачи).
    const doors = sourceFiles().filter((f) => !f.startsWith('stt/') && code(f).includes('this.stt.uploadAudio('));
    expect(doors.length).toBe(3);
    const offenders = doors.filter((f) => !code(f).includes('assertUnderDailyTranscriptionLimit('));
    expect(offenders).toEqual([]);
  });

  it('ИЗМЕРЕНИЕ: сколько потолков в реестре и сколько из них настраиваются', () => {
    // Число живёт здесь, чтобы следующая сверка начинала с факта.
    // Шестнадцать на 2026-09-30, из них тринадцать перекрываются
    // переменной окружения и три зашиты в код.
    expect(SPEND_LIMITS.length).toBe(16);
    expect(SPEND_LIMITS.filter((l) => l.env !== null).length).toBe(13);
    expect(SPEND_LIMITS.filter((l) => l.env === null).length).toBe(3);
    // И у каждого — свой ключ.
    const keys = SPEND_LIMITS.map((l) => l.key);
    expect([...new Set(keys)].length).toBe(keys.length);
    // Проба механизма: имена расходов действительно разные объекты, а
    // не один, переданный четыре раза.
    expect(new Set([REALTIME_TOKEN_SPEND, GEOCODING_SPEND, WEATHER_SPEND, FACT_CHECK_SPEND]).size).toBe(4);
  });
});

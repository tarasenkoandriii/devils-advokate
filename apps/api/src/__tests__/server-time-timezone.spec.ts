// Пункт [server-said-which-day] 2026-09-24 — часовой пояс проверяется
// НАСТОЯЩЕЙ сменой пояса, и поэтому эта спека стоит здесь, а не в jest.
//
// ПОЧЕМУ ОТДЕЛЬНО. Те же проверки, написанные под jest, ПРОХОДИЛИ при
// любом коде: внутри jest `process.env.TZ`, изменённый после старта, на
// поведение дат не влияет — окружение фиксирует зону за нас. Написанная
// там проверка «ответ не зависит от часового пояса» ничего не измеряла
// бы: сравнивались бы два одинаковых прогона. Обратная проба механизма
// (первый сценарий ниже) стоит первой именно поэтому — она падает,
// если переключение снова перестанет работать, и тогда падают не молча
// остальные.
//
// Прецедент: `apps/tma/src/__tests__/date-only.spec.ts` — Пункт
// [date-only] 2026-09-04 уже гонял даты через настоящую смену пояса, и
// тоже в автономном раннере.

import { daysAgo, deadlineRelative, instantUtc } from '../common/server-time';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function inTimeZone<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = previous;
  }
}

const ZONES = ['UTC', 'Europe/Kyiv', 'America/Chicago', 'Pacific/Kiritimati'];

const scenarios: Array<[string, () => void]> = [
  ['ОБРАТНАЯ ПРОБА МЕХАНИЗМА: смена пояса действительно меняет поведение дат', () => {
    // Без неё все сценарии ниже — театр.
    const d = new Date('2026-09-09T22:14:00.000Z');
    const kyiv = inTimeZone('Europe/Kyiv', () => d.toLocaleDateString('ru-RU'));
    const chicago = inTimeZone('America/Chicago', () => d.toLocaleDateString('ru-RU'));
    assert(kyiv === '10.09.2026', `Киев: ожидалось 10.09.2026, получено ${kyiv}`);
    assert(chicago === '09.09.2026', `Чикаго: ожидалось 09.09.2026, получено ${chicago}`);
    assert(kyiv !== chicago, 'переключение пояса не влияет на даты — проверки ниже ничего не измеряют');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: срок одинаков в любом часовом поясе', () => {
    const due = new Date('2026-09-13T20:59:59.999Z'); // конец дня 13-го по Киеву
    const now = new Date('2026-09-10T12:00:00.000Z');
    const answers = new Set(ZONES.map((tz) => inTimeZone(tz, () => deadlineRelative(due, now))));
    assert(answers.size === 1, `ответ зависит от пояса: ${[...answers].join(' | ')}`);
    assert([...answers][0] === 'через 3 дня', `ожидалось «через 3 дня», получено ${[...answers][0]}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: «сколько прошло» одинаково в любом часовом поясе', () => {
    const at = new Date('2026-09-01T00:30:00.000Z'); // 1-е по UTC, ещё 31 августа в Чикаго
    const now = new Date('2026-09-10T12:00:00.000Z');
    const answers = new Set(ZONES.map((tz) => inTimeZone(tz, () => daysAgo(at, now))));
    assert(answers.size === 1, `ответ зависит от пояса: ${[...answers].join(' | ')}`);
    assert([...answers][0] === '9 дней назад', `получено ${[...answers][0]}`);
  }],

  ['момент с названной зоной читается одинаково, где бы ни стоял сервер', () => {
    const d = new Date('2026-09-09T22:14:00.000Z');
    const answers = new Set(ZONES.map((tz) => inTimeZone(tz, () => instantUtc(d))));
    assert(answers.size === 1, `ответ зависит от пояса контейнера: ${[...answers].join(' | ')}`);
    const text = [...answers][0];
    assert(text.includes('UTC'), `зона не названа: ${text}`);
    assert(text.includes('9 сентября 2026'), `день по UTC не назван: ${text}`);
  }],

  ['ПРОБА НА ПРЕЖНЕМ ДЕФЕКТЕ: старое выражение действительно врало', () => {
    // Что именно было: срок «13 сентября», выбранный человеком в Чикаго,
    // хранится как конец местного дня и по UTC приходится на 14-е.
    const dueChicago = inTimeZone('America/Chicago', () => {
      const d = new Date('2026-09-13T12:00:00.000Z');
      d.setHours(23, 59, 59, 999);
      return d;
    });
    const utcDay = dueChicago.toISOString().slice(0, 10);
    assert(utcDay === '2026-09-14', `ожидалось смещение на 14-е, получено ${utcDay}`);
    // А расстояние во времени сдвига не имеет.
    const now = new Date('2026-09-11T12:00:00.000Z');
    assert(
      deadlineRelative(dueChicago, now) === 'через 2 дня',
      `помощник тоже сдвинулся: ${deadlineRelative(dueChicago, now)}`,
    );
  }],
];

let failed = 0;
for (const [name, fn] of scenarios) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`✗ ${name}: ${(e as Error).message}`);
  }
}
if (failed > 0) process.exit(1);

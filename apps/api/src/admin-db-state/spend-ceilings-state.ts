// Пункт [the-lever-that-silently-did-nothing] 2026-09-30 — потолки
// расходов, которых оператор не видел.
//
// ЧТО БЫЛО. Пункт [ceilings-nobody-was-told-about] 2026-09-24 завёл
// реестр потолков расходов и довёл до документации все восемь
// перекрываемых переменных — до 2026-09-24 владелец не мог их выставить,
// потому что не знал, что они есть. Документация закрыта полностью:
// каждая из восьми названа и в `.env.example`, и в таблице VERCEL.md.
//
// ЧТО ОСТАЛОСЬ. Реестр не читает НИ ОДИН экран и ни один маршрут — только
// точечные вызовы `spendLimit(env)` в местах применения. Оператор не мог
// узнать, какие потолки действуют на ЭТОМ развёртывании: значения из
// окружения не видны нигде, а зашитые в коде — тем более.
//
// И ХУДШЕЕ, найденное замером. Неверное значение переменной падает на
// умолчание — это решение верное и проверенное (неверно настроенный env
// не должен ронять работу и не должен снимать потолок). Но падало оно
// МОЛЧА: `AI_CALLS_PER_USER_PER_DAY=abc` и `=-5` давали ровно то же
// «300», что и невыставленная переменная. То есть рычаг, ради которого
// прошлая сверка и делалась, можно было нажать и не узнать, что он не
// сработал. Это ровно «пробел выглядит как полнота», и в самом дорогом
// месте продукта — там, где тратятся деньги.
//
// ЧЕСТНАЯ ГРАНИЦА. Экран говорит, что́ продукт ПРОЧИТАЛ из окружения
// этого процесса, и ничего не говорит о том, что выставлено в Vercel:
// serverless-инстансы поднимаются с тем окружением, какое им дали, и
// сверить это с панелью провайдера отсюда нечем. Потолок — не расход:
// сколько уже потрачено, здесь не считается (это телеметрия, отдельная
// вкладка).

import { SPEND_LIMITS, resolveLimit, type LimitSource } from '../common/spend-limits';

export interface CeilingRow {
  readonly what: string;
  readonly env: string | null;
  readonly value: number;
  readonly unit: string;
  readonly source: LimitSource;
  /** Что стои́т в переменной, когда значение не прочиталось: оператор
   *  должен увидеть СВОЮ опечатку. */
  readonly raw: string | null;
  readonly fallback: number;
  readonly costs: string;
  /** Потолок снят совсем. Отдельным признаком, а не «значение 0»:
   *  ноль здесь означает «без потолка», и читать его как «нулевой
   *  потолок» — противоположный смысл. */
  readonly off: boolean;
}

export interface CeilingsState {
  readonly rows: readonly CeilingRow[];
  /** Сколько потолков настроено с ошибкой. Отдельным числом, чтобы
   *  оператор увидел это, не читая таблицу. */
  readonly misconfigured: number;
  /** Сколько снято совсем. */
  readonly off: number;
  /** Чего этот блок не знает — словами, на экран. */
  readonly doesNotKnow: readonly string[];
}

/** «Ноль отключает потолок» верно не для всех: у окна повторного
 *  использования и у предела длительности ролика ноль означает другое
 *  (окна нет / ролик любой длины не принимается). Список закрытый, чтобы
 *  экран не сказал «без потолка» там, где это неправда. */
const ZERO_MEANS_OFF = new Set([
  'AI_CALLS_PER_USER_PER_DAY',
  'AI_MEDIA_CALLS_PER_USER_PER_DAY',
  'TTS_CALLS_PER_USER_PER_DAY',
  'AI_BATCH_MATCH_PER_USER_PER_DAY',
  'TRANSCRIPTIONS_PER_USER_PER_DAY',
  'TRANSCRIPTION_MINUTES_PER_USER_PER_DAY',
]);

export const CEILINGS_DOES_NOT_KNOW: readonly string[] = [
  'Показано то, что продукт прочитал из окружения ЭТОГО процесса. Что выставлено в панели Vercel, отсюда не видно — сверьте, если значения не те, которых вы ждали.',
  'Это потолки, а не расходы: сколько уже потрачено, считает телеметрия, и у неё своя вкладка.',
  'Зашитые в коде потолки подкрутить нельзя, не трогая код — они перечислены здесь именно поэтому.',
];

export function ceilingsState(): CeilingsState {
  const rows: CeilingRow[] = SPEND_LIMITS.map((l) => {
    const resolved = resolveLimit(l.env, l.fallback);
    return {
      what: l.what,
      env: l.env,
      value: resolved.value,
      unit: l.unit,
      source: resolved.source,
      raw: resolved.raw,
      fallback: l.fallback,
      costs: l.costs,
      off: resolved.value === 0 && l.env !== null && ZERO_MEANS_OFF.has(l.env),
    };
  });
  return {
    rows,
    misconfigured: rows.filter((r) => r.source === 'умолчание: значение не прочитано').length,
    off: rows.filter((r) => r.off).length,
    doesNotKnow: CEILINGS_DOES_NOT_KNOW,
  };
}

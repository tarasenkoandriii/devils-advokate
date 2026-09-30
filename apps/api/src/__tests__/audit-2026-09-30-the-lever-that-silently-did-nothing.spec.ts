// Пункт [the-lever-that-silently-did-nothing] 2026-09-30 — причина,
// по которой потолок действует.
//
// НАХОДКА. Потолки расходов не читал ни один экран, и три разных
// состояния выглядели одинаково: «владелец выставил 300», «владелец
// ничего не выставлял» и «владелец выставил, но значение не
// прочиталось». Последнее хуже первых двух — рычаг кажется нажатым.
//
// ЧТО ПРОВЕРЯЕТСЯ. Что `resolveLimit` называет причину верно во всех
// четырёх случаях, что ЗНАЧЕНИЕ при этом не изменилось ни в одном
// (соседняя сверка 2026-09-24 перебирает те же варианты и обязана
// остаться зелёной), и что реестр доезжает до ответа маршрута целиком.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SPEND_LIMITS, limitFrom, resolveLimit } from '../common/spend-limits';
import { CEILINGS_DOES_NOT_KNOW, ceilingsState } from '../admin-db-state/spend-ceilings-state';

const REPO = join(__dirname, '..', '..', '..', '..');

/** Перебор с подстановкой переменной и обязательным возвратом прежнего
 *  значения: тест, оставляющий за собой окружение, ломает соседние. */
function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

describe('[the-lever-that-silently-did-nothing] причина, по которой потолок действует', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: «значение не прочитано» — отдельная причина, а не умолчание', () => {
    const broken = withEnv('TEST_CEILING_PROBE', 'abc', () => resolveLimit('TEST_CEILING_PROBE', 42));
    expect(broken.value).toBe(42);
    expect(broken.source).toBe('умолчание: значение не прочитано');
    expect(broken.raw).toBe('abc');

    const unset = withEnv('TEST_CEILING_PROBE', undefined, () => resolveLimit('TEST_CEILING_PROBE', 42));
    expect(unset.value).toBe(42);
    expect(unset.source).toBe('умолчание: переменная не задана');
    expect(unset.raw).toBe(null);

    // Значение одно и то же, причина разная — в этом и весь пункт.
    expect(broken.value === unset.value).toBe(true);
    expect(broken.source === unset.source).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: причина названа верно во всех случаях разбора', () => {
    const cases: Array<[string | undefined, number, string]> = [
      [undefined, 42, 'умолчание: переменная не задана'],
      ['', 42, 'умолчание: переменная не задана'],
      ['не число', 42, 'умолчание: значение не прочитано'],
      ['-5', 42, 'умолчание: значение не прочитано'],
      ['0', 0, 'окружение'],
      ['7', 7, 'окружение'],
      ['7.9', 7, 'окружение'],
    ];
    const seen: string[] = [];
    for (const [value, expectedValue, expectedSource] of cases) {
      const got = withEnv('TEST_CEILING_PROBE', value, () => resolveLimit('TEST_CEILING_PROBE', 42));
      seen.push(`${String(value)} → ${got.value} / ${got.source}`);
      expect(`${String(value)} → ${got.value} / ${got.source}`).toBe(
        `${String(value)} → ${expectedValue} / ${expectedSource}`,
      );
    }
    // Проба механизма: перебор и правда прошёл все семь, а не вышел на первом.
    expect(seen.length).toBe(7);
  });

  it('значение не изменилось: limitFrom по-прежнему возвращает то же число', () => {
    for (const value of [undefined, '', 'не число', '-5', '0', '7', '7.9']) {
      const both = withEnv('TEST_CEILING_PROBE', value, () => ({
        old: limitFrom('TEST_CEILING_PROBE', 42),
        now: resolveLimit('TEST_CEILING_PROBE', 42).value,
      }));
      expect(both.old).toBe(both.now);
    }
  });

  it('зашитый потолок назван зашитым, а не умолчанием', () => {
    const hard = resolveLimit(null, 20);
    expect(hard.source).toBe('зашито в коде');
    expect(hard.value).toBe(20);
    expect(hard.raw).toBe(null);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: до оператора доезжает ВЕСЬ реестр, а не часть', () => {
    const state = ceilingsState();
    expect(state.rows.length).toBe(SPEND_LIMITS.length);
    expect(state.rows.map((r) => r.what).sort()).toEqual(SPEND_LIMITS.map((l) => l.what).sort());
    // Замер пункта: десять потолков, восемь перекрываемых, два зашитых.
    // Обзорный аудит 2026-09-29 называл «13 и 6» — это было неверно, и
    // число здесь закреплено, чтобы неправда не вернулась.
    expect(state.rows.length).toBe(10);
    expect(state.rows.filter((r) => r.env !== null).length).toBe(8);
    expect(state.rows.filter((r) => r.env === null).length).toBe(2);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: «без потолка» говорится только там, где ноль и правда снимает потолок', () => {
    const off = withEnv('AI_CALLS_PER_USER_PER_DAY', '0', () => ceilingsState());
    const текстовые = off.rows.find((r) => r.env === 'AI_CALLS_PER_USER_PER_DAY');
    expect(текстовые?.off).toBe(true);
    expect(off.off).toBe(1);

    // У окна повторного использования ноль означает «окна нет», а не
    // «без потолка»: сказать «без потолка» было бы противоположным
    // смыслом. Список закрытый именно поэтому.
    const window = withEnv('AI_IDEMPOTENCY_WINDOW_MINUTES', '0', () => ceilingsState());
    expect(window.rows.find((r) => r.env === 'AI_IDEMPOTENCY_WINDOW_MINUTES')?.off).toBe(false);
    expect(window.off).toBe(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у КАЖДОГО перекрываемого потолка решено, что означает ноль', () => {
    // Без перебора по всем восьми список «ноль снимает потолок» можно
    // было урезать на одну запись незаметно — мутация это показала.
    // Ожидание записано литералами: их читает человек, а не выводит тот
    // же код, который проверяется.
    const ЗНАЧЕНИЕ_НОЛЬ: Record<string, boolean> = {
      AI_CALLS_PER_USER_PER_DAY: true,
      AI_MEDIA_CALLS_PER_USER_PER_DAY: true,
      TTS_CALLS_PER_USER_PER_DAY: true,
      AI_BATCH_MATCH_PER_USER_PER_DAY: true,
      TRANSCRIPTIONS_PER_USER_PER_DAY: true,
      TRANSCRIPTION_MINUTES_PER_USER_PER_DAY: true,
      // Ноль здесь означает «окна нет», а не «без потолка».
      AI_IDEMPOTENCY_WINDOW_MINUTES: false,
      // Ноль здесь означает «ролик любой длины не принимается».
      MEDIA_REVIEW_MAX_DURATION_SECONDS: false,
    };
    const overridable = SPEND_LIMITS.filter((l) => l.env !== null).map((l) => l.env as string);
    expect(overridable.sort()).toEqual(Object.keys(ЗНАЧЕНИЕ_НОЛЬ).sort());

    const actual: Record<string, boolean> = {};
    for (const env of overridable) {
      actual[env] = withEnv(env, '0', () => ceilingsState()).rows.find((r) => r.env === env)?.off === true;
    }
    expect(actual).toEqual(ЗНАЧЕНИЕ_НОЛЬ);
  });

  it('ошибка настройки посчитана отдельным числом', () => {
    const one = withEnv('TTS_CALLS_PER_USER_PER_DAY', 'сто', () => ceilingsState());
    expect(one.misconfigured).toBe(1);
    const none = ceilingsState();
    expect(none.misconfigured).toBe(0);
  });

  it('состояние доезжает до маршрута «БД», а не остаётся в модуле', () => {
    const service = readFileSync(join(__dirname, '..', 'admin-db-state', 'admin-db-state.service.ts'), 'utf8');
    expect(service.includes('spendCeilings: ceilingsState()')).toBe(true);
    const page = readFileSync(join(REPO, 'apps', 'admin', 'src', 'app', 'db', 'page.tsx'), 'utf8');
    expect(page.includes('<SpendCeilingsCard state={state.spendCeilings} />')).toBe(true);
  });

  it('записано, чего блок не знает — и это уезжает на экран', () => {
    expect(CEILINGS_DOES_NOT_KNOW.length).toBe(3);
    expect(CEILINGS_DOES_NOT_KNOW.filter((s) => s.trim().length === 0)).toEqual([]);
    expect(ceilingsState().doesNotKnow).toEqual(CEILINGS_DOES_NOT_KNOW);
  });
});

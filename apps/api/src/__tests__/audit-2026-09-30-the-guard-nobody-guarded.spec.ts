// Сверка 2026-09-30 — сторож, которого не сторожил никто.
//
// НАЙДЕНО. `common/timing-safe-equal.ts` — единственная точка сравнения
// секретов во всём проекте: через неё идут девять мест, в том числе все
// служебные маршруты, которые в проде дёргает pg_cron, и оба вебхука.
// Проверки у неё не было ни одной. Мутация «`return timingSafeEqual(a, b)`
// → `return provided === expected`» прошла ВЕСЬ набор (1858 jest-тестов и
// 131 standalone-спеку) зелёным.
//
// При этом реестр `common/public-surfaces.ts` СЛОВАМИ утверждает «через
// safeSecretEqual», и это утверждение спеки проверяют. То есть
// проверялась фраза о механизме, а сам механизм — нет. Ровно тот класс,
// который разобран в `audit-2026-09-04-guard-audit.spec.ts`: проверка
// подтверждает наличие слова.
//
// И ЕЩЁ ОДНО, найденное при замере уже самого дерева: сравнение секрета
// обычным `!==` в проекте оставалось ровно одно —
// `interview-pool-candidate.service.ts`, ссылка на профиль кандидата,
// публичная страница по токену. «Правило было, просто не везде» в
// девятый раз. Закрыто вместе с этим заходом.
//
// ЧЕГО ЭТА СВЕРКА НЕ УМЕЕТ, и это надо сказать прямо. У свойства
// «сравнение идёт в постоянное время» НЕТ поведенческой подписи:
// `===` и `timingSafeEqual` возвращают один и тот же ответ на одних и
// тех же входах, а измерять наносекунды в тесте — способ получить
// флакающий тест, а не проверку. Поэтому МЕХАНИЗМ здесь проверяется по
// тексту модуля, и это осознанный выбор, а не недосмотр: текстовая
// проверка законна там, где инвариант иначе не выразить. Всё
// остальное — поведение: страховка от разной длины (без неё
// `timingSafeEqual` БРОСАЕТ, а не возвращает `false`), пустые входы и
// то, что правило применено во всех местах сравнения секретов.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { safeSecretEqual } from '../common/timing-safe-equal';

const API_SRC = join(__dirname, '..');

function walkSources(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(full);
    }
  })(API_SRC);
  return out;
}

function code(rel: string): string {
  return readFileSync(join(API_SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('[the-guard-nobody-guarded] сравнение секретов', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: равные секреты совпадают, неравные той же длины — нет', () => {
    expect(safeSecretEqual('s3cr3t-value-16b', 's3cr3t-value-16b')).toBe(true);
    // Та же длина, отличие в последнем знаке: без него «совпадение по
    // префиксу» прошло бы.
    expect(safeSecretEqual('s3cr3t-value-16b', 's3cr3t-value-16c')).toBe(false);
    // И отличие в ПЕРВОМ знаке — чтобы проверка не держалась на том,
    // что сравнение идёт слева направо.
    expect(safeSecretEqual('s3cr3t-value-16b', 'S3cr3t-value-16b')).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: разная длина даёт false, а не исключение', () => {
    // `crypto.timingSafeEqual` на разных длинах БРОСАЕТ. Страховка по
    // длине в модуле — не украшение: без неё любой запрос с секретом
    // не той длины превращался бы в 500 вместо 401. Проверяется
    // поведением, потому что здесь оно есть.
    expect(safeSecretEqual('короткий', 'значительно длиннее')).toBe(false);
    expect(safeSecretEqual('значительно длиннее', 'короткий')).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: пустое и отсутствующее не совпадают ни с чем, включая себя', () => {
    // Иначе запрос БЕЗ заголовка проходил бы там, где переменная
    // окружения не выставлена, — то есть открытая дверь ровно в той
    // конфигурации, в которой её никто не проверяет.
    expect(safeSecretEqual(undefined, undefined)).toBe(false);
    expect(safeSecretEqual(null, null)).toBe(false);
    expect(safeSecretEqual('', '')).toBe(false);
    expect(safeSecretEqual('', 'секрет')).toBe(false);
    expect(safeSecretEqual('секрет', '')).toBe(false);
    expect(safeSecretEqual('секрет', undefined)).toBe(false);
    expect(safeSecretEqual(undefined, 'секрет')).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: механизм — именно постоянное время, а не строковое равенство', () => {
    // Единственное текстовое утверждение этой спеки, и причина названа
    // в шапке: у постоянного времени нет поведенческой подписи.
    const src = code('common/timing-safe-equal.ts');
    expect(src.includes('timingSafeEqual(a, b)')).toBe(true);
    // И прямой запрет обратной мутации: строкового равенства в теле
    // быть не должно.
    expect(/return\s+provided\s*===\s*expected/.test(src)).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни одно место в дереве не сравнивает секрет обычным ===', () => {
    // Правило по дереву, а не список известных мест: ценность здесь в
    // ДЕСЯТОМ сравнении, которого ещё нет.
    const offenders: string[] = [];
    for (const file of walkSources()) {
      const src = code(file.slice(API_SRC.length + 1))
        // Сам модуль и реестр поверхностей называют предмет по имени —
        // это не сравнение.
        .replace(/safeSecretEqual/g, 'ОК');
      for (const m of src.matchAll(
        /(\w*(?:[Ss]ecret|[Tt]oken)\w*)\s*(?:!==|===)\s*(\w*(?:[Ss]ecret|[Tt]oken)\w*)/g,
      )) {
        offenders.push(`${file.slice(API_SRC.length + 1)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ИЗМЕРЕНИЕ: сколько мест идут через общий помощник', () => {
    // Число живёт здесь, чтобы следующая сверка начинала с факта.
    // Девять на 2026-09-30: два вебхука, шесть служебных маршрутов под
    // секретами pg_cron и публичная ссылка на профиль кандидата,
    // добавленная этим заходом.
    let sites = 0;
    for (const file of walkSources()) {
      if (file.endsWith('timing-safe-equal.ts')) continue;
      const src = code(file.slice(API_SRC.length + 1));
      sites += (src.match(/safeSecretEqual\(/g) ?? []).length;
    }
    // Было 10 до Пункта [the-registry-promised-401-and-gave-500]
    // 2026-09-30. Стало 5: пять контроллеров общего секрета перешли на
    // `common/dispatch-secret.ts`, и своё сравнение у них исчезло —
    // вместе с пятью копиями режима отказа, из-за которых не
    // выставленная переменная давала 500 вместо 503. Число уменьшилось
    // потому, что копий стало меньше, а не потому, что проверок стало
    // меньше: что все шесть идут через одно место, держит
    // `audit-2026-09-30-the-ceiling-asked-you-to-identify-yourself.spec.ts`.
    expect(sites).toBe(5);
  });
});

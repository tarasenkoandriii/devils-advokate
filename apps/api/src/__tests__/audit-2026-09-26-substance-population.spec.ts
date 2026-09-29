// Пункт [finding-without-substance-2] 2026-09-26 — ЗАМКНУТОСТЬ НАСЕЛЕНИЯ.
//
// Первый проход закрыл восемь мест и назвал остаток. Так остаток и
// остался бы: девятый валидатор, написанный завтра, снова проверит поле
// на `typeof === 'string'`, и не заметит этого никто — «правило было,
// просто не везде» в своём устойчивом состоянии.
//
// Поэтому здесь проверяется не «сколько полей закрыто», а то, что у
// КАЖДОГО места есть ОТВЕТ. Население замкнуто и определяется
// механически: валидаторы, переданные роутеру как `validateOutput`, —
// ровно они превращают ответ модели в запись, которую читает человек.
// Ответов допускается три:
//
//   1. место в реестре `CLAIM_SUBSTANCE` — разобрано поимённо;
//   2. место в `SUBSTANCE_OUT_OF_SCOPE` — разобрано и не подошло, с
//      записанной причиной;
//   3. валидатор требует непустоты хотя бы у одного своего строкового
//      поля — автор вопрос СЕБЕ ЗАДАВАЛ. Это слабее первых двух, и
//      названо остатком, а не закрытым.
//
// Четвёртого ответа нет. Новый валидатор, не попавший ни в один из трёх,
// красит эту спеку — и его автору придётся сказать, что будет, если поле
// придёт пустым.
//
// ЧЕСТНАЯ ГРАНИЦА. Спека читает ТЕКСТ исходников, и по-другому замкнутое
// население не собрать: список «кого передают роутеру» существует только
// в вызовах. Поэтому здесь нет ни одной проверки формулировок — только
// имена и числа; поведение проверяется соседней спекой, которая
// исходники не читает вовсе.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  CLAIM_SUBSTANCE,
  SUBSTANCE_OUT_OF_SCOPE,
  SUBSTANCE_PARTIAL_REMAINDER,
} from '../common/claim-substance';

const SRC = join(__dirname, '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      sources(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sources(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

/** Имена, переданные роутеру как `validateOutput`. Лямбды и поля
 * (`params.validateOutput`) сюда не попадают: у них нет имени, по
 * которому можно спросить реестр, — и их отдельно считает проба ниже. */
function validatorNames(): string[] {
  const names = new Set<string>();
  for (const { text } of FILES) {
    for (const m of text.matchAll(/validateOutput:\s*([A-Za-z_]\w*)\b/g)) {
      if (m[1] !== 'params' && m[1] !== 'validate') names.add(m[1]);
    }
  }
  return [...names].sort();
}

/** ВСЕ тела функций с этим именем — по балансу фигурных скобок.
 *
 * Именно все, а не первое найденное, и это поправка к первой версии
 * спеки. Имена в проекте ПОВТОРЯЮТСЯ: `isValidBreakdown` живёт в четырёх
 * файлах, `isValidQuestionsPayload` — в двух, и в одном из них требование
 * непустоты есть, а в другом его не было. Проход, останавливающийся на
 * первом совпадении, зеленел бы за счёт чужого файла — и именно так
 * `missing-information` и спрятался от первого замера. */
function functionBodies(name: string): { file: string; body: string }[] {
  const out: { file: string; body: string }[] = [];
  for (const { path, text } of FILES) {
    const re = new RegExp(`function\\s+${name}\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const open = text.indexOf('{', m.index);
      let depth = 0;
      for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) {
            out.push({ file: path, body: text.slice(open, i + 1) });
            break;
          }
        }
      }
    }
  }
  return out;
}

/** Относится ли запись реестра К ЭТОМУ файлу.
 *
 * Поле `where` реестра называет каталоги места (у одной записи их
 * четыре — четыре идентичные копии валидатора). Берём из него имена
 * каталогов и спрашиваем, лежит ли файл в одном из них. */
function registryCovers(key: string, file: string): boolean {
  const site = CLAIM_SUBSTANCE.find((s) => s.key === key);
  if (!site) return false;
  const dirs = [...site.where.matchAll(/([a-z][a-z-]*)\//g)].map((m) => m[1]);
  return dirs.some((dir) => file.includes(`/${dir}/`));
}

const NON_EMPTY_FORMS = [
  'allFilled(',
  'allStringsFilled(',
  'filled(',
  'isNonEmptyString',
  '.trim().length',
  '.length > 0',
];

function asksNonEmpty(body: string): boolean {
  return NON_EMPTY_FORMS.some((form) => body.includes(form));
}

function checksStringType(body: string): boolean {
  return /typeof\s+[\w.?[\]']+\s*===\s*'string'/.test(body);
}

type Resolver = (name: string) => { file: string; body: string }[];

/** Места без ответа. Вынесено отдельной функцией с ПОДСТАВЛЯЕМЫМ
 * разрешением имён — иначе главное свойство прохода (он смотрит КАЖДУЮ
 * копию имени, а не первую) нечем проверить: сегодня непокрытых копий
 * нет, и мутация «смотреть только первую» ничего бы не изменила. Ровно
 * этот вид дыры — «правило есть, а доказательства, что оно работает,
 * нет» — этот проект уже ловил мутациями не раз. */
function unansweredCopies(names: readonly string[], resolve: Resolver): string[] {
  const registered = new Set(CLAIM_SUBSTANCE.map((s) => s.key));
  const outOfScope = new Set(SUBSTANCE_OUT_OF_SCOPE.map((s) => s.key));
  const out: string[] = [];
  for (const name of names) {
    if (outOfScope.has(name)) continue;
    for (const found of resolve(name)) {
      if (!checksStringType(found.body)) continue; // строковых полей нет вовсе
      if (asksNonEmpty(found.body)) continue; // остаток: вопрос себе задавали
      if (registered.has(name) && registryCovers(name, found.file)) continue;
      out.push(`${name} @ ${found.file}`);
    }
  }
  return out;
}

describe('Пункт [finding-without-substance-2] 2026-09-26: население замкнуто', () => {
  const names = validatorNames();

  it('проба механизма: валидаторы найдены, и их тела разобраны — ВСЕ копии', () => {
    // Числа точные. Молча усохший разбор прошёл бы все проверки ниже
    // насквозь: пустое население покрыто реестром тривиально.
    expect(names.length).toBe(59);
    const bodies = names.flatMap(functionBodies);
    // Тел БОЛЬШЕ, чем имён: у одноимённых валидаторов их несколько.
    expect(bodies.length).toBe(71);
    expect(names.filter((n) => functionBodies(n).length === 0)).toEqual([]);
    expect(CLAIM_SUBSTANCE.length).toBe(21);
    expect(SUBSTANCE_OUT_OF_SCOPE.length).toBe(6);
  });

  it('МЕРА: какие имена валидаторов повторяются в разных файлах', () => {
    // Список точный, потому что на нём споткнулся первый замер этого
    // пункта: `missing-information` спрятался за одноимённым валидатором
    // из `breaking-questions`, где непустота уже требовалась.
    const shared = names
      .map((name) => ({ name, n: functionBodies(name).length }))
      .filter((x) => x.n > 1)
      .map((x) => `${x.name}=${x.n}`);
    expect(shared.sort()).toEqual([
      'isValidBreakdown=4',
      'isValidConclusion=2',
      'isValidExtraction=7',
      'isValidQuestionsPayload=2',
      'isValidRecommendationPayload=2',
    ]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у каждого места есть ОДИН из трёх ответов, четвёртого нет', () => {
    // КАЖДАЯ копия отвечает за себя, и запись в реестре отвечает только
    // за СВОИ каталоги. Иначе одноимённый валидатор из другого домена
    // проезжал бы на чужой записи: `isValidRecommendationPayload` есть и
    // в best-next-move (в реестре), и в weather-forecast (нет), и первая
    // версия этой проверки пропускала вторую даром.
    const unanswered = unansweredCopies(names, functionBodies).map((line) =>
      line.slice(line.indexOf('/src/') + 5),
    );
    expect(unanswered).toEqual([]);
  });

  it('проба механизма: проход смотрит КАЖДУЮ копию имени, а не первую', () => {
    // Синтетический случай ровно той формы, на которой споткнулся первый
    // замер: одно имя, два файла, непустоту требует только один.
    const asks = { file: '/src/first/a.service.ts', body: "typeof x === 'string' && allFilled(x, ['y'])" };
    const silent = { file: '/src/second/b.service.ts', body: "typeof x === 'string'" };
    const collision: Resolver = () => [asks, silent];
    expect(unansweredCopies(['isValidВыдуманный'], collision)).toEqual(['isValidВыдуманный @ /src/second/b.service.ts']);
    // Обратная сторона: когда непустоту требуют обе копии — тихо.
    expect(unansweredCopies(['isValidВыдуманный'], () => [asks, asks])).toEqual([]);
    // И порядок не важен: молчащая копия найдётся и первой.
    expect(unansweredCopies(['isValidВыдуманный'], () => [silent, asks]).length).toBe(1);
  });

  it('проба механизма: запись реестра отвечает за СВОИ каталоги, а не за имя вообще', () => {
    // Второй способ проехать даром, и он тоже не гипотетический:
    // `isValidRecommendationPayload` есть и в best-next-move (в реестре),
    // и в weather-forecast (нет). Сегодня вторая копия непустоту требует
    // сама, поэтому без этой пробы мутация «считать запись реестра
    // ответом за любое имя» не поменяла бы ничего.
    const key = 'isValidRecommendationPayload';
    const own = { file: '/src/best-next-move/best-next-move.service.ts', body: "typeof x === 'string'" };
    const foreign = { file: '/src/weather-forecast/weather-forecast.service.ts', body: "typeof x === 'string'" };
    // Свой каталог — запись реестра и есть ответ.
    expect(unansweredCopies([key], () => [own])).toEqual([]);
    // Чужой — ответа нет, хотя имя в реестре.
    expect(unansweredCopies([key], () => [foreign])).toEqual([`${key} @ ${foreign.file}`]);
    // И запись с четырьмя каталогами отвечает за все четыре.
    const four = 'isValidBreakdown';
    for (const dir of ['dtp', 'health', 'family-law', 'investment']) {
      expect(unansweredCopies([four], () => [{ file: `/src/${dir}/x.service.ts`, body: "typeof x === 'string'" }])).toEqual([]);
    }
    expect(unansweredCopies([four], () => [{ file: '/src/job-search/x.service.ts', body: "typeof x === 'string'" }]).length).toBe(1);
  });

  it('обратная проба: тот же проход находит место без ответа, если оно появится', () => {
    // Без неё предыдущий тест проходил бы и в мире, где `asksNonEmpty`
    // отвечает «да» на что угодно, — то есть не проверял бы ничего.
    expect(asksNonEmpty("typeof x === 'string'")).toBe(false);
    expect(asksNonEmpty('allFilled(item, fields)')).toBe(true);
    expect(checksStringType("typeof c?.note === 'string'")).toBe(true);
    expect(checksStringType('Array.isArray(p)')).toBe(false);
  });

  it('МЕРА: сколько мест каким ответом закрыто', () => {
    const registered = new Set(CLAIM_SUBSTANCE.map((s) => s.key));
    const outOfScope = new Set(SUBSTANCE_OUT_OF_SCOPE.map((s) => s.key));
    let inRegistry = 0;
    let named = 0;
    let remainder = 0;
    let withoutStrings = 0;
    for (const name of names) {
      const bodies = functionBodies(name);
      if (registered.has(name)) inRegistry++;
      else if (outOfScope.has(name)) named++;
      else if (bodies.every((b) => !checksStringType(b.body))) withoutStrings++;
      else remainder++;
    }
    expect([inRegistry, named, withoutStrings, remainder]).toEqual([21, 6, 4, 28]);
    expect(SUBSTANCE_PARTIAL_REMAINDER.length).toBeGreaterThan(80);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: реестр и список вне границы не пересекаются и не выдумывают имён', () => {
    const registered = CLAIM_SUBSTANCE.map((s) => s.key);
    const outOfScope = SUBSTANCE_OUT_OF_SCOPE.map((s) => s.key);
    expect(registered.filter((k) => outOfScope.includes(k))).toEqual([]);
    // Каждое имя из обоих списков существует в коде: запись про
    // валидатор, которого нет, — тот же пробел, только незаметный.
    expect([...registered, ...outOfScope].filter((k) => functionBodies(k).length === 0)).toEqual([]);
  });

  it('у каждого места вне границы записана причина, а не отметка', () => {
    for (const site of SUBSTANCE_OUT_OF_SCOPE) {
      expect(`${site.key}: ${site.why.length > 80}`).toBe(`${site.key}: true`);
    }
  });
});

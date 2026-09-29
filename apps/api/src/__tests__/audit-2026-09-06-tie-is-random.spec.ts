// Сверка 2026-09-06 — у среза не было определённого порядка.
//
// МЕХАНИКА. `@default(now())` у Prisma на PostgreSQL это
// `DEFAULT CURRENT_TIMESTAMP`, а `now()` в Postgres — время НАЧАЛА
// ТРАНЗАКЦИИ, не момент вставки строки. Значит у всех строк, созданных
// одной транзакцией (а продукт создаёт их пачками: прецеденты
// поведения, аргументы, гипотезы мотива, сценарии исхода, сегменты
// расшифровки), `createdAt` совпадает ДО МИЛЛИСЕКУНДЫ.
//
// Сортировка по такому столбцу порядка не задаёт: строки с равным
// ключом база вправе вернуть в любом порядке, и порядок этот зависит
// от плана запроса, а не от данных. Пока список отдаётся целиком, это
// косметика. С потолком `take` это уже другое: определяется САМ СОСТАВ
// среза.
//
// НАЙДЕННОЕ. Измерено: срезов с потолком в API двадцать восемь, и НИ У
// ОДНОГО не было детерминированного порядка — ни одного уникального
// столбца в `orderBy`. Самое дорогое место:
//
//   `outcome-forecasting`, `motive-analysis`, `sparring`,
//   `archetype-perspective` берут по `PRECEDENTS_LIMIT` прецедентов
//   поведения ЧЕЛОВЕКА и отдают их модели как опору вывода. Прецеденты
//   одного поиска создаются одной транзакцией, значит их `createdAt`
//   одинаков, значит состав среза мог отличаться от запроса к запросу
//   — и вывод о человеке строился каждый раз на другой опоре, а
//   подавался как один и тот же. Ровно там, где продукт особенно
//   старается назвать опору ([partial-basis]), сама опора была
//   нестабильна.
//
// Ещё четыре среза сортируются по `weight` аргумента — шкала короткая,
// совпадения в ней обычное дело, и «три самых весомых аргумента»
// означало «три из тех, что делят первое место, какие достанет база».
//
// ПОЧЕМУ ПРАВИЛО ЗДЕСЬ ТЕКСТОВОЕ, И ЭТО НЕ ОТСТУПЛЕНИЕ ОТ
// ДИСЦИПЛИНЫ. Проверять поведением нечего: недетерминированность живёт
// в плане запроса Postgres, и заглушка prisma в тестах вернёт ровно
// тот порядок, который сама и заложила — то есть подтвердит не код, а
// заглушку. Утверждение «в запросе есть уникальный столбец» проверяется
// по запросу, и это единственный честный инструмент. Правило проверено
// ПРОБОЙ — настоящим текстом нарушителя.
//
// ЧТО НЕ ДЕЛАЛОСЬ: направление второго ключа повторяет первый
// (`desc` → `id: 'desc'`) не ради смысла, а ради предсказуемости
// чтения; cuid начинается с метки времени, поэтому внутри одной метки
// такой порядок ещё и осмыслен. Определённость здесь важнее выбора
// направления, и выдавать выбор направления за продуктовое решение
// было бы преувеличением.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const API_SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/** Срезы с потолком и их порядок, прямо из исходников. Обход дерева, не
 * список файлов: новый срез в новом домене обязан попасть под правило. */
function cappedQueries(): Array<{ file: string; line: number; orderBy: string }> {
  const out: Array<{ file: string; line: number; orderBy: string }> = [];
  for (const file of tsFiles(API_SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\.findMany\(\{/g)) {
      let i = m.index! + m[0].length - 1;
      let depth = 0;
      while (i < src.length) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
        i++;
      }
      const arg = src.slice(m.index! + m[0].length, i);
      if (!/\btake\s*:/.test(arg)) continue;
      const ob = /orderBy:\s*(\[[\s\S]*?\]|\{[^{}]*\})/.exec(arg);
      out.push({
        file: file.slice(API_SRC.length + 1),
        line: src.slice(0, m.index!).split('\n').length,
        orderBy: ob ? ob[1].replace(/\s+/g, ' ') : 'НЕТ',
      });
    }
  }
  return out;
}

describe('Сверка [tie-is-random]: у среза с потолком обязан быть определённый порядок', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: каждый срез с потолком сортируется в том числе по уникальному столбцу', () => {
    const undetermined = cappedQueries()
      .filter((q) => !/\bid\s*:/.test(q.orderBy))
      .map((q) => `${q.file}:${q.line} orderBy=${q.orderBy}`);
    expect(undetermined).toEqual([]);
  });

  it('измерение остаётся на виду: срезов с потолком столько, сколько их есть', () => {
    // Число живёт здесь, чтобы следующая сверка начинала с факта, а не
    // с пересчёта. Рост сам по себе не дефект — дефект в проверке выше.
    const total = cappedQueries().length;
    expect(total).toBeGreaterThanOrEqual(28);
  });

  it('проба: новый срез без уникального столбца правилом ловится', () => {
    // Правило проверено настоящим текстом нарушителя, а не рассуждением
    // о нём — прямой урок [guard-scope], где проверка обещала о себе
    // то, чего не делала.
    const offender = `this.prisma.behaviorPrecedent.findMany({ where: { personId }, take: 5, orderBy: { createdAt: 'desc' } })`;
    const arg = offender.slice(offender.indexOf('({') + 2, offender.lastIndexOf('})'));
    const ob = /orderBy:\s*(\[[\s\S]*?\]|\{[^{}]*\})/.exec(arg)!;
    expect(/\btake\s*:/.test(arg)).toBe(true);
    expect(/\bid\s*:/.test(ob[1])).toBe(false);
  });

  it('проба наоборот: исправленный срез правилом НЕ ловится', () => {
    const fixed = `findMany({ where: { personId }, take: 5, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })`;
    const ob = /orderBy:\s*(\[[\s\S]*?\]|\{[^{}]*\})/.exec(fixed)!;
    expect(/\bid\s*:/.test(ob[1])).toBe(true);
  });

  it('прецеденты поведения — самое дорогое место — исправлены во всех четырёх сервисах', () => {
    const users = ['outcome-forecasting', 'motive-analysis', 'sparring', 'archetype-perspective'];
    const sites = cappedQueries().filter((q) => users.some((u) => q.file.startsWith(u)));
    expect(sites.length).toBeGreaterThanOrEqual(4);
    for (const s of sites) expect(s.orderBy).toMatch(/\bid\s*:/);
  });
});

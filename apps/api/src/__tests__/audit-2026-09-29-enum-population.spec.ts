// Пункт [enum-copy-drifted] 2026-09-29 — ЗАМКНУТОСТЬ НАСЕЛЕНИЯ.
//
// Соседняя спека доказывает, что нынешние сверки принимают каждое
// значение своего перечисления. Она ничего не говорит о сверке, которую
// напишут завтра: новый список литералов рядом с новым валидатором
// появится так же незаметно, как появились прежние двадцать пять.
//
// Здесь проверяется другое: в исходниках НЕ ДОЛЖНО быть переписанных
// руками списков значений перечислений. Населением служит сама схема —
// 99 перечислений, — а проходом по коду ищется литеральный набор строк,
// который совпадает со значениями какого-нибудь из них.
//
// ЧЕСТНАЯ ГРАНИЦА. Это проверка ФОРМЫ кода, и по-другому её не сделать:
// «переписан ли список руками» — вопрос о тексте. Доказательство, что
// замена работает, даёт соседняя спека, которая гоняет каждое значение
// через настоящие сверки. Одна без другой ничего не стоит.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');
const SCHEMA = readFileSync(join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');

function sources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/** Значения каждого перечисления схемы. */
function schemaEnums(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of SCHEMA.matchAll(/^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const values = m[2]
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter((l) => /^\w+$/.test(l));
    out.set(m[1], values);
  }
  return out;
}

const ENUMS = schemaEnums();

/** Текст без комментариев: пример в комментарии — рассказ о дефекте, а
 * не дефект. Тот же приём, что уже применялся к сторожу страницы
 * приватности, и по той же причине. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

interface Copy {
  file: string;
  line: number;
  enumName: string;
  values: string[];
}

/** Литеральные наборы строк, совпадающие со значениями перечисления:
 * массив `['A', 'B']` или цепочка `x === 'A' || x === 'B'`. */
function literalCopies(files: readonly { file: string; text: string }[]): Copy[] {
  const out: Copy[] = [];
  for (const { file, text } of files) {
    const src = withoutComments(text);
    const sets: Array<{ index: number; values: string[] }> = [];
    for (const m of src.matchAll(/\[((?:\s*'[A-Za-z_]\w*'\s*,?){2,})\]/g)) {
      sets.push({ index: m.index as number, values: [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) });
    }
    for (const m of src.matchAll(/(\w+(?:\.\w+)*)\s*===\s*'[A-Za-z_]\w*'(?:\s*\|\|\s*\1\s*===\s*'[A-Za-z_]\w*')+/g)) {
      sets.push({ index: m.index as number, values: [...m[0].matchAll(/'([^']+)'/g)].map((x) => x[1]) });
    }
    for (const set of sets) {
      for (const [enumName, values] of ENUMS) {
        if (values.length < 2) continue;
        const inside = set.values.filter((v) => values.includes(v));
        // Совпадением считается набор, ЦЕЛИКОМ состоящий из значений
        // перечисления: иначе случайная пара строк из чужого словаря
        // попадала бы в находки и правило кричало бы не по делу.
        if (inside.length < 2 || inside.length !== set.values.length) continue;
        out.push({
          file: relative(SRC, file),
          line: src.slice(0, set.index).split('\n').length,
          enumName,
          values: set.values,
        });
        break;
      }
    }
  }
  return out;
}

const FILES = sources().map((file) => ({ file, text: readFileSync(file, 'utf8') }));

/** Расхождения между схемой и сгенерированным клиентом.
 *
 * Вынесено функцией с ПОДСТАВЛЯЕМЫМ клиентом — иначе главное свойство
 * сверки нечем проверить: сегодня схема и клиент совпадают, и мутация
 * «перестать следить за порядком» ничего бы не изменила. Тот же вид
 * дыры, который в этом проекте уже ловился мутациями дважды. */
function clientDrift(
  schema: ReadonlyMap<string, readonly string[]>,
  client: Record<string, Record<string, string> | undefined>,
): string[] {
  const drift: string[] = [];
  for (const [name, values] of schema) {
    const generated = client[name];
    if (!generated) {
      drift.push(`${name}: нет в клиенте`);
      continue;
    }
    const fromClient = Object.values(generated).join(',');
    // Порядок сравнивается НАРОЧНО: из него выводятся типы, и
    // переставленные значения означают пересобранный не из этой схемы
    // клиент.
    if (fromClient !== values.join(',')) drift.push(`${name}: схема [${values}] ≠ клиент [${fromClient}]`);
  }
  return drift;
}

describe('Пункт [enum-copy-drifted] 2026-09-29: переписанных руками перечислений нет', () => {
  it('проба механизма: схема разобрана, исходники прочитаны', () => {
    // Числа точные: усохший разбор нашёл бы ноль копий и остался бы
    // зелёным, ничего не проверив.
    expect(ENUMS.size).toBe(99);
    expect([...ENUMS.values()].filter((v) => v.length >= 2).length).toBe(99);
    expect(FILES.length).toBeGreaterThan(400);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни одного литерального списка значений перечисления', () => {
    expect(literalCopies(FILES).map((c) => `${c.file}:${c.line} ${c.enumName} [${c.values}]`)).toEqual([]);
  });

  it('проба механизма: проход находит копию, когда она есть', () => {
    // Без неё главный тест проходил бы и в мире, где разбор не находит
    // ничего: пустой список — тоже пустой список.
    const arrayCopy = [{ file: join(SRC, 'выдуманный.ts'), text: "if (['LOW', 'MEDIUM', 'HIGH'].includes(x)) return true;" }];
    expect(literalCopies(arrayCopy).length).toBe(1);

    const chainCopy = [{ file: join(SRC, 'выдуманный.ts'), text: "return v === 'PROCEED' || v === 'RECONSIDER';" }];
    expect(literalCopies(chainCopy).length).toBe(1);

    // И обратная сторона: набор, который перечислением НЕ является,
    // находкой не считается — иначе правило кричало бы на каждом словаре.
    const notEnum = [{ file: join(SRC, 'выдуманный.ts'), text: "const keys = ['заголовок', 'подпись', 'ссылка'];" }];
    expect(literalCopies(notEnum)).toEqual([]);

    // Набор, где лишь ЧАСТЬ строк из перечисления, тоже не находка:
    // это чужой словарь, случайно задевший одно-два значения.
    const mixed = [{ file: join(SRC, 'выдуманный.ts'), text: "const mixed = ['LOW', 'MEDIUM', 'совсем-другое'];" }];
    expect(literalCopies(mixed)).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: сгенерированный клиент совпадает со схемой — иначе копией становится ОН', () => {
    // Соседняя спека гоняет каждое значение через `@prisma/client`, то
    // есть через СГЕНЕРИРОВАННЫЙ клиент. А он сам — копия схемы, и
    // устаревает точно так же: `db push` без `generate`, схема из другой
    // ветки, клиент из кэша `node_modules`. Тогда «сверка принимает все
    // значения» означало бы «принимает все значения СТАРОГО
    // перечисления», и весь пункт держался бы на копии, за которой никто
    // не следит. Здесь клиент сверяется со схемой напрямую — и порядок
    // значений тоже, потому что из него выводятся типы.
    //
    // ЧЕСТНАЯ ГРАНИЦА: в этой песочнице `prisma generate` не проходит
    // (движок тянется с закрытого сети адреса), поэтому расхождение
    // здесь означает «клиент пересобрать», а не «правка неверна».
    const client = require('@prisma/client') as Record<string, Record<string, string> | undefined>;
    expect(clientDrift(ENUMS, client)).toEqual([]);
  });

  it('проба механизма: сверка со клиентом видит и пропажу, и ПЕРЕСТАВЛЕННЫЙ порядок', () => {
    const schema = new Map([['Проба', ['A', 'B', 'C']]]);
    expect(clientDrift(schema, { Проба: { A: 'A', B: 'B', C: 'C' } })).toEqual([]);
    expect(clientDrift(schema, {})).toEqual(['Проба: нет в клиенте']);
    expect(clientDrift(schema, { Проба: { A: 'A', B: 'B' } }).length).toBe(1);
    // Переставленный порядок — тоже расхождение: клиент собран не из
    // этой схемы, а типы выводятся именно из него.
    expect(clientDrift(schema, { Проба: { C: 'C', B: 'B', A: 'A' } }).length).toBe(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: пример в КОММЕНТАРИИ находкой не считается', () => {
    // В `common/enum-values.ts` форма дефекта показана дословно — иначе
    // объяснить, от чего заведено правило, нечем. Правило, кричащее на
    // собственное объяснение, снимают вместе с объяснением.
    const inComment = [{
      file: join(SRC, 'выдуманный.ts'),
      text: "// ['INACCURACY', 'DISCREPANCY', 'STRONG_DISCREPANCY'].includes(item.severity)\nconst x = 1;",
    }];
    expect(literalCopies(inComment)).toEqual([]);

    // А тот же список В КОДЕ — находка. Иначе предыдущая строка
    // означала бы «правило выключено», а не «комментарий не код».
    const inCode = [{
      file: join(SRC, 'выдуманный.ts'),
      text: "const bad = ['INACCURACY', 'DISCREPANCY', 'STRONG_DISCREPANCY'];",
    }];
    expect(literalCopies(inCode).length).toBe(1);
  });
});

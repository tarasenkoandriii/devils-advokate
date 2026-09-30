// Пункт [the-index-for-a-column-that-was-removed] 2026-09-30 — сторож
// УСЛОВИЯ, при котором решение «индекс не нужен» остаётся верным.
//
// Сторож держит не отсутствие индекса — запрет навсегда был бы таким же
// необоснованным утверждением, как требование его создать. Он держит
// посылки решения: колонки `taskType` нет, таблица маленькая, подбор
// фильтрует по неизбирательным флагам. Изменится любая — сверка упадёт и
// заставит пересчитать, а не молча оставит решение, принятое при других
// числах.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CAPABILITY_LOOKUP_COLUMNS,
  INDEX_DECISION,
  REVISIT_INDEX_ABOVE_ROWS,
  SEEDED_CAPABILITY_ROWS,
} from '../ai-router/capability-lookup';

const PRISMA = join(__dirname, '..', '..', 'prisma');
const SCHEMA = readFileSync(join(PRISMA, 'schema.prisma'), 'utf8');
const SEED = readFileSync(join(PRISMA, 'seed.ts'), 'utf8');
const ROUTER = readFileSync(join(__dirname, '..', 'ai-router', 'ai-router.service.ts'), 'utf8');

/** Тело модели схемы, без комментариев.
 *
 *  Снятие комментариев здесь — ПРЕДОСТОРОЖНОСТЬ, и мутация это показала:
 *  она его переживает. Слово `taskType` в этом файле встречается четыре
 *  раза, но всё это шапка НАД `model AIModelCapability {`, а регулярка
 *  берёт только тело — то есть ловушка «комментарий прочитан как код»
 *  здесь не срабатывает и без снятия. Оставлено потому, что в теле
 *  комментарии ЕСТЬ (перечисление значений `availability`), проект
 *  наступал на эту ловушку трижды, а цена предосторожности — одна
 *  строка. Названо честно, а не выдано за поимку. */
function modelBody(name: string): string {
  const m = new RegExp(`^model ${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(SCHEMA);
  if (!m) throw new Error(`модель ${name} не найдена`);
  return m[1].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('[the-index-for-a-column-that-was-removed] посылки решения об индексе', () => {
  const body = modelBody('AIModelCapability');

  it('проба механизма: тело модели прочитано, и комментарии из него сняты', () => {
    expect(body.includes('availability')).toBe(true);
    // Комментарий, который в теле ЕСТЬ, — и его в разобранном теле нет.
    expect(SCHEMA.includes('"active" | "beta" | "deprecated"')).toBe(true);
    expect(body.includes('"active" | "beta" | "deprecated"')).toBe(false);
    // А шапка модели `taskType` упоминает — как запись о том, что
    // колонку удалили. В тело она не входит, и это видно.
    expect(SCHEMA.includes('модель × taskType')).toBe(true);
    expect(body.includes('модель × taskType')).toBe(false);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: колонки taskType у модели нет — индексировать нечего', () => {
    expect(/^\s*taskType\s/m.test(body)).toBe(false);
    // И она есть у AIJob — то есть `taskType` в проекте живёт, просто не
    // здесь. Иначе проверка выше проходила бы от опечатки в имени.
    expect(/^\s*taskType\s/m.test(modelBody('AIJob'))).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: таблица — одна строка на модель, и сид заводит ровно столько', () => {
    const seeded = (SEED.match(/await upsertCapability\(/g) ?? []).length;
    // Один вызов на Google + один цикл по трём текстовым провайдерам.
    const loop = /for \(const modelVersionId of \[([^\]]+)\]\)/.exec(SEED);
    expect(loop === null).toBe(false);
    const inLoop = loop![1].split(',').filter((x) => x.trim()).length;
    expect(seeded - 1 + inLoop).toBe(SEEDED_CAPABILITY_ROWS);
    expect(SEEDED_CAPABILITY_ROWS < REVISIT_INDEX_ABOVE_ROWS).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: горячий подбор фильтрует только по неизбирательным флагам', () => {
    const lookup = ROUTER.slice(ROUTER.indexOf('private async resolveModelVersion('));
    const where = lookup.slice(lookup.indexOf('where: {'), lookup.indexOf('include: {'));
    const columns = [...new Set([...where.matchAll(/\b([a-z][A-Za-z0-9]*)\s*:/g)].map((m) => m[1]))].filter(
      (c) => c !== 'where' && c !== 'OR',
    );
    expect(columns.sort()).toEqual([...CAPABILITY_LOOKUP_COLUMNS].sort());
  });

  it('у ai_model_capabilities нет @@index — и это записанное решение, а не забывчивость', () => {
    expect(/@@index/.test(body)).toBe(false);
    // Единственный индекс — уникальность FK, её Prisma создаёт сама.
    expect(/modelVersionId\s+String\s+@unique/.test(body)).toBe(true);
    expect(INDEX_DECISION.includes('не создаётся')).toBe(true);
    expect(INDEX_DECISION.length > 150).toBe(true);
  });

  it('обратная проба: у таблицы, которая РАСТЁТ, индекс на месте', () => {
    // Иначе «индекс не нужен» читалось бы как «индексы тут не заводят».
    // `ai_jobs` растёт с каждым вызовом, и по (taskType, createdAt) у неё
    // индекс есть — тот самый составной, которого от capability и ждали.
    expect(/@@index\(\[taskType, createdAt\]\)/.test(modelBody('AIJob'))).toBe(true);
  });
});

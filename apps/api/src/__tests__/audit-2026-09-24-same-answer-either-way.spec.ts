// Сверка 2026-09-24 — «проверил, что нет, и создал», третий заход.
//
// КАК СВЕРКА ВЫРОСЛА ИЗ ПРЕДЫДУЩЕЙ. [term-never-ends] показал, что
// правило, скопированное по месту столько раз, сколько входов,
// разъезжается на входе, о котором автор забыл. Здесь тот же вывод о
// другом правиле — и правило это проект уже записал СЕБЕ САМ
// ([check-then-create] 2026-09-04, `common/unique-violation.ts`).
//
// ИЗМЕРЕНИЕ. Пар «прочитать, есть ли, и создать» по дереву — 31.
// Большинство безобидны: у модели нет уникального ограничения на
// проверяемые поля, и гонка не создаёт ни дубля, ни отказа. Признак,
// разделяющий безобидное и дефект, — `@@unique` ровно на тех полях,
// по которым идёт проверка. Таких моделей 18, и с парами они
// пересекаются в трёх местах. Модуль-лекарство существует с 2026-09-04
// и применён в семи файлах; эти три в семёрку не вошли.
//
// НАЙДЕНО ТРИ МЕСТА, И ОНИ ДЕЛЯТСЯ НА ДВА РОДА — ровно так, как сам
// модуль 2026-09-04 их и разделил:
//
// 1. ЗАМЫСЕЛ ИДЕМПОТЕНТЕН, и записан в коде своими словами.
//    `addExistingCandidateToProject` начинается с `if (existing) return
//    existing`. Но между тем чтением и вставкой второй такой же вызов
//    (двойное нажатие, повтор при плохой связи, две вкладки) успевал
//    проскочить, упирался в `@@unique([projectId, candidateProfileId])`
//    и человек получал ПЯТИСОТКУ на действии, которое уже удалось.
//    Лечение — `upsert` с пустым `update`: гонка не исключается, её
//    исход становится одним. Пустой `update` намеренно — повтор не
//    сбрасывает этап, до которого кандидат дошёл.
//
//    Тот же род — копия досье компании у соискателя
//    (`offer-exchange`): `own ?? create`. Там `upsert` не подходит,
//    потому что ищут по ИЛИ (код реестра или домен), а уникальность
//    только по коду; поэтому второй приём того же модуля — поймать
//    P2002 и перечитать.
//
// 2. ЗАМЫСЕЛ ОБРАТНЫЙ: повтор — ошибка, и о ней сказано внятно, с
//    `existingDossierId`, чтобы человек открыл уже созданное. Гонка
//    подменяла этот внятный ответ пятисоткой. Лечение не в том, чтобы
//    гонку исключить, а в том, чтобы проигравший прочитал ТО ЖЕ САМОЕ.
//
// ЧТО НАШЛОСЬ В САМИХ ПРОВЕРКАХ. Фейковая Prisma — Proxy, собирающий
// делегат модели ЗАНОВО на каждом обращении. Значит привычное
// `prisma.модель.findFirst = …` молча выбрасывается: тест про гонку
// выглядел бы рабочим и не проверял ничего. Это ровно та форма изъяна,
// которую сверки ищут в продукте, — проверка, которая ВЫГЛЯДИТ
// существующей. Перехват ставится через `defineProperty`, и в каждом
// тесте есть утверждение, что перехват сработал.
//
// ПОВЕДЕНИЕ, НЕ ТЕКСТ. Исходы проверены там, где происходят:
// hiring-extras.service.spec.ts (гонка возвращает строку, дубля нет,
// этап не сброшен) и employer-dossier.service.spec.ts (проигравший
// читает «уже есть» с id). Здесь — то, что иначе не выразить.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Модели с `@@unique` — из схемы, а не из списка в этом файле: список
 * устарел бы молча, а схема — источник. */
function uniqueModels(): Set<string> {
  const schema = readFileSync(join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
  const out = new Set<string>();
  let current = '';
  for (const line of schema.split('\n')) {
    const m = /^model (\w+)/.exec(line);
    if (m) current = m[1][0].toLowerCase() + m[1].slice(1);
    else if (current && line.trim().startsWith('@@unique')) out.add(current);
  }
  return out;
}

describe('Сверка [same-answer-either-way]: исход гонки один, кто бы ни успел', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: ни одна пара «прочитать и создать» по уникальной модели не осталась без защиты', () => {
    const unique = uniqueModels();
    expect(unique.size).toBeGreaterThan(10); // разбор схемы жив

    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const src = code(file);
      for (const m of src.matchAll(/(\w+)\.find(?:First|Unique)\([\s\S]{0,400}?\);([\s\S]{0,600}?)\1\.create\(/g)) {
        const model = m[1];
        if (!unique.has(model)) continue;
        // Между чтением и вставкой должна стоять защита: upsert вместо
        // create, либо перехват P2002 рядом.
        const region = m[0] + src.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
        if (/isUniqueViolation|\.upsert\(/.test(region)) continue;
        offenders.push(`${file.replace(SRC, '')}: ${model}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: правило выше действительно срабатывает', () => {
    // Обратная проба: за эту сессию четырежды выяснялось, что правило
    // сторожит ровно то, что уже исправлено.
    const unique = uniqueModels();
    expect(unique.has('candidatePipelineStatus')).toBe(true);
    const probe =
      'const existing = await this.prisma.candidatePipelineStatus.findFirst({ where: { projectId } });\n' +
      'if (existing) return existing;\n' +
      'const status = await this.prisma.candidatePipelineStatus.create({ data: { projectId } });';
    const matches = [...probe.matchAll(/(\w+)\.find(?:First|Unique)\([\s\S]{0,400}?\);([\s\S]{0,600}?)\1\.create\(/g)];
    expect(matches).toHaveLength(1);
    expect(/isUniqueViolation|\.upsert\(/.test(probe)).toBe(false);
  });

  it('лекарство 2026-09-04 никуда не делось и применяется шире, чем в семи файлах', () => {
    const users = tsFiles(SRC).filter((f) => /unique-violation/.test(code(f)) && !f.endsWith('unique-violation.ts'));
    // Было семь. Меньше — значит применение откатили; число живёт здесь,
    // чтобы следующая сверка начинала с факта.
    expect(users.length).toBeGreaterThanOrEqual(9);
  });
});

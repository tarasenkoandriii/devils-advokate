// Пункт [check-then-create-2] 2026-09-27 — ЗАМКНУТОСТЬ НАСЕЛЕНИЯ.
//
// Первая сверка (2026-09-04) закрыла самые дорогие места и оставила меру
// ДИАПАЗОНОМ: «мест больше 30 и меньше 80». Из такой проверки не следует
// ни какие места вылечены, ни что новое не появилось, — и восемь мест
// действительно стояли невылеченными, а девятое появилось в методе, где
// соседнюю модель лечили `upsert`-ом.
//
// Здесь проверяется не число, а наличие ОТВЕТА у каждого места.
// Население замкнуто и определяется механически: метод, в котором читают
// и создают одну и ту же модель, И у модели есть уникальное ограничение,
// ВСЕ поля которого стоят в условии чтения. Именно оно делает гонку
// видимой: база отвергает вторую вставку, и без лечения человек получает
// внутреннюю ошибку на действии, которое уже удалось.
//
// ЧЕСТНАЯ ГРАНИЦА, и она здесь важнее обычного. Эта спека проверяет
// ФОРМУ кода, а не поведение: «стоит ли лечение» — вопрос о тексте.
// Доказательство, что лечение РАБОТАЕТ, даёт соседняя спека
// (`audit-2026-09-27-check-then-create-2.spec.ts`), которая вызывает
// каждое место с фейковой базой, отдающей P2002. Одна без другой ничего
// не стоит: первая сверка мерила только форму и потому не заметила
// девятого места.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { CURED_RACES, RACES_WITHOUT_CONSTRAINT, type RaceCure } from '../common/check-then-create';

const SRC = join(__dirname, '..');
const SCHEMA = readFileSync(join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');

function services(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : services(full);
    return name.endsWith('.service.ts') ? [full] : [];
  });
}

interface ModelKeys {
  name: string;
  keys: string[][];
}

/** Уникальные ключи каждой модели схемы: и `@@unique([...])`, и `@unique`
 * на отдельном поле.
 *
 * ПОПРАВКА, Пункт [the-first-row-was-whichever] 2026-10-05: разбор НЕ
 * СНИМАЛ КОММЕНТАРИИ. Комментарий в схеме, объясняющий «`@@unique([configId,
 * role])` поставить НЕЛЬЗЯ, потому что участников с ролью OTHER бывает
 * несколько», читался как настоящее ограничение — и две модели переехали
 * из «без ограничения» в «с ограничением» от одной строки прозы. Это
 * двенадцатый случай одной и той же ошибки в этом проекте и второй —
 * внутри самого сторожа. Обратная проба ниже закрывает именно его. */
function stripSchemaComments(body: string): string {
  return body.replace(/\/\/.*$/gm, '');
}

function modelKeys(): Map<string, ModelKeys> {
  const out = new Map<string, ModelKeys>();
  for (const m of SCHEMA.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const body = stripSchemaComments(m[2]);
    out.set(m[1].toLowerCase(), {
      name: m[1],
      keys: [
        ...[...body.matchAll(/@@unique\(\[([^\]]+)\]/g)].map((x) => x[1].split(',').map((s) => s.trim())),
        ...[...body.matchAll(/^\s*(\w+)\s+\S+.*@unique/gm)].map((x) => [x[1]]),
      ],
    });
  }
  return out;
}

const KEYS = modelKeys();

interface Method {
  file: string;
  name: string;
  body: string;
}

/** Методы сервисов — по объявлению следующего метода. Разбор грубый по
 * замыслу: он ищет форму, а не доказывает гонку. */
function methods(): Method[] {
  const out: Method[] = [];
  for (const file of services()) {
    const src = readFileSync(file, 'utf8');
    // Два пробела — отступ метода класса; записаны как {2}, чтобы их
    // нельзя было потерять при правке незаметно.
    const re = /^ {2}(?:private |public |protected )?(?:async )?([A-Za-z_]\w*)\s*\(/gm;
    const starts = [...src.matchAll(re)].map((m) => ({ name: m[1], at: m.index as number }));
    for (let i = 0; i < starts.length; i++) {
      out.push({
        file: relative(SRC, file),
        name: starts[i].name,
        body: src.slice(starts[i].at, i + 1 < starts.length ? starts[i + 1].at : src.length),
      });
    }
  }
  return out;
}

const METHODS = methods();

interface Site {
  file: string;
  method: string;
  model: string;
  key: string;
}

/** Места, где гонку видно базе: читают и создают одну модель, и всё
 * уникальное ограничение стоит в условии чтения. */
function sitesAtRisk(all: readonly Method[]): Site[] {
  const out: Site[] = [];
  for (const m of all) {
    for (const found of m.body.matchAll(/prisma\.(\w+)\.(?:findUnique|findFirst)\(\s*\{([\s\S]{0,300}?)\}\s*\)/g)) {
      const prop = found[1];
      const where = found[2];
      if (!new RegExp(`prisma\\.${prop}\\.create\\(`).test(m.body)) continue;
      const model = KEYS.get(prop.toLowerCase());
      if (!model) continue;
      const covered = model.keys.filter((k) => k.every((f) => new RegExp(`\\b${f}\\b`).test(where)));
      if (covered.length === 0) continue;
      const site = { file: m.file, method: m.name, model: model.name, key: covered[0].join('+') };
      if (!out.some((s) => s.file === site.file && s.method === site.method && s.model === site.model)) out.push(site);
    }
  }
  return out;
}

const CURES: RaceCure[] = ['upsert', 'same-answer', 'renumber', 'skip-duplicates', 'ignore-duplicate'];

/** Записи реестра, чьё лечение НЕ стоит на месте.
 *
 * Вынесено функцией с подставляемым списком методов — иначе главное
 * свойство прохода нечем проверить: сегодня все лечения на месте, и
 * мутация «не проверять их вовсе» ничего бы не изменила. Тот же вид
 * дыры, который в этом проекте уже ловился мутациями: правило есть, а
 * доказательства, что оно работает, нет. */
function missingCures(
  registry: readonly { file: string; method: string; shows: string }[],
  all: readonly Method[],
): string[] {
  const out: string[] = [];
  for (const r of registry) {
    const m = all.find((x) => x.file === r.file && x.name === r.method);
    if (!m) {
      out.push(`${r.file}::${r.method} — метода нет`);
      continue;
    }
    if (!m.body.includes(r.shows)) out.push(`${r.file}::${r.method} — нет «${r.shows}»`);
  }
  return out;
}

describe('Пункт [check-then-create-2] 2026-09-27: у каждой гонки есть ответ', () => {
  const atRisk = sitesAtRisk(METHODS);

  it('проба механизма: методы и ключи схемы разобраны, места найдены', () => {
    // Числа точные: молча усохший разбор прошёл бы проверки ниже
    // насквозь — пустое население покрыто реестром тривиально, и именно
    // так выглядела бы «зелёная» сверка, не проверяющая ничего.
    expect(METHODS.length).toBeGreaterThan(900);
    expect(KEYS.size).toBe(169);
    expect([...KEYS.values()].filter((m) => m.keys.length > 0).length).toBe(57);
    expect(atRisk.length).toBe(13);
    expect(CURED_RACES.length).toBe(21);
    expect(RACES_WITHOUT_CONSTRAINT.length).toBe(9);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: каждое место, где гонку видно базе, есть в реестре', () => {
    const known = new Set(CURED_RACES.map((r) => `${r.file}::${r.method}::${r.model}`));
    const unanswered = atRisk
      .filter((s) => !known.has(`${s.file}::${s.method}::${s.model}`))
      .map((s) => `${s.file}::${s.method}::${s.model}(${s.key})`);
    expect(unanswered).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у каждой записи реестра лечение СТОИТ НА МЕСТЕ и привязано к модели', () => {
    // Строка `shows` привязана к модели, а не к методу. Мера первой
    // сверки искала лекарство по методу — и признала вылеченным
    // `copyItems`, где `upsert` стоял у СОСЕДНЕЙ модели, а конфиг
    // по-прежнему создавался парой «прочитал — создал».
    expect(missingCures(CURED_RACES, METHODS)).toEqual([]);
  });

  it('проба механизма: проход видит и отсутствующее лечение, и отсутствующий метод', () => {
    const withCure: Method = { file: 'f/x.service.ts', name: 'ensureThing', body: 'prisma.dtpConfig.upsert({' };
    const withoutCure: Method = { file: 'f/x.service.ts', name: 'ensureThing', body: 'prisma.dtpConfig.create({' };
    const entry = { file: 'f/x.service.ts', method: 'ensureThing', shows: 'dtpConfig.upsert(' };
    expect(missingCures([entry], [withCure])).toEqual([]);
    expect(missingCures([entry], [withoutCure])).toEqual(['f/x.service.ts::ensureThing — нет «dtpConfig.upsert(»']);
    expect(missingCures([entry], [])).toEqual(['f/x.service.ts::ensureThing — метода нет']);
    // И маркер привязан к МОДЕЛИ: `upsert` соседней модели за лечение не
    // считается — ровно на этом ошиблась мера первой сверки.
    const neighbour: Method = { file: 'f/x.service.ts', name: 'ensureThing', body: 'prisma.vacancyPosting.upsert({ ... }); prisma.dtpConfig.create({' };
    expect(missingCures([entry], [neighbour]).length).toBe(1);
  });

  it('проба механизма: разбор действительно различает вылеченное и нет', () => {
    // Без неё обе проверки выше проходили бы и в мире, где разбор не
    // находит ничего: пустой список покрыт реестром, и всё зелено.
    const raced: Method = {
      file: 'выдуманный/x.service.ts',
      name: 'createThing',
      body: `
        const existing = await this.prisma.dtpConfig.findUnique({ where: { projectId } });
        if (existing) throw new Error('уже есть');
        return this.prisma.dtpConfig.create({ data: { projectId } });
      `,
    };
    expect(sitesAtRisk([raced])).toEqual([
      { file: 'выдуманный/x.service.ts', method: 'createThing', model: 'DtpConfig', key: 'projectId' },
    ]);

    // `upsert` парой не является — гонки нет, и место в население не
    // попадает.
    const cured: Method = {
      file: 'выдуманный/y.service.ts',
      name: 'ensureThing',
      body: `return this.prisma.dtpConfig.upsert({ where: { projectId }, update: {}, create: { projectId } });`,
    };
    expect(sitesAtRisk([cured])).toEqual([]);

    // И ограничение обязано быть ПОКРЫТО условием чтения: чтение по
    // другому полю гонку базе не показывает.
    const otherField: Method = {
      file: 'выдуманный/z.service.ts',
      name: 'createThing',
      body: `
        const existing = await this.prisma.dtpConfig.findFirst({ where: { id: someId } });
        if (existing) throw new Error('уже есть');
        return this.prisma.dtpConfig.create({ data: { projectId } });
      `,
    };
    expect(sitesAtRisk([otherField])).toEqual([]);
  });

  it('ОБРАТНАЯ ПРОБА: `@@unique` В КОММЕНТАРИИ схемы ограничением не считается', () => {
    // Проба идёт через ТОТ ЖЕ разбор, что и проверки выше (`KEYS`), а не
    // через отдельно вызванный помощник: иначе она проверяла бы помощник,
    // а не решение — прямой урок [probe-checked-the-neighbour].
    //
    // В схеме у `DtpParticipant` и `FamilyLawParty` стоят комментарии,
    // которые ЦИТИРУЮТ `@@unique([configId, role])`, объясняя, почему
    // такого ограничения тут быть не может. До снятия комментариев
    // разбор читал цитату как настоящее ограничение, и обе модели
    // уезжали из «без ограничения» в «с ограничением» от одной строки
    // прозы. Если комментарии из схемы уйдут — проба потеряет смысл и
    // обязана упасть, поэтому их наличие проверяется тут же.
    const schema = SCHEMA;
    expect(/\/\/[^\n]*@@unique\(\[configId, role\]\)/.test(schema)).toBe(true);
    expect(KEYS.get('dtpparticipant')!.keys).toEqual([]);
    expect(KEYS.get('familylawparty')!.keys).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: модели «без ограничения» действительно без него — иначе запись переехала', () => {
    // Список решений владельца обязан оставаться правдой о схеме. Появись
    // у модели уникальный индекс — гонка стала бы видимой базе, и место
    // переехало бы в реестр с лечением. Пока список жил только в
    // документации, сверить его с кодом было нечем.
    const wrong = RACES_WITHOUT_CONSTRAINT.filter((r) => {
      const m = KEYS.get(r.model.toLowerCase());
      return !m || m.keys.length > 0;
    }).map((r) => r.model);
    expect(wrong).toEqual([]);
  });

  it('в реестре есть все пять видов лечения, и у каждой записи записан довод', () => {
    expect([...new Set(CURED_RACES.map((r) => r.cure))].sort()).toEqual([...CURES].sort());
    for (const r of CURED_RACES) {
      expect(`${r.file}::${r.method}: ${r.why.length > 40}`).toBe(`${r.file}::${r.method}: true`);
      expect(`${r.file}::${r.method}: ${r.shows.length > 8}`).toBe(`${r.file}::${r.method}: true`);
      expect(r.key.length).toBeGreaterThan(3);
    }
    for (const r of RACES_WITHOUT_CONSTRAINT) {
      expect(`${r.model}: ${r.why.length > 60}`).toBe(`${r.model}: true`);
    }
  });

  it('реестр не повторяется: одно место — одна запись', () => {
    const ids = CURED_RACES.map((r) => `${r.file}::${r.method}::${r.model}`);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

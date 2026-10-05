// Сверка [the-first-row-was-whichever] 2026-10-05 — «одна из подходящих»
// там, где подходящих может быть две.
//
// МЕХАНИКА. `findFirst` это `take: 1`. Если фильтр не задаёт
// единственную строку, какую из подходящих вернёт база — решает план
// запроса, а не код. Сортировка по одному НЕУНИКАЛЬНОМУ столбцу этого
// не меняет: `createdAt` у Prisma это `now()`, то есть время НАЧАЛА
// транзакции, и строки одной пачки делят его до миллисекунды; `endMs`,
// `orderIndex`, `versionNumber`, `updatedAt` тоже не уникальны.
//
// ЧТО ИЗМЕРЕНО. 174 вызова; фильтр уникален по схеме у 95, не уникален
// у 77, не читается автоматически у 2. Из 77 у ПЯТИДЕСЯТИ `orderBy`
// был — и ровно поэтому прошлое измерение
// ([one-of-several-spoke-for-all] 2026-09-25) их не видело: оно
// отбирало «без сортировки». Правило [tie-is-random] 2026-09-06 про
// определённый порядок существовало с сентября, но применялось только к
// `findMany` с потолком. «Правило было, просто не везде».
//
// ПОЧЕМУ РЕЕСТР, А НЕ ЧИСЛО В ОТЧЁТЕ. Прошлый разбор оставил фразу
// «только у 12 используется содержимое, девять из двенадцати
// защищены» — и ни одно из двенадцати не назвал. Проверить её нечем,
// поэтому пришлось измерять заново; внутри неё нашлись два места, где
// платит человек: произвольная из двух ACTIVE-версий промпта и
// произвольный из двух «решающих людей» в прогнозе. Успокоение, которое
// нельзя перепроверить, равно отсутствию успокоения.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ ПОВЕДЕНИЕМ, А ЧТО ИЗМЕРЕНИЕМ. Правило «у
// неуникального фильтра либо уникальный ключ в порядке, либо запись в
// реестре» — утверждение о ЗАПРОСЕ, и проверяется по запросу: заглушка
// вернула бы тот порядок, который сама и заложила, то есть подтвердила
// бы себя. А четыре правки этого Пункта проверяются ПОВЕДЕНИЕМ: у них
// есть наблюдаемый исход, и он проверен на фейках, знающих форму
// production.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { AMBIGUOUS_FIRST_ROW } from '../common/ambiguous-first-row';
import { ConsentService } from '../consent/consent.service';
import { PromptRegistryService } from '../prompt-registry/prompt-registry.service';
import { DtpV2Service } from '../dtp/dtp-v2.service';
import { FamilyLawV2Service } from '../family-law/family-law-v2.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { ConsentType, DtpParticipantRole, FamilyLawPartyRole } from '@prisma/client';
// Имена применений берутся ИЗ ИСТОЧНИКА, а не выдумываются: тот же урок,
// что с алфавитом идентификатора голоса — выдуманное значение чужого
// правила выглядит правдоподобно и ломает ровно то, что проверяет.
import { LOCATION_PURPOSES } from '../consent/location-purposes';

const API_SRC = join(__dirname, '..');
const SCHEMA = join(__dirname, '..', '..', 'prisma', 'schema.prisma');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/** Комментарии и строковые литералы — пробелами. Ловушка, на которой
 *  этот проект спотыкался одиннадцать раз: без этого шага
 *  закомментированный `orderBy` сойдёт за настоящий. */
export function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Группы полей, задающие единственную строку, по модели клиента. */
export function uniqueGroupsFromSchema(schema: string): Record<string, string[][]> {
  const byClient: Record<string, string[][]> = {};
  for (const block of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const groups: string[][] = [];
    for (const line of block[2].split('\n')) {
      const t = line.replace(/\/\/.*$/, '').trim();
      if (!t) continue;
      const field = /^(\w+)\s+\S+/.exec(t);
      if (field && !t.startsWith('@@') && (/@id\b/.test(t) || /@unique\b/.test(t))) groups.push([field[1]]);
      const many = /^@@(?:unique|id)\(\s*(?:fields\s*:\s*)?\[([^\]]+)\]/.exec(t);
      if (many) groups.push(many[1].split(',').map((x) => x.trim()));
    }
    const name = block[1];
    byClient[name[0].toLowerCase() + name.slice(1)] = groups;
  }
  return byClient;
}

/** Ключи верхнего уровня `where`. `null` — объект не литеральный. */
export function whereKeysOf(arg: string): string[] | null {
  const at = arg.search(/\bwhere\s*:/);
  if (at < 0) return [];
  const rest = arg.slice(arg.indexOf(':', at) + 1).replace(/^\s+/, '');
  if (rest[0] !== '{') return null;
  let depth = 0;
  let end = 0;
  for (; end < rest.length; end++) {
    if (rest[end] === '{') depth++;
    else if (rest[end] === '}' && --depth === 0) break;
  }
  const parts: string[] = [];
  let nested = 0;
  let current = '';
  for (const ch of rest.slice(1, end)) {
    if ('{[('.includes(ch)) nested++;
    if ('}])'.includes(ch)) nested--;
    if (ch === ',' && nested === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  const keys: string[] = [];
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith('...')) return null;
    const k = /^(\w+)\s*(:|,|$)/.exec(t);
    if (!k) return null;
    keys.push(k[1]);
  }
  return keys;
}

export interface FirstRowCall {
  file: string;
  line: number;
  model: string;
  keys: string[] | null;
  orderBy: string;
  filterIsUnique: boolean;
  orderIsDetermined: boolean;
}

/** Один разбор на все тесты — и на пробы: проба, идущая мимо
 *  измерения, проверяет не измерение (прямой урок [guard-scope]). */
export function firstRowCalls(files: string[], schema: string): FirstRowCall[] {
  const unique = uniqueGroupsFromSchema(schema);
  const out: FirstRowCall[] = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const src = stripCommentsAndStrings(raw);
    for (const m of src.matchAll(/(\w+)\.findFirst(?:OrThrow)?\(\{/g)) {
      const open = m.index! + m[0].length - 1;
      let depth = 0;
      let i = open;
      while (i < src.length) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
        i++;
      }
      const arg = src.slice(open + 1, i);
      const keys = whereKeysOf(arg);
      const groups = unique[m[1]] ?? [];
      const orderBy = (/orderBy:\s*(\[[\s\S]*?\]|\{[^{}]*\})/.exec(arg) ?? ['', 'НЕТ'])[1].replace(/\s+/g, ' ');
      out.push({
        file: file.slice(API_SRC.length + 1),
        line: raw.slice(0, m.index!).split('\n').length,
        model: m[1],
        keys,
        orderBy,
        filterIsUnique: keys !== null && groups.some((g) => g.every((f) => keys.includes(f))),
        orderIsDetermined: /\bid\s*:/.test(orderBy),
      });
    }
  }
  return out;
}

const SCHEMA_SRC = readFileSync(SCHEMA, 'utf8');
const ALL = firstRowCalls(tsFiles(API_SRC), SCHEMA_SRC);
const REGISTERED = new Set(AMBIGUOUS_FIRST_ROW.map((r) => r.file));

describe('Сверка [the-first-row-was-whichever]: «одна из» обязана быть объяснена', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: у неуникального фильтра либо уникальный ключ в порядке, либо запись в реестре', () => {
    const offenders = ALL.filter((c) => !c.filterIsUnique && !c.orderIsDetermined && !REGISTERED.has(c.file)).map(
      (c) => `${c.file}:${c.line} ${c.model} where={${(c.keys ?? ['НЕЧИТАЕМО']).join(',')}} orderBy=${c.orderBy}`,
    );
    expect(offenders).toEqual([]);
  });

  it('закон сохранения: каждый вызов попал ровно в одну полку', () => {
    const unique = ALL.filter((c) => c.filterIsUnique).length;
    const determined = ALL.filter((c) => !c.filterIsUnique && c.orderIsDetermined).length;
    const registered = ALL.filter((c) => !c.filterIsUnique && !c.orderIsDetermined && REGISTERED.has(c.file)).length;
    const offenders = ALL.length - unique - determined - registered;
    expect(offenders).toBe(0);
    expect(unique + determined + registered).toBe(ALL.length);
  });

  it('измерение остаётся на виду числами, а не словами', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(170);
    expect(ALL.filter((c) => c.filterIsUnique).length).toBeGreaterThanOrEqual(90);
    // Неуникальных с определённым порядком — это те 48 + мои правки;
    // число живёт здесь, чтобы следующая сверка начинала с факта.
    expect(ALL.filter((c) => !c.filterIsUnique && c.orderIsDetermined).length).toBeGreaterThanOrEqual(45);
  });

  it('реестр не гниёт: каждая запись соответствует живому неуникальному вызову', () => {
    const needing = new Set(ALL.filter((c) => !c.filterIsUnique && !c.orderIsDetermined).map((c) => c.file));
    const stale = AMBIGUOUS_FIRST_ROW.filter((r) => !needing.has(r.file)).map((r) => r.file);
    expect(stale).toEqual([]);
  });

  it('у каждой записи реестра названа ПРИЧИНА, а не отмечена галочка', () => {
    const thin = AMBIGUOUS_FIRST_ROW.filter((r) => r.why.trim().length < 80).map((r) => r.file);
    expect(thin).toEqual([]);
  });

  it('ОБРАТНАЯ ПРОБА: новый неуникальный вызов с сортировкой по createdAt ловится', () => {
    const offender = "const x = await this.prisma.libraryEntry.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } });\n";
    const calls = callsIn(offender);
    expect(calls).toHaveLength(1);
    expect(calls[0].filterIsUnique).toBe(false);
    expect(calls[0].orderIsDetermined).toBe(false);
  });

  it('ОБРАТНАЯ ПРОБА: тот же вызов со вторым ключом id правилом НЕ ловится', () => {
    const fixed = "const x = await this.prisma.libraryEntry.findFirst({ where: { projectId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });\n";
    expect(callsIn(fixed)[0].orderIsDetermined).toBe(true);
  });

  it('ОБРАТНАЯ ПРОБА: уникальный фильтр не требует порядка вовсе', () => {
    const byId = 'const x = await this.prisma.libraryEntry.findFirst({ where: { id, ownerId } });\n';
    const call = callsIn(byId)[0];
    expect(call.filterIsUnique).toBe(true);
    expect(call.orderIsDetermined).toBe(false);
  });

  it('ОБРАТНАЯ ПРОБА: группа @@unique, присутствующая ЧАСТИЧНО, уникальности не даёт', () => {
    const schema = ['model Thing {', '  id String @id', '  a String', '  b String', '  @@unique([a, b])', '}'].join('\n');
    const partial = "const x = await this.prisma.thing.findFirst({ where: { a } });\n";
    const whole = "const x = await this.prisma.thing.findFirst({ where: { a, b } });\n";
    expect(callsIn(partial, schema)[0].filterIsUnique).toBe(false);
    expect(callsIn(whole, schema)[0].filterIsUnique).toBe(true);
  });

  it('ОБРАТНАЯ ПРОБА: тот же текст В КОММЕНТАРИИ вызовом не считается', () => {
    const commented = "// const x = await this.prisma.libraryEntry.findFirst({ where: { projectId } });\n";
    expect(callsIn(commented)).toHaveLength(0);
  });

  it('ОБРАТНАЯ ПРОБА: `orderBy` В КОММЕНТАРИИ определённым порядком не считается', () => {
    const fake = [
      'const x = await this.prisma.libraryEntry.findFirst({',
      '  where: { projectId },',
      "  // orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]",
      '});',
      '',
    ].join('\n');
    expect(callsIn(fake)[0].orderIsDetermined).toBe(false);
  });
});

/** Разбор куска кода тем же механизмом, что и всего репозитория. */
function callsIn(source: string, schema: string = SCHEMA_SRC): FirstRowCall[] {
  const unique = uniqueGroupsFromSchema(schema);
  const src = stripCommentsAndStrings(source);
  const out: FirstRowCall[] = [];
  for (const m of src.matchAll(/(\w+)\.findFirst(?:OrThrow)?\(\{/g)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    let i = open;
    while (i < src.length) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
      i++;
    }
    const arg = src.slice(open + 1, i);
    const keys = whereKeysOf(arg);
    const groups = unique[m[1]] ?? [];
    const orderBy = (/orderBy:\s*(\[[\s\S]*?\]|\{[^{}]*\})/.exec(arg) ?? ['', 'НЕТ'])[1].replace(/\s+/g, ' ');
    out.push({
      file: 'проба',
      line: 1,
      model: m[1],
      keys,
      orderBy,
      filterIsUnique: keys !== null && groups.some((g) => g.every((f) => keys.includes(f))),
      orderIsDetermined: /\bid\s*:/.test(orderBy),
    });
  }
  return out;
}

// ─────────── поведение: четыре правки этого Пункта ───────────
//
// Здесь уже не утверждения о запросе, а наблюдаемый исход. Фейки знают
// интерактивную `$transaction` и сырой запрос замка — иначе проверялась
// бы заглушка, а не код.

function fakeVersionsPrisma() {
  const rows: any[] = [];
  let n = 0;
  const match = (v: any, where: any = {}) =>
    (where.promptId === undefined || v.promptId === where.promptId) &&
    (where.status === undefined || v.status === where.status) &&
    (where.id === undefined || v.id === where.id);
  const order = (list: any[], orderBy: any) => {
    const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o: any) =>
      Object.entries(o).map(([field, dir]) => ({ field, dir })),
    );
    return [...list].sort((a, b) => {
      for (const { field, dir } of keys as Array<{ field: string; dir: string }>) {
        if (a[field] === b[field]) continue;
        const cmp = a[field] > b[field] ? 1 : -1;
        return dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  };
  const fake: any = {
    _rows: rows,
    _seed(v: any) { rows.push({ id: `v${++n}`, createdAt: new Date(2026, 0, n), updatedAt: new Date(2026, 0, n), ...v }); return rows[rows.length - 1]; },
    $executeRaw: async () => 1,
    $transaction: async (arg: any) => (typeof arg === 'function' ? arg(fake) : Promise.all(arg)),
    user: { findUnique: async ({ where }: any) => (where.id === 'op' ? { id: 'op', isOperator: true } : null) },
    evaluationRun: {
      findFirst: async () => ({ id: 'run1', releaseGate: { passed: true }, results: [] }),
    },
    promptVersion: {
      findUnique: async ({ where }: any) => rows.find((v) => v.id === where.id) ?? null,
      findMany: async ({ where, orderBy }: any = {}) => order(rows.filter((v) => match(v, where)), orderBy),
      findFirst: async ({ where, orderBy }: any = {}) => order(rows.filter((v) => match(v, where)), orderBy)[0] ?? null,
      update: async ({ where, data }: any) => {
        const i = rows.findIndex((v) => v.id === where.id);
        rows[i] = { ...rows[i], ...data };
        return rows[i];
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        rows.forEach((v, i) => { if (match(v, where)) { rows[i] = { ...v, ...data }; count++; } });
        return { count };
      },
    },
  };
  return fake;
}

describe('[the-first-row-was-whichever] поведение: активная версия промпта', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: повышение снимает ВСЕ активные версии, а не одну', async () => {
    const prisma = fakeVersionsPrisma();
    prisma._seed({ promptId: 'steelman', version: 'v1', status: 'ACTIVE' });
    prisma._seed({ promptId: 'steelman', version: 'v2', status: 'ACTIVE' });
    const candidate = prisma._seed({ promptId: 'steelman', version: 'v3', status: 'TESTING' });
    const service = new PromptRegistryService(prisma, { record: async () => ({}) } as any);

    await service.promoteToActive('op', candidate.id);

    const active = prisma._rows.filter((v: any) => v.status === 'ACTIVE').map((v: any) => v.version);
    expect(active).toEqual(['v3']);
    expect(prisma._rows.filter((v: any) => v.status === 'DEPRECATED').map((v: any) => v.version).sort()).toEqual(['v1', 'v2']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: откат — тормоз: в ROLLBACK уходят ВСЕ активные', async () => {
    const prisma = fakeVersionsPrisma();
    prisma._seed({ promptId: 'steelman', version: 'v1', status: 'DEPRECATED' });
    prisma._seed({ promptId: 'steelman', version: 'v2', status: 'ACTIVE' });
    prisma._seed({ promptId: 'steelman', version: 'v3', status: 'ACTIVE' });
    const service = new PromptRegistryService(prisma, { record: async () => ({}) } as any);

    const restored = await service.rollback('op', 'steelman');

    expect(restored.version).toBe('v1');
    expect(prisma._rows.filter((v: any) => v.status === 'ROLLBACK').map((v: any) => v.version).sort()).toEqual(['v2', 'v3']);
    expect(prisma._rows.filter((v: any) => v.status === 'ACTIVE').map((v: any) => v.version)).toEqual(['v1']);
  });

  it('журнал называет снятые версии СПИСКОМ — назвать одну значило бы соврать оператору', async () => {
    const prisma = fakeVersionsPrisma();
    prisma._seed({ promptId: 'steelman', version: 'v1', status: 'ACTIVE' });
    prisma._seed({ promptId: 'steelman', version: 'v2', status: 'ACTIVE' });
    const candidate = prisma._seed({ promptId: 'steelman', version: 'v3', status: 'TESTING' });
    const recorded: any[] = [];
    const service = new PromptRegistryService(prisma, { record: async (e: any) => { recorded.push(e); return {}; } } as any);

    await service.promoteToActive('op', candidate.id);

    expect(recorded[0].before.previousActiveIds.sort()).toEqual(['v1', 'v2']);
  });
});

describe('[the-first-row-was-whichever] поведение: согласие считается по ВСЕМ действующим записям', () => {
  function fakeConsentPrisma(records: any[]) {
    return {
      consentRecord: {
        findMany: async ({ where }: any) =>
          records.filter(
            (r) =>
              r.userId === where.userId &&
              r.consentType === where.consentType &&
              r.granted === true &&
              r.revokedAt === null &&
              (where.projectId === null ? r.projectId === null : true),
          ),
      },
      user: { findUnique: async () => ({ id: 'u1', privacyProcessingMode: 'FULL' }) },
    } as any;
  }

  const base = { userId: 'u1', consentType: ConsentType.LOCATION, granted: true, revokedAt: null, projectId: null };

  it('КЛЮЧЕВОЙ ТЕСТ: применение, разрешённое ВТОРОЙ записью, считается разрешённым', async () => {
    // Было: читалась одна запись (по `createdAt desc`, а он у записей
    // одной транзакции совпадает), и применение из другой записи
    // читалось как неразрешённое — молчаливый отказ в праве, которое
    // человек дал.
    const service = new ConsentService(
      fakeConsentPrisma([
        { ...base, purposes: [LOCATION_PURPOSES.WEATHER] },
        { ...base, purposes: [LOCATION_PURPOSES.VENUE_SEARCH] },
      ]),
    );
    await expect(service.hasActiveConsent('u1', ConsentType.LOCATION, undefined, LOCATION_PURPOSES.VENUE_SEARCH)).resolves.toBe(true);
    await expect(service.hasActiveConsent('u1', ConsentType.LOCATION, undefined, LOCATION_PURPOSES.WEATHER)).resolves.toBe(true);
  });

  it('ОБРАТНАЯ ПРОБА: применение, которого нет НИ В ОДНОЙ записи, разрешённым не становится', async () => {
    const service = new ConsentService(
      fakeConsentPrisma([
        { ...base, purposes: [LOCATION_PURPOSES.WEATHER] },
        { ...base, purposes: [LOCATION_PURPOSES.VENUE_SEARCH] },
      ]),
    );
    await expect(service.hasActiveConsent('u1', ConsentType.LOCATION, undefined, LOCATION_PURPOSES.ONBOARDING_CITY)).resolves.toBe(false);
  });

  it('ОБРАТНАЯ ПРОБА: объединение не отменяет проверку опечатки — неизвестное применение не покрывается ничем', async () => {
    const service = new ConsentService(fakeConsentPrisma([{ ...base, purposes: ['weather'] }]));
    await expect(service.hasActiveConsent('u1', ConsentType.LOCATION, undefined, 'weather-forcast')).resolves.toBe(false);
  });
});

describe('[the-first-row-was-whichever] поведение: единственность SELF — ОДНО событие под замком', () => {
  // Замок сам по себе фейком не проверяется: одновременности в одном
  // потоке нет, и мутация «убрать замок» на фейках ПЕРЕЖИВАЕТ — это
  // названо в Пункте, а не умолчано. Но проверяемо то, без чего замок
  // бессмыслен: что проверка и запись идут ПО ТОЙ ЖЕ транзакции и
  // ПОСЛЕ взятия замка. Обращение мимо транзакции вернуло бы ровно ту
  // гонку, ради которой замок и ставится.
  function fakeWithTrace() {
    const steps: string[] = [];
    const rows: any[] = [];
    const model = (on: string) => ({
      findFirst: async ({ where }: any) => {
        steps.push(`${on}:findFirst`);
        return rows.find((r) => r.configId === where.configId && r.role === where.role) ?? null;
      },
      create: async ({ data }: any) => {
        steps.push(`${on}:create`);
        const row = { id: `r${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
    });
    const tx: any = {
      $executeRaw: async () => {
        steps.push('tx:lock');
        return 1;
      },
      dtpParticipant: model('tx'),
      familyLawParty: model('tx'),
    };
    const fake: any = {
      _steps: steps,
      _rows: rows,
      $executeRaw: async () => {
        steps.push('вне-транзакции:lock');
        return 1;
      },
      $transaction: async (arg: any) => {
        steps.push('transaction');
        return typeof arg === 'function' ? arg(tx) : Promise.all(arg);
      },
      dtpParticipant: model('вне-транзакции'),
      familyLawParty: model('вне-транзакции'),
      // Проверки владения идут до замка и к трассе не относятся: они
      // отвечают на «можно ли вообще», а не на «одним ли событием».
      dtpConfig: { findUnique: async () => ({ id: 'cfg', projectId: 'p1' }) },
      familyLawConfig: { findUnique: async () => ({ id: 'cfg', projectId: 'p1' }) },
      project: { findFirst: async () => ({ id: 'p1', ownerId: 'u1' }) },
    };
    return fake;
  }

  it('КЛЮЧЕВОЙ ТЕСТ (ДТП): замок, проверка и запись — одной транзакцией и в этом порядке', async () => {
    const prisma = fakeWithTrace();
    const service = new DtpV2Service(prisma, {} as any);
    await service.createParticipant('u1', 'cfg', DtpParticipantRole.SELF, 'Я');
    expect(prisma._steps).toEqual(['transaction', 'tx:lock', 'tx:findFirst', 'tx:create']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (разводное дело): то же — обе копии правила, а не одна', async () => {
    const prisma = fakeWithTrace();
    const service = new FamilyLawV2Service(prisma, {} as any);
    await service.createParty('u1', 'cfg', FamilyLawPartyRole.SELF, 'Я');
    expect(prisma._steps).toEqual(['transaction', 'tx:lock', 'tx:findFirst', 'tx:create']);
  });

  it('ОБРАТНАЯ ПРОБА: роль НЕ-SELF замка не берёт — лишнее ожидание там, где единственности не требуется', async () => {
    const prisma = fakeWithTrace();
    const service = new DtpV2Service(prisma, {} as any);
    await service.createParticipant('u1', 'cfg', DtpParticipantRole.OTHER_PARTY, 'Другой');
    expect(prisma._steps).toEqual(['вне-транзакции:create']);
  });
});

describe('[the-first-row-was-whichever] поведение: пустой ключ не отдаёт чужой лист условий', () => {
  // Ловушка, а не дефект нынешних вызовов: оба поля `key` необязательны
  // по типу, и `where: {}` Prisma трактует как «условия нет» — то есть
  // отказ «лист уже открыт» нёс бы человеку идентификатор ПЕРВОЙ
  // строки таблицы, чужой лист условий, который экран по этому id и
  // открыл бы. Сегодня оба вызывающих места передают уникальное поле;
  // третий не обязан.
  it('КЛЮЧЕВОЙ ТЕСТ: при пустом ключе пробрасывается исходный отказ, а не «лист уже открыт»', async () => {
    const original = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    let searched = false;
    const prisma: any = {
      termsSheet: {
        create: async () => {
          throw original;
        },
        findFirst: async () => {
          searched = true;
          return { id: 'ЧУЖОЙ-ЛИСТ' };
        },
      },
    };
    const service: any = new TermsSheetService(prisma, {} as any, {} as any);
    await expect(service.createSheetOrPointToExisting({ projectId: 'p', kind: 'VACANCY', title: 'x' }, {})).rejects.toBe(original);
    expect(searched).toBe(false);
  });

  it('ОБРАТНАЯ ПРОБА: с уникальным ключом поиск идёт и отказ называет НАЙДЕННЫЙ лист', async () => {
    const prisma: any = {
      termsSheet: {
        create: async () => {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        },
        findFirst: async ({ where }: any) => (where.configId === 'cfg-1' ? { id: 'СВОЙ-ЛИСТ' } : null),
      },
    };
    const service: any = new TermsSheetService(prisma, {} as any, {} as any);
    // Идентификатор уходит человеку не текстом, а полем ответа — экран
    // по нему и открывает уже существующий лист.
    const refusal: any = await service
      .createSheetOrPointToExisting({ projectId: 'p', kind: 'VACANCY', title: 'x' }, { configId: 'cfg-1' })
      .then(() => null)
      .catch((err: any) => err);
    expect(refusal?.getResponse?.()).toMatchObject({ existingSheetId: 'СВОЙ-ЛИСТ' });
  });
});

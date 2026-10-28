// Сверка [the-domain-was-never-checked] 2026-10-27 — ворота домена
// называли домен и не спрашивали о нём.
//
// ПРОДОЛЖЕНИЕ, А НЕ НОВАЯ ПОРОДА. Пункт [the-kind-was-never-checked]
// 2026-10-26 закрыл этот же вопрос для ВИДА РАЗГОВОРА и кончился
// сторожем, который знает ИМЕНА девяти методов. Его собственный список
// «названо и не закрыто» говорил: правила, отличающего «берёт по голому
// id законно» от «забыли спросить», у проекта нет, и тот же вопрос
// открыт у `project.mode` — 27 мест, режим проверяют пять. Это тот
// заход.
//
// УРОК БЫЛ ЗАПИСАН 2026-09-02, И ЦЕЛИКОМ. В шапке
// `interview-pool-access.ts` стои́т разбор ровно этого дефекта, с
// вредом дословно: «режим проекта не проверялся (в job-search такая
// проверка есть). Владелец мог вызвать весь interview-pool API на своём
// проекте ЛЮБОГО домена — не IDOR (проект свой), но сущности пула
// создавались на проекте, которого нет в списке домена: ДАННЫЕ ЕСТЬ, ИЗ
// ИНТЕРФЕЙСА НЕДОСТИЖИМЫ». Исправлено было ДВА домена из восьми —
// interview-pool (этим разбором) и job-search. Пять остались, и один из
// них, `investment-access.ts`, в своей шапке хвалит себя за то, что
// спроектирован сразу правильно, «щоб той самий клас бага не
// повторювався втретє» — не проверяя режим.
//
// КАК ИЗМЕРЕНО. Мест, которые читают проект по id и бросают отказ, —
// 23; режим проверяли 6. Большинство остальных мод-безразличны по
// смыслу (разговоры, факты о людях, заморозка, общий список проектов) —
// запрещать им читать проект любого режима было бы шумом. Поэтому
// измеряется не «все, кто читает проект», а ВОРОТА ДОМЕНА, и домен
// выводится ИЗ КОДА: папка, которая создаёт проекты с `mode:
// ProjectMode.X`, владеет этим режимом. Таких папок восемь. Ворот в
// них — восемь. Режим проверяли три: job-search, interview-pool и
// (не ворота, но рядом) terms-sheet. Правок пять, плюс две копии
// одних ворот сведены в одни.
//
// ПОЧЕМУ ЭТО НЕ ПРАВИЛО ПО ИМЕНАМ. Сторож прошлого Пункта смотрел на
// имена методов, и это было названо его границей вслух. Здесь границы
// нет: карта «папка → режим» выводится из вызовов `project.create`, и
// сверяется с РЕЕСТРОМ `DOMAIN_MODES`, который в проекте уже был — он
// стои́т в админском обзоре и ни одним правилом доступа не
// использовался. Новая папка-домен попадёт под правило в тот день,
// когда создаст свой первый проект.
//
// ЧЕГО ЗДЕСЬ НЕТ, И ЭТО СКАЗАНО ПРЯМО. Вреда «один человек прочитал
// чужое» в этом дефекте НЕ БЫЛО ни в одном из пяти мест: ворота
// проверяли владение (или членство в группе), и ошибиться режимом можно
// было только на СВОЁМ проекте. Интерфейс продукта тоже не мог привести
// сюда: каждый доменный экран берёт проекты из `listDomainProjects` со
// своим режимом. Достижимо прямым вызовом API — то есть владельцем
// токена, то есть самим человеком. Вред — испорченные данные, которых
// он больше не увидит: конфиг домена и всё его дерево на проекте,
// которого нет в списке этого домена, и нет в списке никакого другого.
// И база этого не запретит: связь «конфиг домена — проект того же
// режима» в схеме невыразима (это условие между двумя таблицами), так
// что код — единственное место, где она может держаться.

import { NotFoundException } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ProjectMode } from '@prisma/client';

import { DOMAIN_MODES } from '../admin-domains/admin-domains.service';
import { assertOwnedDtpProject } from '../dtp/dtp-access';
import { assertOwnedFamilyLawProject } from '../family-law/family-law-access';
import { assertOwnedHealthProject } from '../health/health-access';
import { assertInvestmentProjectAccess } from '../investment/investment-access';
import { assertOwnedMajorPurchaseProject } from '../major-purchase/major-purchase-access';
import { assertInterviewPoolProjectAccess, TEAM_MODES } from '../interview-pool/interview-pool-access';
import { assertOwnedJobSearchProject } from '../job-search/job-search-access';

const API_SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/** Гасит комментарии и ТЕКСТ строк, сохраняя длину, переводы строк и
 *  выражения `${…}` внутри шаблонов (они код, а не текст).
 *
 *  Ловушка, в которую этот проект попадал тринадцать раз, дважды —
 *  внутри самого сторожа: разбирать текст, не сняв комментарии. Здесь
 *  она стоит дорого вдвойне: ПОЯСНЕНИЯ к этим самым правкам содержат и
 *  `ProjectMode.DTP`, и `prisma.project.findFirst`. */
function blanked(source: string): string {
  const out = source.split('');
  const n = source.length;
  const wipe = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const stack: ('tpl' | 'expr' | 'brace')[] = [];
  let i = 0;
  while (i < n) {
    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    const c = source[i];
    if (top === 'tpl') {
      if (c === '\\') {
        wipe(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        i++;
        continue;
      }
      if (c === '$' && source[i + 1] === '{') {
        stack.push('expr');
        i += 2;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      let j = source.indexOf('\n', i);
      if (j < 0) j = n;
      wipe(i, j);
      i = j;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      let j = source.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      wipe(i, j);
      i = j;
      continue;
    }
    if (c === '`') {
      stack.push('tpl');
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === c || source[j] === '\n') break;
        j++;
      }
      wipe(i + 1, j);
      i = Math.min(j + 1, n);
      continue;
    }
    if (c === '{' && (top === 'expr' || top === 'brace')) {
      stack.push('brace');
      i++;
      continue;
    }
    if (c === '}' && (top === 'expr' || top === 'brace')) {
      stack.pop();
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

function matchingBrace(code: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const DECL =
  /(?:export\s+)?(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*\([^;{]{0,400}?\)\s*(?::\s*[^;{]{1,200}?)?\{/g;
const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor', 'do']);

interface Gate {
  readonly at: string;
  readonly line: number;
  readonly folder: string;
  readonly body: string;
}

/** Всё, что читает проект по id и бросает отказ: и свободные функции, и
 *  методы класса. ПРИВАТНЫЙ МЕТОД — не исключение, и это не теория:
 *  первая редакция замера смотрела только на `export async function` и
 *  поэтому не увидела `major-purchase`, единственный домен, у которого
 *  ворота были приватными. ДВУМЯ копиями. */
function projectGates(): Gate[] {
  const gates: Gate[] = [];
  for (const file of tsFiles(API_SRC)) {
    const code = blanked(readFileSync(file, 'utf8'));
    const rel = file.slice(API_SRC.length + 1);
    const folder = rel.split('/')[0];
    DECL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DECL.exec(code)) !== null) {
      const name = m[1];
      if (NOT_A_FUNCTION.has(name)) continue;
      const open = code.lastIndexOf('{', m.index + m[0].length);
      const close = matchingBrace(code, open);
      if (close < 0) continue;
      const body = code.slice(open, close);
      if (!/prisma\.project\.find/.test(body)) continue;
      if (!/\bthrow\b/.test(body)) continue;
      gates.push({ at: `${rel}#${name}`, line: code.slice(0, m.index).split('\n').length, folder, body });
    }
  }
  return gates;
}

/** Папка → режимы, которые она СОЗДАЁТ. Выводится из кода, не
 *  переписывается руками: папка владеет режимом, если в ней есть
 *  `project.create` с `mode: ProjectMode.X`. */
function createdModesByFolder(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of tsFiles(API_SRC)) {
    const code = blanked(readFileSync(file, 'utf8'));
    const folder = file.slice(API_SRC.length + 1).split('/')[0];
    for (const m of code.matchAll(/project\.create\s*\(/g)) {
      const open = code.indexOf('{', m.index);
      if (open < 0) continue;
      const close = matchingBrace(code, open);
      if (close < 0) continue;
      for (const mm of code.slice(open, close).matchAll(/\bmode:\s*ProjectMode\.([A-Z_]+)/g)) {
        if (!out.has(folder)) out.set(folder, new Set());
        out.get(folder)!.add(mm[1]);
      }
    }
  }
  return out;
}

/** Множества режимов, через которые ворота могут назвать свой режим.
 *  Разрешены только те, что РАЗРЕШАЮТ не больше нужного: `TEAM_MODES` —
 *  два командных режима, и для обоих командных доменов это и есть
 *  правильный ответ (один проект агентства, один работодателя, одна
 *  команда). */
const MODE_SETS: Record<string, readonly ProjectMode[]> = {
  TEAM_MODES: [...TEAM_MODES],
};

function namesItsOwnMode(gate: Gate, owned: Set<string>): boolean {
  for (const mode of owned) {
    if (new RegExp(`ProjectMode\\.${mode}\\b`).test(gate.body)) return true;
  }
  for (const [setName, modes] of Object.entries(MODE_SETS)) {
    if (!new RegExp(`\\b${setName}\\b`).test(gate.body)) continue;
    if (modes.some((m) => owned.has(m))) return true;
  }
  return false;
}

/** Ворота, которые режим НЕ проверяют ОСОЗНАННО. Пусто — и это
 *  измеренное состояние: до правок этого Пункта здесь было бы семь
 *  записей в пяти доменах. */
const DELIBERATE: readonly { readonly at: string; readonly why: string }[] = [];

function unguardedGates(): string[] {
  const created = createdModesByFolder();
  const bad: string[] = [];
  for (const gate of projectGates()) {
    const owned = created.get(gate.folder);
    if (!owned) continue; // папка проектов не создаёт — домена у неё нет
    if (namesItsOwnMode(gate, owned)) continue;
    bad.push(gate.at);
  }
  return bad.sort();
}

describe('Сверка [the-domain-was-never-checked]: ворота домена проверяют режим, который называют', () => {
  test('замер не пуст: ворота найдены, домены выведены', () => {
    const gates = projectGates();
    // Пункт [the-empty-scan-was-green] 2026-10-02: сверка, которая
    // ничего не нашла, обязана падать, а не зеленеть.
    expect(gates.length).toBeGreaterThan(15);
    const created = createdModesByFolder();
    expect(created.size).toBe(8);
    expect(gates.filter((g) => created.has(g.folder)).length).toBeGreaterThanOrEqual(8);
  });

  test('карта «папка → режим» ВЫВЕДЕНА из кода и совпадает с реестром DOMAIN_MODES', () => {
    // Реестр в проекте БЫЛ — и ни одним правилом доступа не
    // использовался: он стоит в админском обзоре. Теперь он сверен с
    // кодом в обе стороны, то есть разъехаться молча не может.
    const created = createdModesByFolder();
    const derived = [...created.entries()].map(([folder, modes]) => `${folder}=${[...modes].sort().join('|')}`).sort();
    const registry = Object.entries(DOMAIN_MODES).map(([folder, mode]) => `${folder}=${mode}`).sort();
    // employer-hiring создаёт И свой проект, И проект агентства
    // (передача вакансии в пул) — это не расхождение, а две роли одной
    // папки, и названо здесь, а не спрятано фильтром.
    expect(derived).toEqual(
      registry.map((row) => (row.startsWith('employer-hiring=') ? 'employer-hiring=EMPLOYER_HIRING|INTERVIEW_POOL' : row)),
    );
  });

  test('КЛЮЧЕВОЙ ТЕСТ: ни одни ворота домена не молчат о своём режиме', () => {
    const registered = new Set(DELIBERATE.map((d) => d.at));
    expect(unguardedGates().filter((at) => !registered.has(at))).toEqual([]);
  });

  test('реестр осознанных исключений замкнут: в нём нет записей о воротах, которых больше нет', () => {
    const live = new Set(unguardedGates());
    expect(DELIBERATE.filter((d) => !live.has(d.at)).map((d) => d.at)).toEqual([]);
  });

  test('ворота каждого из восьми доменов существуют — правило не может оказаться правилом ни о чём', () => {
    const created = createdModesByFolder();
    const byFolder = new Map<string, number>();
    for (const gate of projectGates()) {
      if (!created.has(gate.folder)) continue;
      byFolder.set(gate.folder, (byFolder.get(gate.folder) ?? 0) + 1);
    }
    // У employer-hiring своих ворот нет: он ходит через
    // `assertInterviewPoolProjectAccess` и `assertHiringProjectAccess`
    // (папка terms-sheet). Сказано, а не замазано нулём.
    expect([...byFolder.keys()].sort()).toEqual(
      ['dtp', 'family-law', 'health', 'interview-pool', 'investment', 'job-search', 'major-purchase'].sort(),
    );
  });

  describe('сам определитель проверен на синтетическом коде', () => {
    const owned = new Set(['HEALTH']);
    const gateOf = (src: string): Gate => {
      const code = blanked(src);
      DECL.lastIndex = 0;
      const m = DECL.exec(code)!;
      const open = code.lastIndexOf('{', m.index + m[0].length);
      return { at: 'x#y', line: 1, folder: 'health', body: code.slice(open, matchingBrace(code, open)) };
    };

    test('ворота без режима — находятся', () => {
      const g = gateOf('async function f(a, b) { const p = await prisma.project.findFirst({ where: { id: a } }); if (!p) throw new X(); return p; }');
      expect(namesItsOwnMode(g, owned)).toBe(false);
    });

    test('ворота с режимом — не находятся', () => {
      const g = gateOf('async function f(a, b) { const p = await prisma.project.findFirst({ where: { id: a } }); if (!p || p.mode !== ProjectMode.HEALTH) throw new X(); return p; }');
      expect(namesItsOwnMode(g, owned)).toBe(true);
    });

    test('ЧУЖОЙ режим не считается своим — иначе правило проверяло бы наличие слова, а не утверждение', () => {
      const g = gateOf('async function f(a, b) { const p = await prisma.project.findFirst({ where: { id: a } }); if (!p || p.mode !== ProjectMode.DTP) throw new X(); return p; }');
      expect(namesItsOwnMode(g, owned)).toBe(false);
    });

    test('режим, названный множеством, признаётся — но только если множество содержит свой режим', () => {
      const team = gateOf('async function f(a) { const p = await prisma.project.findFirst({ where: { id: a } }); if (!p || !TEAM_MODES.has(p.mode)) throw new X(); return p; }');
      expect(namesItsOwnMode(team, new Set(['INTERVIEW_POOL']))).toBe(true);
      expect(namesItsOwnMode(team, new Set(['HEALTH']))).toBe(false);
    });

    test('режим В КОММЕНТАРИИ не считается проверкой — ловушка, в которую проект попадал тринадцать раз', () => {
      const g = gateOf(
        'async function f(a) { /* проверяем ProjectMode.HEALTH */ const p = await prisma.project.findFirst({ where: { id: a } }); if (!p) throw new X(); return p; }',
      );
      expect(namesItsOwnMode(g, owned)).toBe(false);
    });

    test('режим В СТРОКЕ тоже не считается', () => {
      const g = gateOf(
        "async function f(a) { const p = await prisma.project.findFirst({ where: { id: a } }); if (!p) throw new X('ProjectMode.HEALTH'); return p; }",
      );
      expect(namesItsOwnMode(g, owned)).toBe(false);
    });
  });
});

/** Фейк ровно для ворот: читает проект и членство, больше ничего. */
function makePrisma(project: Record<string, unknown> | null, membership: Record<string, unknown> | null = null) {
  return {
    project: {
      findFirst: async ({ where }: any) => {
        if (!project) return null;
        if (where.ownerId !== undefined && project.ownerId !== where.ownerId) return null;
        if (where.id !== undefined && project.id !== where.id) return null;
        return project;
      },
      findUnique: async ({ where }: any) => (project && project.id === where.id ? project : null),
    },
    investmentGroupMember: { findUnique: async () => membership },
    recruitingTeamMember: { findUnique: async () => membership },
  } as never;
}

describe('[the-domain-was-never-checked] поведение: чужой домен не проходит ни в одни ворота', () => {
  const OWNER = 'u1';
  const cases: [string, ProjectMode, (prisma: never) => Promise<unknown>][] = [
    ['dtp', ProjectMode.DTP, (p) => assertOwnedDtpProject(p, OWNER, 'p1')],
    ['family-law', ProjectMode.FAMILY_LAW, (p) => assertOwnedFamilyLawProject(p, OWNER, 'p1')],
    ['health', ProjectMode.HEALTH, (p) => assertOwnedHealthProject(p, OWNER, 'p1')],
    ['investment', ProjectMode.INVESTMENT, (p) => assertInvestmentProjectAccess(p, OWNER, 'p1')],
    ['major-purchase', ProjectMode.MAJOR_PURCHASE, (p) => assertOwnedMajorPurchaseProject(p, OWNER, 'p1')],
    ['interview-pool', ProjectMode.INTERVIEW_POOL, (p) => assertInterviewPoolProjectAccess(p, OWNER, 'p1')],
    ['job-search', ProjectMode.JOB_SEARCH, (p) => assertOwnedJobSearchProject(p, OWNER, 'p1')],
  ];

  for (const [domain, mode, call] of cases) {
    test(`${domain}: СВОЙ проект чужого домена не проходит`, async () => {
      // Режим-подменыш берётся соседним по списку — лишь бы не свой.
      const alien = mode === ProjectMode.DTP ? ProjectMode.HEALTH : ProjectMode.DTP;
      const prisma = makePrisma({ id: 'p1', ownerId: OWNER, mode: alien, investmentGroupId: null, recruitingTeamId: null });
      await expect(call(prisma)).rejects.toThrow(NotFoundException);
    });

    test(`${domain}: свой проект своего домена проходит — правило не запрещает работу`, async () => {
      const prisma = makePrisma({ id: 'p1', ownerId: OWNER, mode, investmentGroupId: null, recruitingTeamId: null });
      await expect(call(prisma)).resolves.toMatchObject({ id: 'p1' });
    });
  }

  test('КЛЮЧЕВОЙ ТЕСТ: член инвестгруппы не входит в проект чужого домена, даже будучи членом группы', async () => {
    // Самое важное место правки: это ЕДИНСТВЕННЫЕ ворота без проверки
    // режима, куда может войти НЕ владелец. Сегодня такой проект
    // создать нечем (`investmentGroupId` ставится ровно в одном месте и
    // всегда с `mode: INVESTMENT`), поэтому тест строит состояние базы
    // напрямую: правило должно держать и его, иначе оно держится не на
    // себе, а на строке в другом файле.
    const prisma = makePrisma(
      { id: 'p1', ownerId: 'someone-else', mode: ProjectMode.HEALTH, investmentGroupId: 'g1' },
      { groupId: 'g1', userId: OWNER },
    );
    await expect(assertInvestmentProjectAccess(prisma, OWNER, 'p1')).rejects.toThrow(NotFoundException);
  });

  test('член инвестгруппы входит в проект СВОЕГО домена — командный доступ не сломан', async () => {
    const prisma = makePrisma(
      { id: 'p1', ownerId: 'someone-else', mode: ProjectMode.INVESTMENT, investmentGroupId: 'g1' },
      { groupId: 'g1', userId: OWNER },
    );
    await expect(assertInvestmentProjectAccess(prisma, OWNER, 'p1')).resolves.toMatchObject({ id: 'p1' });
  });
});

describe('[the-domain-was-never-checked] невысказанный инвариант: групповое поле без режима не ставится', () => {
  // Командная ветка investment была безопасна не потому, что здесь
  // что-то проверялось, а потому что `investmentGroupId` в продукте
  // ставится РОВНО В ОДНОМ МЕСТЕ и всегда вместе с `mode: INVESTMENT`.
  // Инвариант, который нигде не утверждён, инвариантом не является:
  // «привязать существующий проект к группе» — одна правка, после
  // которой он перестаёт быть правдой. Теперь он утверждён.
  const writes = (field: string) => {
    const out: string[] = [];
    for (const file of tsFiles(API_SRC)) {
      const code = blanked(readFileSync(file, 'utf8'));
      const rel = file.slice(API_SRC.length + 1);
      for (const m of code.matchAll(/project\.(create|update|updateMany|upsert)\s*\(/g)) {
        const open = code.indexOf('{', m.index);
        if (open < 0) continue;
        const close = matchingBrace(code, open);
        if (close < 0) continue;
        const args = code.slice(open, close);
        if (!new RegExp(`\\b${field}\\b`).test(args)) continue;
        out.push(`${rel}#${m[1]}:${/\bmode:\s*ProjectMode\./.test(args) ? 'with-mode' : 'WITHOUT-MODE'}`);
      }
    }
    return out.sort();
  };

  test('investmentGroupId пишется только при создании и только вместе с режимом', () => {
    expect(writes('investmentGroupId')).toEqual(['investment/investment-onboarding.service.ts#create:with-mode']);
  });

  test('recruitingTeamId тоже: ни одной записи без названного режима', () => {
    expect(writes('recruitingTeamId').filter((row) => row.endsWith('WITHOUT-MODE'))).toEqual([]);
  });
});

// Пункт [computed-for-the-person-never-shown] 2026-09-30 — сторож ответов,
// уходящих мимо экрана.
//
// ЧТО ПРОВЕРЯЕТСЯ. Замер повторяется здесь целиком: контроллеры,
// обращённые к человеку → методы сервисов, которые они зовут → ключи
// верхнего уровня их ответов → те из них, что не встречаются ни в одном
// файле клиентов. Полученное множество обязано совпасть с реестром
// `shown-to-the-person.ts`.
//
// ЗАЧЕМ. Новый ответ, ушедший мимо экрана, не пройдёт молча: сверка
// упадёт и потребует записать, что с ним происходит у человека. Это НЕ
// приговор — большинство записей реестра совершенно законны; это
// требование НАЗВАТЬ судьбу, а не оставить её неизвестной.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { RESPONSE_SITES, SHOWN_NOT_CHECKED_HERE } from '../common/shown-to-the-person';

const API_SRC = join(__dirname, '..');
const REPO = join(API_SRC, '..', '..', '..');

function files(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, exts, out);
    else if (exts.some((e) => p.endsWith(e)) && !/\.spec\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

// Здесь стоял фильтр «контроллеры вебхуков и cron», и он был неверен
// ДВАЖДЫ. По имени файла он находил только `health` и `healthz`:
// маршруты вебхуков живут ВНУТРИ обычных контроллеров (разговоры,
// спарринг, чат по материалам), и отделить их именем файла нельзя. А
// мутация «убрать фильтр» его пережила — набор методов он менял (471
// против 478), а результат замера не менял ни на один ключ. Правило,
// которого не видно в ответе, — сложность без опоры; убрано, а не
// оставлено с комментарием о том, как оно якобы помогает.

function clientText(): string {
  let text = '';
  for (const app of ['tma', 'admin', 'landing']) {
    const dir = join(REPO, 'apps', app, 'src');
    for (const f of files(dir, ['.ts', '.tsx'])) text += readFileSync(f, 'utf8') + '\n';
  }
  return text;
}

/** Методы сервисов, вызываемые из контроллеров, обращённых к человеку. */
function calledFromControllers(sources: string[]): Set<string> {
  const called = new Set<string>();
  for (const f of sources) {
    if (!/\.controller\.ts$/.test(f)) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/this\.[A-Za-z0-9_]+\s*\.\s*([A-Za-z0-9_]+)\s*\(/g)) called.add(m[1]);
  }
  return called;
}

/** Тело метода — от его фигурной скобки до парной. */
function body(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return '';
}

/** Ключи ПЕРВОГО уровня объекта, начинающегося на позиции 0. */
function topKeys(objSrc: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < objSrc.length; i++) {
    const c = objSrc[i];
    if (c === '{' || c === '[' || c === '(') {
      depth++;
      if (depth === 1) continue;
    } else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) break;
    }
    if (depth === 1) buf += c;
  }
  for (const m of buf.matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) keys.push(m[1]);
  for (const m of buf.matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=,\s|$)/g)) keys.push(m[1]);
  return keys;
}

/** `файл#метод` → ключи ответа, которых нет ни у одного клиента. */
function unseen(): Map<string, Set<string>> {
  const sources = files(API_SRC, ['.ts']);
  const called = calledFromControllers(sources);
  const client = clientText();
  const out = new Map<string, Set<string>>();
  for (const f of sources) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:async\s+)?([A-Za-z0-9_]+)\s*\([^)]*\)\s*(?::[^{;]+)?\{/g)) {
      if (!called.has(m[1])) continue;
      const methodSrc = body(src, m.index + m[0].length - 1);
      for (const r of methodSrc.matchAll(/return\s*\{/g)) {
        for (const k of topKeys(methodSrc.slice(r.index + 6))) {
          if (new RegExp(`\\b${k}\\b`).test(client)) continue;
          const at = `${f.slice(API_SRC.length + 1)}#${m[1]}`;
          if (!out.has(at)) out.set(at, new Set());
          out.get(at)!.add(k);
        }
      }
    }
  }
  return out;
}

const MEASURED = unseen();

function asPairs(m: Map<string, Set<string>>): string[] {
  return [...m.entries()].map(([at, keys]) => `${at}: ${[...keys].sort().join(' ')}`).sort();
}

describe('[computed-for-the-person-never-shown] ответы, уходящие мимо экрана', () => {
  it('проба механизма: замер вообще что-то находит', () => {
    // Пустой разбор сделал бы соседнюю проверку сравнением двух пустот —
    // ровно тот способ самообмана, который в этом проекте ловят мутации.
    expect(MEASURED.size > 0).toBe(true);
    expect([...MEASURED.values()].reduce((n, s) => n + s.size, 0) > 0).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни один ответ не уходит мимо экрана без записи в реестре', () => {
    // Показанные этим пунктом из замера УШЛИ — их имена теперь есть у
    // клиентов. Записи о них остаются в реестре как память о находке, но
    // в сравнение не входят: иначе сторож требовал бы, чтобы починенное
    // по-прежнему было сломано.
    const registry = new Map(
      RESPONSE_SITES.filter((s) => s.fate !== 'ПОКАЗАНО-ЭТИМ-ПУНКТОМ').map((s) => [s.at, new Set(s.keys)]),
    );
    expect(asPairs(MEASURED)).toEqual(asPairs(registry));
  });

  it('у каждой записи реестра названа причина', () => {
    expect(RESPONSE_SITES.filter((s) => s.why.trim().length === 0).map((s) => s.at)).toEqual([]);
    expect(RESPONSE_SITES.filter((s) => s.keys.length === 0).map((s) => s.at)).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: то, что этот пункт показал, и правда доходит до разметки', () => {
    const shown = RESPONSE_SITES.filter((s) => s.fate === 'ПОКАЗАНО-ЭТИМ-ПУНКТОМ');
    expect(shown.map((s) => s.at).sort()).toEqual([
      'employer-hiring/employer-hiring.service.ts#getState',
      'hiring-extras/hiring-extras.service.ts#coverageMatrix',
      'interview-pool/interview-pool.service.ts#addCandidate',
    ]);
    // Имён этих полей у клиентов по-прежнему нет — и это НЕ противоречие:
    // разметка берёт их из объекта строки (`r.note`, `data.revokedRows`)
    // и из ответа обработчика. Поэтому здесь проверяется разметка, а не
    // упоминание имени.
    const tma = join(REPO, 'apps', 'tma', 'src', 'components', 'domains');
    const hub = readFileSync(join(tma, 'employer-hiring', 'EmployerHiringWorkspace.tsx'), 'utf8');
    expect(hub.includes('{state.companyChoice}')).toBe(true);
    const pool = readFileSync(join(tma, 'InterviewPoolWorkspace.tsx'), 'utf8');
    expect(pool.includes('historyDisclaimer')).toBe(true);
    const team = readFileSync(join(tma, 'hiring', 'TeamPanels.tsx'), 'utf8');
    expect(team.includes('RevokedRowsNote count={data?.revokedRows ?? 0}')).toBe(true);
  });

  it('записано, чего сторож не делает', () => {
    expect(SHOWN_NOT_CHECKED_HERE.length).toBe(4);
    expect(SHOWN_NOT_CHECKED_HERE.filter((s) => s.trim().length === 0)).toEqual([]);
  });
});

// Пункт [the-question-was-asked-of-the-neighbour] 2026-09-30 — сторож
// вопроса «может ли это быть пустой строкой?».
//
// ЧТО ПРОВЕРЯЕТСЯ.
//
//   1. ЗАМКНУТОСТЬ. В классе, где хоть у одного строкового поля
//      непустота запрещена, каждое остальное строковое поле либо тоже
//      её запрещает, либо названо в реестре с причиной.
//   2. СПИСКИ. Ни одно поле-список строк не принимает пустой элемент.
//   3. ПОВЕДЕНИЕ. Правило и правда отвергает пустоту — проверяется
//      вызовом настоящего валидатора, а не чтением декораторов.
//
// ПОЧЕМУ ИМЕННО ТАК ОЧЕРЧЕНО. «Класс, где вопрос задавали хоть раз» —
// это место, где видно НАМЕРЕНИЕ: кто-то подумал о пустоте у главного
// поля и не подумал у соседнего. Требовать того же от классов, где
// вопрос не задавали вовсе, — другая работа и другой разговор; таких
// классов 61, и это записано честной границей, а не молчанием.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { IsNotEmpty, IsOptional, IsString, validateSync } from 'class-validator';

import { BLANK_ALLOWED, BLANK_NOT_CHECKED_HERE } from '../common/blank-strings';

const API_SRC = join(__dirname, '..');

function sources(dir: string = API_SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '__tests__') return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith('.ts') && !full.includes('.spec.') ? [full] : [];
  });
}

interface Field {
  /** Ключ — ФАЙЛ И КЛАСС, а не одно имя класса. Первый же прогон этой
   *  сверки слил два разных `TextDto` из разных файлов в один и объявил
   *  непоследовательным класс, у которого всё в порядке. Имя класса в
   *  проекте не уникально, и сверка, считающая иначе, отчитывается не о
   *  том доме. */
  readonly key: string;
  readonly cls: string;
  readonly field: string;
  readonly deco: string;
}

const FORBIDS_BLANK = /@IsNotEmpty\(|@MinLength\(|@Length\(/;

/** Разбор БЕЗ комментариев. Эта сверка читала их как код, и собственный
 *  комментарий с датой `2026-09-30:` прочитался как поле по имени `30`,
 *  после чего разбор класса развалился. Проект уже ловил эту ловушку
 *  дважды — в сверке публичных поверхностей и в стороже перечислений;
 *  здесь она сработала в третий раз, и число полей до снятия
 *  комментариев было НЕВЕРНЫМ. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const EACH = /each:\s*true/;

/** Строковые поля классов, размеченных валидаторами. */
function stringFields(): { single: Field[]; lists: Field[] } {
  const single: Field[] = [];
  const lists: Field[] = [];
  for (const file of sources()) {
    const src = withoutComments(readFileSync(file, 'utf8'));
    for (const cls of src.matchAll(/(?:export\s+)?class\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
      if (!/@Is[A-Z]\w*\(/.test(cls[2])) continue;
      for (const f of cls[2].matchAll(/((?:\s*@\w+\([^)]*\)\s*)*)\s*(\w+)[!?]?\s*:\s*[^;]+;/g)) {
        if (!/@IsString\(/.test(f[1])) continue;
        const entry = { key: `${file.slice(API_SRC.length + 1)}#${cls[1]}`, cls: cls[1], field: f[2], deco: f[1] };
        if (EACH.test(f[1])) lists.push(entry);
        else single.push(entry);
      }
    }
  }
  return { single, lists };
}

const FIELDS = stringFields();

describe('[the-question-was-asked-of-the-neighbour] вопрос о пустой строке', () => {
  it('проба механизма: поля вообще находятся, и часть из них запрет уже несёт', () => {
    // Пустой разбор сделал бы всё ниже сравнением пустот.
    expect(FIELDS.single.length).toBe(142);
    expect(FIELDS.lists.length).toBe(15);
    expect(FIELDS.single.filter((f) => FORBIDS_BLANK.test(f.deco)).length).toBe(70);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни один список строк не принимает пустой элемент', () => {
    // До этого пункта таких не было НИ ОДНОГО из пятнадцати.
    const accepting = FIELDS.lists
      .filter((f) => !new RegExp(`@IsNotEmpty\\([^)]*each:\\s*true`).test(f.deco))
      .map((f) => `${f.cls}.${f.field}`);
    expect(accepting).toEqual([]);
  });

  /** Поля без ответа на вопрос о пустоте — при заданном списке
   *  разрешённых. Вынесено, чтобы обратная проба гоняла ТУ ЖЕ
   *  машинерию: без неё мутация «считать всё разрешённым» проходила
   *  насквозь, потому что ожидание пустое и без неё. */
  function unanswered(allowedKeys: ReadonlySet<string>): string[] {
    const byClass = new Map<string, Field[]>();
    for (const f of FIELDS.single) {
      if (!byClass.has(f.key)) byClass.set(f.key, []);
      byClass.get(f.key)!.push(f);
    }
    const out: string[] = [];
    for (const [, fields] of byClass) {
      if (fields.length < 2) continue;
      if (!fields.some((f) => FORBIDS_BLANK.test(f.deco))) continue; // вопрос здесь не задавали вовсе
      for (const f of fields) {
        if (FORBIDS_BLANK.test(f.deco)) continue;
        if (allowedKeys.has(`${f.cls}.${f.field}`)) continue;
        out.push(`${f.cls}.${f.field}`);
      }
    }
    return out.sort();
  }

  it('обратная проба: с пустым реестром тот же проход находит все двадцать четыре', () => {
    // Иначе «ничего не найдено» значило бы «искать было нечем».
    expect(unanswered(new Set()).length).toBe(BLANK_ALLOWED.length);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: там, где вопрос задавали, он задан каждому полю — или назван в реестре', () => {
    const allowed = new Set(BLANK_ALLOWED.map((a) => `${a.cls}.${a.field}`));
    expect(unanswered(allowed)).toEqual([]);
  });

  it('имя класса в проекте НЕ уникально — вот почему ключ включает файл', () => {
    // Факт, оправдывающий ключ «файл#класс». Мутация «ключевать по
    // имени класса» сегодня сверку НЕ роняет: ложное срабатывание,
    // которое она вызвала на первом прогоне, устранено в источнике
    // (`TextDto.campaign` получил запрет пустоты). Правило оставлено и
    // подпёрто этим фактом, а не тем, что оно якобы что-то ловит.
    const byName = new Map<string, Set<string>>();
    for (const f of FIELDS.single) {
      if (!byName.has(f.cls)) byName.set(f.cls, new Set());
      byName.get(f.cls)!.add(f.key);
    }
    const duplicated = [...byName.entries()].filter(([, keys]) => keys.size > 1).map(([name]) => name);
    expect(duplicated.includes('TextDto')).toBe(true);
    expect(duplicated.length > 0).toBe(true);
  });

  it('в реестре нет записей о полях, которых больше нет', () => {
    const present = new Set(FIELDS.single.map((f) => `${f.cls}.${f.field}`));
    const stale = BLANK_ALLOWED.filter((a) => !present.has(`${a.cls}.${a.field}`)).map((a) => `${a.cls}.${a.field}`);
    expect(stale).toEqual([]);
  });

  it('у каждой записи реестра есть причина', () => {
    expect(BLANK_ALLOWED.filter((a) => a.why.trim().length === 0).map((a) => a.field)).toEqual([]);
    expect(BLANK_ALLOWED.length).toBe(24);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: правило и правда отвергает пустоту — проверено валидатором', () => {
    class Probe {
      @IsOptional()
      @IsString()
      @IsNotEmpty()
      single?: string;

      @IsOptional()
      @IsString({ each: true })
      @IsNotEmpty({ each: true })
      list?: string[];
    }

    const blankSingle = Object.assign(new Probe(), { single: '' });
    expect(validateSync(blankSingle).length).toBe(1);

    const blankInList = Object.assign(new Probe(), { list: ['есть текст', ''] });
    expect(validateSync(blankInList).length).toBe(1);

    // Обратная проба: непустое проходит, и отсутствие поля — тоже.
    expect(validateSync(Object.assign(new Probe(), { single: 'текст', list: ['а', 'б'] })).length).toBe(0);
    expect(validateSync(new Probe()).length).toBe(0);
  });

  it('записано, чего сверка не делает', () => {
    expect(BLANK_NOT_CHECKED_HERE.length).toBe(3);
    expect(BLANK_NOT_CHECKED_HERE.filter((s) => s.trim().length === 0)).toEqual([]);
    // Самое важное из непроверенного названо: строка из пробелов проходит.
    expect(BLANK_NOT_CHECKED_HERE.some((s) => s.includes('из одних пробелов'))).toBe(true);
  });
});

// Пункт [ceiling-hid-inside-a-total] 2026-09-24 — исходная половина.
//
// ПРАВИЛО ПО ФОРМЕ: КТО ВЗЯЛ ЗОНД, ТОТ ОБЯЗАН ЕГО СЪЕСТЬ.
//
// `takeWithProbe()` просит у базы на строку БОЛЬШЕ потолка — ровно для
// того, чтобы отличить «их столько» от «их больше». Эта лишняя строка
// не данные, а признак, и она обязана быть съедена `pagedList()`,
// который вернёт ровно потолок и честный флаг. Вызвать зонд и не
// вызвать едока — это отдать наружу на одну запись больше потолка и
// умолчать о самом потолке: хуже, чем не ставить его вовсе.
//
// Правило проверяется по форме, а не по списку мест: следующий вызов
// зонда заведётся не там, где его ждут.

import * as fs from 'fs';
import * as path from 'path';

const API_SRC = path.join(__dirname, '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '__tests__'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Исходник без комментариев: разбор «как было» упоминает зонд и едока
 * в тексте и не должен считаться ни нарушением, ни оправданием. */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const TAKES_PROBE = /takeWithProbe\s*\(/;
const EATS_PROBE = /pagedList\s*\(/;

describe('[ceiling-hid-inside-a-total] кто взял зонд, тот его съел', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: ни один файл не просит лишнюю строку, не съедая её', () => {
    const offenders: string[] = [];
    for (const file of sources(API_SRC)) {
      const source = code(file);
      // Сам модуль механизма зонд объявляет, а не применяет.
      if (file.endsWith(path.join('common', 'page.ts'))) continue;
      if (TAKES_PROBE.test(source) && !EATS_PROBE.test(source)) {
        offenders.push(path.relative(API_SRC, file).split(path.sep).join('/'));
      }
    }
    expect(offenders).toEqual([]);
  });

  // ОБРАТНАЯ ПРОБА. Без неё пустой список выше проходил бы и тогда,
  // когда выражения перестали находить что бы то ни было.
  it('обратная проба: разбор находит зонд без едока и не трогает пару', () => {
    const bad = 'const rows = await q.findMany({ take: takeWithProbe() });\nreturn rows;';
    const good = 'const rows = await q.findMany({ take: takeWithProbe() });\nreturn pagedList(rows);';
    expect(TAKES_PROBE.test(bad) && !EATS_PROBE.test(bad)).toBe(true);
    expect(TAKES_PROBE.test(good) && !EATS_PROBE.test(good)).toBe(false);
  });

  // Реестр мест с зондом: он не запрещает новые, он не даёт им
  // появиться незаметно. Пустой список выше сам по себе ничего не
  // значит, если зонд нигде не вызывается.
  it('зонд действительно применяется, и известно где', () => {
    const users: string[] = [];
    for (const file of sources(API_SRC)) {
      if (file.endsWith(path.join('common', 'page.ts'))) continue;
      if (TAKES_PROBE.test(code(file))) users.push(path.relative(API_SRC, file).split(path.sep).join('/'));
    }
    expect(users.sort()).toEqual([
      'admin-domains/admin-domains.service.ts',
      'audit-log/audit-log.service.ts',
      'privacy-center/privacy-center.service.ts',
      'public-discussion/public-discussion.service.ts',
    ]);
  });

  // Утверждение, стоявшее в шапке механизма («молчаливой обрезки не
  // остаётся нигде»), было неправдой двадцать дней. Оно не удалено, а
  // снабжено датированной поправкой: запись о том, что было заявлено,
  // дороже чистой шапки.
  it('поправка к переоценённому утверждению записана, а не подчищена', () => {
    const raw = fs.readFileSync(path.join(API_SRC, 'common', 'page.ts'), 'utf8');
    expect(raw.includes('Молчаливой обрезки не остаётся нигде')).toBe(true);
    expect(raw.includes('ПОПРАВКА, Пункт [ceiling-hid-inside-a-total]')).toBe(true);
  });
});

// Пункт [the-counter-read-the-whole-life] 2026-09-30 — проверка потолка
// читала весь журнал человека за всю жизнь аккаунта.
//
// НАЙДЕННОЕ. Все суточные потолки расходов считаются по журналу аудита
// одним и тем же запросом:
//
//   count({ where: { actorId, action, createdAt: { gte: сутки назад } } })
//
// Индексы у таблицы были: `[resource, resourceId]`, `[actorId]`,
// `[createdAt]` — и ни один не подходит этому запросу. По `[actorId]`
// база берёт ВСЕ записи человека (а журнал пишется на каждое действие:
// факты, согласия, решения оператора) и лишь потом отсеивает по
// действию и дате. Срока хранения у журнала нет НАМЕРЕННО — это
// записано в README Дополнением 2026-09-04, — значит выборка растёт
// всегда, и проверка потолка дорожает с каждым днём использования.
//
// Почему этого не видел ни один тест: в тестах журнал пуст, а фейковый
// Prisma отвечает мгновенно. Дефект существует только на живой базе и
// только со временем — он не «ломается», он дешевеет и дорожает. Ровно
// та порода, которую этот заход и искал.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Что индекс под этот запрос есть, что он
// составной и в правильном порядке (равенства впереди, диапазон
// последним), и — главное — что КАЖДОЕ место счёта считает по тем же
// трём полям. Пятый счётчик, написанный по образцу, но с другим
// набором полей, снова останется без индекса, и найдут это не здесь, а
// на живой базе.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const API_ROOT = join(__dirname, '..', '..');
const SCHEMA = readFileSync(join(API_ROOT, 'prisma', 'schema.prisma'), 'utf8');

function auditLogModel(): string {
  const start = SCHEMA.indexOf('model AuditLogEntry {');
  expect(start >= 0).toBe(true);
  const end = SCHEMA.indexOf('\n}', start);
  return SCHEMA.slice(start, end);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (name.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** Все места, где считаются записи журнала. Ищется по вызову, а не по
 *  списку файлов: список файлов отстаёт от кода молча. */
function countingSites(): Array<{ file: string; body: string }> {
  const sites: Array<{ file: string; body: string }> = [];
  for (const file of sourceFiles(join(API_ROOT, 'src'))) {
    const src = readFileSync(file, 'utf8');
    let from = 0;
    for (;;) {
      const at = src.indexOf('auditLogEntry.count(', from);
      if (at < 0) break;
      sites.push({ file: file.slice(API_ROOT.length + 1), body: src.slice(at, at + 400) });
      from = at + 1;
    }
  }
  return sites;
}

describe('Пункт [the-counter-read-the-whole-life]: у счётчика потолков есть свой индекс', () => {
  it('КЛЮЧЕВОЕ ПРАВИЛО: в схеме есть составной индекс под запрос счётчика', () => {
    const model = auditLogModel();
    // Порядок полей — часть правила, а не оформление: равенства
    // впереди, диапазон последним. Индекс `[createdAt, actorId, action]`
    // этому запросу помогает несравнимо хуже.
    expect(model.includes('@@index([actorId, action, createdAt])')).toBe(true);
  });

  it('прежние индексы не удалены — у них свои запросы', () => {
    const model = auditLogModel();
    // `[resource, resourceId]` — выгрузка решений о человеке;
    // `[createdAt]` — операторские выборки по времени. Новый индекс их
    // не заменяет, и «оптимизация», снявшая их, была бы регрессом.
    expect(model.includes('@@index([resource, resourceId])')).toBe(true);
    expect(model.includes('@@index([createdAt])')).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: каждое место счёта считает по тем же трём полям', () => {
    const sites = countingSites();
    // Выборка непустая — иначе сверка зеленеет, не увидев ничего.
    expect(sites.length >= 4).toBe(true);
    const offenders = sites
      .filter((s) => !(s.body.includes('actorId') && s.body.includes('action') && s.body.includes('createdAt')))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it('счёт идёт по окну в сутки, а не по всей истории', () => {
    // Запрос без границы по времени был бы «сколько всего», а не
    // «сколько за сутки»: потолок перестал бы восстанавливаться, и
    // человек упёрся бы в него навсегда.
    for (const site of countingSites()) {
      expect(/createdAt:\s*\{\s*gte/.test(site.body)).toBe(true);
    }
  });

  it('причина индекса записана рядом с ним, а не только в отчёте', () => {
    // Индекс без причины снимают при следующей чистке схемы: он же
    // «ничем не используется» — в коде на него ссылок нет по природе
    // индексов.
    const model = auditLogModel();
    expect(model.includes('[the-counter-read-the-whole-life]')).toBe(true);
    expect(model.includes('Срока хранения у журнала нет')).toBe(true);
  });
});

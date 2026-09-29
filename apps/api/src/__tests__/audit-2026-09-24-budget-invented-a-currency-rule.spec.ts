// Пункт [budget-invented-a-currency] 2026-09-24 — исходная половина.
//
// ПРАВИЛО ПО ФОРМЕ, А НЕ ПО СПИСКУ. Изъян узнаётся по одному признаку:
// валюте подставляют СТРОКУ-ЗАГЛУШКУ вместо отсутствующего значения.
// Заглушка тем и опасна, что неотличима от настоящего кода там, где её
// показывают человеку, — а показывают её везде, где показывают валюту.
//
// Список файлов устарел бы молча: четвёртый домен с бюджетом заведётся
// не там, где его ждут, и напишет ту же строку. Поэтому проверяется
// форма во всех приложениях сразу.

import * as fs from 'fs';
import * as path from 'path';

const APPS = path.join(__dirname, '..', '..', '..');

/** Валюте назначают строковую заглушку: `currency ?? 'X'`,
 * `currency || "X"`, `currency ?? \`X\``. */
const SENTINEL_CURRENCY = /\bcurrency\b[^\n]{0,40}?(\?\?|\|\|)\s*(['"`])[A-Za-z][^'"`\n]*\2/;

/** Пустая строка — не заглушка, а «ничего не показывать»: она не
 * притворяется кодом валюты. Проверяется отдельным выражением, чтобы
 * различие было видно, а не спрятано в отрицании внутри основного. */
const EMPTY_FALLBACK = /\bcurrency\b[^\n]{0,40}?(\?\?|\|\|)\s*(['"`])\2/;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', 'dist', '.turbo', 'build', '__tests__'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Исходник без комментариев: разбор «как было раньше» цитирует
 * нарушение и не должен считаться нарушением. */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function offendingLines(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => SENTINEL_CURRENCY.test(line) && !EMPTY_FALLBACK.test(line))
    .map((line) => line.trim());
}

describe('[budget-invented-a-currency] валюте не подставляют слово-заглушку', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: ни в одном приложении валюта не подменяется строкой-заглушкой', () => {
    const offenders: string[] = [];
    for (const app of ['api', 'tma', 'admin', 'landing']) {
      const dir = path.join(APPS, app, 'src');
      if (!fs.existsSync(dir)) continue;
      for (const file of sources(dir)) {
        for (const line of offendingLines(code(file))) {
          offenders.push(`${app}: ${path.basename(file)}: ${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // ОБРАТНАЯ ПРОБА. Без неё пустой список выше проходил бы и тогда,
  // когда выражение перестало находить что бы то ни было.
  it('обратная проба: разбор находит именно заглушку и не трогает пустую строку', () => {
    expect(offendingLines("const key = item.currency ?? 'UNSPECIFIED';")).toHaveLength(1);
    expect(offendingLines('const key = item.currency ?? `UNKNOWN`;')).toHaveLength(1);
    expect(offendingLines("const key = item.currency || 'N/A';")).toHaveLength(1);
    // Пустая строка ничего не выдумывает — она ничего и не показывает.
    expect(offendingLines("`${a.estimatedValue} ${a.currency ?? ''}`")).toEqual([]);
    // Комментарий, цитирующий изъян, нарушением не считается.
    expect(offendingLines(code(path.join(__dirname, '..', 'common', 'money.ts')))).toEqual([]);
  });

  // Реестр расчётов бюджета: каждый обязан идти через общее правило.
  // Сервис, заведший свой расчёт, здесь и обнаружится.
  it('каждый расчёт бюджета делегирует общему правилу', () => {
    const withBudget: string[] = [];
    const delegating: string[] = [];
    for (const file of sources(path.join(APPS, 'api', 'src'))) {
      const source = code(file);
      if (!/async getBudget\s*\(/.test(source)) continue;
      // Контроллер только пробрасывает вызов — расчёта у него нет.
      if (/\.controller\.ts$/.test(file)) continue;
      const rel = path.relative(path.join(APPS, 'api', 'src'), file).split(path.sep).join('/');
      withBudget.push(rel);
      if (/budgetByCurrency\(/.test(source)) delegating.push(rel);
    }
    expect(withBudget.sort()).toEqual([
      'dtp/dtp-v2.service.ts',
      'family-law/family-law-v2.service.ts',
      'health/health-v2.service.ts',
    ]);
    expect(delegating.sort()).toEqual(withBudget.sort());
  });
});

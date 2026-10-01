// Пункт [unclosed-list-closed-itself] 2026-09-29 — сторож утверждений
// документа о собственных пробелах.
//
// НАХОДКА. Честный список «найдено, но НЕ закрыто» от 2026-09-03 был
// закрыт целиком, а строка «по-прежнему в очереди» простояла неправдой
// двадцать шесть дней — рядом с файлом, названным по этой самой строке.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Каждое утверждение «у названного места нет
// теста» в `TODO.md` и `README.md` стои́т в реестре
// `claimed-absence.ts`, и у каждого есть проба: у держащегося — что
// пробел и правда ещё есть, у закрытого — что закрытие на месте.
//
// ПОЧЕМУ ЭТО НЕ КРУГОВАЯ ПРОВЕРКА. Сторож краснеет в ОБЕ стороны.
// Закроют пробел, не переписав документ, — упадёт проба держащегося
// утверждения. Напишут в документе новое «теста нет» — упадёт
// замкнутость реестра. Удалят спеку, закрывшую пробел, — упадёт проба
// закрытого. Разбор не молчит впустую: обратная проба ниже показывает,
// что он находит утверждение в подложенном тексте.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  ABSENCE_NOT_CHECKED_HERE,
  CLAIMED_ABSENCES,
  UNTESTED_METHODS_ROW,
  absenceClaims,
  absenceCounts,
  closedRow,
} from '../common/claimed-absence';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOCS = { 'TODO.md': '', 'README.md': '' } as Record<'TODO.md' | 'README.md', string>;
DOCS['TODO.md'] = readFileSync(join(REPO, 'TODO.md'), 'utf8');
DOCS['README.md'] = readFileSync(join(REPO, 'README.md'), 'utf8');

/** Зависимости, означающие DOM-рендерер в проверках. */
function domRenderers(deps: readonly string[]): string[] {
  return deps.filter((d) => d === 'jsdom' || d.startsWith('@testing-library'));
}

/** Заголовок блока админки, о котором документ говорит «теста нет». */
const BLOCK = 'Ручные миграции';

/** Ожидаемое число утверждений под каждым якорем — из реестра. */
function expectedCounts(doc: 'TODO.md' | 'README.md'): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of CLAIMED_ABSENCES) {
    if (e.doc !== doc) continue;
    out.set(e.anchor, (out.get(e.anchor) ?? 0) + e.phrases);
  }
  return out;
}

/** Пары «якорь=число», отсортированные: сравнивать удобнее строками —
 *  расхождение видно целиком, а не по одному ключу. */
function asPairs(counts: Map<string, number>): string[] {
  return [...counts.entries()].map(([k, v]) => `${k}=${v}`).sort();
}

/** Текст без комментариев. Упоминание `jsdom` в комментарии — рассказ о
 *  том, ЧЕГО нет; принять его за наличие значило бы объявить пробел
 *  закрытым по слову о нём. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function read(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf8');
}

describe('[unclosed-list-closed-itself] утверждения документа о собственных пробелах', () => {
  describe('замкнутость реестра', () => {
    it('в TODO.md нет ни одного утверждения «теста нет» мимо реестра', () => {
      expect(asPairs(absenceCounts('TODO.md', DOCS['TODO.md']))).toEqual(asPairs(expectedCounts('TODO.md')));
    });

    it('в README.md нет ни одного утверждения «теста нет» мимо реестра', () => {
      expect(asPairs(absenceCounts('README.md', DOCS['README.md']))).toEqual(asPairs(expectedCounts('README.md')));
    });

    it('у каждой записи реестра названа проба — реестр не список, а проверка', () => {
      const withoutProbe = CLAIMED_ABSENCES.filter((e) => e.probe.trim().length === 0).map((e) => e.anchor);
      expect(withoutProbe).toEqual([]);
    });

    it('каждая названная проба и правда есть среди тестов этого файла', () => {
      const own = readFileSync(__filename, 'utf8');
      const titles = new Set([...own.matchAll(/(?:it|test)\(\s*'([^']+)'/g)].map((m) => m[1]));
      const missing = [...new Set(CLAIMED_ABSENCES.map((e) => e.probe))].filter((p) => !titles.has(p));
      expect(missing).toEqual([]);
    });
  });

  describe('утверждения, которые держатся сегодня', () => {
    it('реестр растущих чтений проверяет печать флага только у телеметрии', () => {
      // Пункт [the-example-stopped-being-an-example] 2026-09-30 сказал в
      // документах: «реестр не проверяет, что экран печатает флаг
      // неполноты — только что сервер его отдаёт; для телеметрии печать
      // проверена, для остальных нет». Проба доказывает, что пробел
      // настоящий: в сверке реестра читается РОВНО ОДИН экранный файл, и
      // это телеметрия. Как только проверят печать у второго чтения,
      // проба покраснеет — и утверждение в документах придётся
      // переписать, а не оставить как было.
      const spec = readFileSync(
        join(__dirname, 'audit-2026-09-30-the-example-stopped-being-an-example.spec.ts'),
        'utf8',
      );
      const screens = [...spec.matchAll(/'([a-z-]+)',\s*'page\.tsx'/g)].map((m) => m[1]);
      expect(screens).toEqual(['telemetry']);
    });

    it('в проверках TMA по-прежнему нет DOM-рендерера', () => {
      const pkg = JSON.parse(read('apps', 'tma', 'package.json')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      expect(domRenderers(deps)).toEqual([]);
      // Пустой ответ сам по себе ничего не значит: тот же отбор на
      // подложенном списке обязан находить оба вида. Без этой строки
      // мутация «список пуст по построению» проходила насквозь.
      expect(domRenderers(['react', 'jsdom', '@testing-library/react'])).toEqual([
        'jsdom',
        '@testing-library/react',
      ]);

      // Раннер рисует разметку статически: `react-dom/server` есть,
      // `react-dom/client` — нет. Именно второй означал бы клик.
      const specs = read('apps', 'tma', 'src', '__tests__', 'voiceprint-promised-what-it-could-not-do.spec.ts');
      const code = withoutComments(specs);
      expect(code.includes('react-dom/client')).toBe(false);
      expect(code.includes('jsdom')).toBe(false);
    });

    it('блок «Ручные миграции» по-прежнему живёт внутри страницы', () => {
      // Пробел держится не потому, что «в админке нечем прогнать
      // разметку» — средство есть с 2026-09-26, — а потому, что блок не
      // вынесен в компонент: рисовать в проверке нечего.
      // Комментарии снимаются НАРОЧНО: в `page.tsx` заголовок блока
      // назван и в комментарии тоже, и проверка по сырому тексту
      // зеленела бы от упоминания. Поймано мутацией «блок
      // переименован»: она прошла насквозь.
      const page = withoutComments(read('apps', 'admin', 'src', 'app', 'db', 'page.tsx'));
      expect(page.includes(BLOCK)).toBe(true);

      // Вынесли бы в компонент — блок стало бы чем рисовать, и абзац
      // документа обязан был бы измениться.
      //
      // Комментарии снимаются и здесь. 2026-09-30 эта проверка покраснела
      // на `SpendCeilingsCard.tsx`, который лишь УПОМИНАЕТ блок в своей
      // шапке («у него до сих пор нет теста, потому что он внутри
      // страницы»). Правило про упоминание было записано тремя строками
      // выше и применено к одной из трёх выборок — то самое «правило
      // было, просто не везде», в стороже, которому был один день.
      const inComponents = readdirSync(join(REPO, 'apps', 'admin', 'src', 'components')).filter((f) =>
        withoutComments(readFileSync(join(REPO, 'apps', 'admin', 'src', 'components', f), 'utf8')).includes(BLOCK),
      );
      expect(inComponents).toEqual([]);

      // И ни одна спека админки его не рисует.
      const specDir = join(REPO, 'apps', 'admin', 'src', '__tests__');
      const inSpecs = readdirSync(specDir).filter((f) =>
        withoutComments(readFileSync(join(specDir, f), 'utf8')).includes(BLOCK),
      );
      expect(inSpecs).toEqual([]);
    });

    it('спеки API по-прежнему не ходят в настоящую базу', () => {
      // `half-operation` говорит: семантику PostgreSQL здесь не проверить,
      // и такого теста нет. Это правда ровно пока фейк — единственная
      // Prisma в спеках.
      const spec = read('apps', 'api', 'src', '__tests__', 'audit-2026-09-04-atomicity.service.spec.ts');
      expect(withoutComments(spec).includes('new PrismaClient')).toBe(false);
    });
  });

  describe('утверждения, помеченные закрытыми', () => {
    it('шесть методов, названных пробелом 2026-09-03, покрыты поимённо', () => {
      // Имена берутся из строки таблицы, а не переписаны сюда: копия
      // сверялась бы сама с собой — ровно тот дефект, что нашёл пункт.
      const row = closedRow(DOCS['TODO.md'], UNTESTED_METHODS_ROW);
      expect(row === null).toBe(false);
      expect(row!.named.length).toBe(6);
      expect(row!.closedBy.length).toBe(1);

      const spec = row!.closedBy[0];
      expect(spec.endsWith('.spec.ts')).toBe(true);

      const closing = read('apps', 'api', 'src', '__tests__', spec);
      const notFound = row!.named.filter((m) => !closing.includes(m));
      expect(notFound).toEqual([]);
    });

    it('закрытых записей в реестре ровно столько, сколько мест об этом говорит', () => {
      const closed = CLAIMED_ABSENCES.filter((e) => e.state === 'закрыто').map((e) => e.anchor).sort();
      expect(closed).toEqual([
        'job-domain-v2-audit',
        'job-domain-v2-audit2',
        'job-domain-v2-bot',
        'unclosed-list-closed-itself',
        'unclosed-list-closed-itself',
      ]);
    });
  });

  describe('честная граница', () => {
    it('записано, чего сторож не делает', () => {
      expect(ABSENCE_NOT_CHECKED_HERE.length).toBe(4);
      expect(ABSENCE_NOT_CHECKED_HERE.filter((s) => s.trim().length === 0)).toEqual([]);
    });

    it('обратная проба: подложенное утверждение разбор находит и реестр не покрывает', () => {
      const fake = [
        '## Пункт [вымышленный-раздел] 2026-09-29: заголовок',
        '',
        'Здесь всё хорошо, и ничего не утверждается.',
        '',
        '## Пункт [вымышленный-пробел] 2026-09-29: заголовок',
        '',
        'Метод `somethingNew` остался без тестов — записано честно.',
      ].join('\n');

      const found = absenceClaims('TODO.md', fake);
      expect(found.length).toBe(1);
      expect(found[0].anchor).toBe('вымышленный-пробел');
      expect(found[0].phrases.length).toBe(1);

      // И тот же разбор, пропущенный через сравнение с реестром, даёт
      // расхождение — то есть сторож, увидев такой текст, покраснел бы.
      const counts = asPairs(absenceCounts('TODO.md', fake));
      expect(counts).toEqual(['вымышленный-пробел=1']);
      expect(asPairs(expectedCounts('TODO.md'))).not.toEqual(counts);
    });
  });
});

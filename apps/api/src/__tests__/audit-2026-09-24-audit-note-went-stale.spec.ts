// Сверка 2026-09-24 — заметка о проверке разошлась с проверкой.
//
// КАК СВЕРКА ВЫРОСЛА ИЗ ПРЕДЫДУЩЕЙ. [log-says-we-saw-it] разбирал записи,
// утверждающие то, чего продукт не наблюдал. Здесь то же самое, но
// утверждение сделано не перед пользователем, а перед СЛЕДУЮЩИМ
// РАЗРАБОТЧИКОМ — и стои́т внутри защитного механизма.
//
// ИЗМЕРЕНИЕ. `ProjectFrozenGuard` находит проект по URL и отказывает в
// заморозке только тогда, когда НАШЁЛ: не нашёл — пропускает. Решение
// верное (guard не знает, есть ли у маршрута проект вообще), но у него
// есть цена: каждый нерезолвящийся маршрут проходит мимо заморозки.
//
// Шапка самого guard'а говорит: «сверены все 154 мутирующих маршрута
// доменов… три маршрута он не резолвит в принципе». Перебор показал:
// мутирующих маршрутов под guard'ом 161, не резолвится ШЕСТНАДЦАТЬ.
//
// НАЙДЕНО — И ЧЕГО НЕ НАЙДЕНО. Живого обхода заморозки НЕТ: все
// шестнадцать объяснимы, и проверено это поимённо (семь — создание
// проекта, два — сущность без проекта, четыре — заморозка стои́т в
// сервисе, два — отзыв, который обязан работать всегда, два — системные
// маршруты за секретом рассылки). Говорить, что найден обход, было бы
// преувеличением, то есть той же неправдой, что и молчание, только в
// другую сторону.
//
// Дефект в другом: УТВЕРЖДЕНИЕ О ПРОВЕРКЕ, записанное внутри самой
// проверки, перестало быть правдой, и ничто этого не заметило. Для
// следующего человека «сверены все 154, не резолвятся три» читается как
// «за тебя уже посмотрели». Устаревшая заметка в защитном механизме
// работает не как отсутствие документации, а хуже — как ложное
// свидетельство о проверке.
//
// И ОДИН РАЗ ИЗЪЯН МЕТОДА УЖЕ НАХОДИЛИ. В `hiring-extras.service.ts`
// стоит комментарий: «Прошлая сверка заморозки перебирала маршруты С
// guard'ом и этот контроллер не увидела вовсе: у публичного контроллера
// guard'а нет по определению». Метод залатали в одном месте — и оставили
// ручным. Это пятый случай за сессию, когда правило, которое держится
// дисциплиной, разъезжается; и первый, где разъехалась не сама проверка,
// а СКАЗАННОЕ О НЕЙ.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { UNRESOLVED_ROUTES } from '../project-freeze/unresolved-routes';
import { parseDomainRoute } from '../project-freeze/project-frozen.guard';

const SRC = join(__dirname, '..');

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : controllerFiles(full);
    return name.endsWith('.controller.ts') ? [full] : [];
  });
}

/** Все мутирующие маршруты классов, на которых стои́т ProjectFrozenGuard.
 * Перебор по дереву, а не по списку файлов: список устарел бы молча —
 * ровно так и устарела заметка, из-за которой написана эта сверка. */
function mutatingGuardedRoutes(): Array<{ method: string; path: string; file: string }> {
  const out: Array<{ method: string; path: string; file: string }> = [];
  for (const file of controllerFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('ProjectFrozenGuard')) continue;
    // `@Controller()` без префикса — тоже контроллер, и пропустить его
    // легко: первая редакция этого перебора искала только
    // `@Controller('...')` и не увидела целый класс с мутирующими
    // маршрутами. Поймала это обратная проверка ниже («в списке нет
    // маршрутов, которых больше нет») — то есть ровно тот инструмент,
    // ради которого она и написана, сработал на самой сверке.
    const marks = [...src.matchAll(/@Controller\((?:'([^']*)')?\)/g)];
    for (let i = 0; i < marks.length; i++) {
      const head = src.slice(i > 0 ? marks[i - 1].index! + marks[i - 1][0].length : 0, marks[i].index!);
      if (!head.includes('ProjectFrozenGuard')) continue;
      const body = src.slice(marks[i].index!, i + 1 < marks.length ? marks[i + 1].index! : src.length);
      for (const r of body.matchAll(/@(Post|Put|Patch|Delete)\(\s*'([^']*)'\s*\)/g)) {
        const path = '/' + [marks[i][1] ?? '', r[2]].join('/').split('/').filter(Boolean).join('/');
        out.push({ method: r[1].toUpperCase(), path, file });
      }
    }
  }
  return out;
}

describe('Сверка [audit-note-went-stale]: список необъяснённых маршрутов держится проверкой', () => {
  it('КЛЮЧЕВОЙ ТЕСТ, Пункт [three-said-seven] 2026-09-30: реестр без дублей, и число в прозе — настоящее', () => {
    // Сверка ниже держит РАВЕНСТВО МНОЖЕСТВ в обе стороны, и дубль её
    // не ронял: в реестре лежало 31 запись при 30 разных маршрутах, а
    // шапки двух файлов одного и того же Пункта называли два разных
    // числа — «ШЕСТНАДЦАТЬ» и «ТРИДЦАТЬ». Числа в прозе не держало
    // ничто. Теперь держит.
    const keys = UNRESOLVED_ROUTES.map((r) => `${r.method} ${r.path}`);
    const dups = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dups).toEqual([]);
    expect(UNRESOLVED_ROUTES.length).toBe(30);

    // И число названо в шапке ИМЕННО ЭТОГО файла тем же словом, каким
    // его читает человек: сверка по тексту здесь единственно возможна
    // — у прозы нет поведения.
    // Файл целиком: фраза про семейство стоит рядом со своими
    // записями, а не в шапке. Обрезать чтение по 4000 знаков значило
    // бы проверять не то, что читает человек.
    const header = readFileSync(join(__dirname, '..', 'project-freeze', 'unresolved-routes.ts'), 'utf8');
    expect(header.includes('не резолвится ТРИДЦАТЬ')).toBe(true);
    expect(header.includes('ШЕСТНАДЦАТЬ')).toBe(false);

    // Семейство `no-project` названо числом в том же файле — и это
    // число тоже разошлось (было «четырнадцать» при одиннадцати).
    const noProject = UNRESOLVED_ROUTES.filter((r) => r.reason === 'no-project').length;
    expect(noProject).toBe(11);
    expect(header.includes('вот эти одиннадцать и больше ничего')).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: каждый маршрут, который guard не резолвит, назван и объяснён', () => {
    const declared = new Set(UNRESOLVED_ROUTES.map((r) => `${r.method} ${r.path}`));
    const actual = mutatingGuardedRoutes().filter((r) => parseDomainRoute(r.path) === null);
    const unexplained = actual.map((r) => `${r.method} ${r.path}`).filter((k) => !declared.has(k));
    // Новый маршрут мимо заморозки уронит сверку ДО того, как о нём
    // напишут заметку. Именно этого не было пять сверок подряд.
    expect([...new Set(unexplained)].sort()).toEqual([]);
    // Разбор жив: маршруты вообще находятся.
    expect(mutatingGuardedRoutes().length).toBeGreaterThan(100);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: в списке нет маршрутов, которых больше нет', () => {
    // Обратная сторона: устаревший список — та же ложь о проверке, что
    // и устаревшая заметка, из-за которой сверка и написана.
    const actual = new Set(
      mutatingGuardedRoutes()
        .filter((r) => parseDomainRoute(r.path) === null)
        .map((r) => `${r.method} ${r.path}`),
    );
    const vanished = UNRESOLVED_ROUTES.map((r) => `${r.method} ${r.path}`).filter((k) => !actual.has(k));
    expect(vanished).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: «проверяется в сервисе» — не слово, а ссылка на место', () => {
    // Самая опасная причина из пяти: она УТВЕРЖДАЕТ, что проверка есть
    // где-то ещё. Утверждение без адреса — это ровно то, что сверка
    // разбирает; поэтому адрес обязателен, и он обязан существовать.
    const sources = controllerFiles(SRC).length > 0
      ? (function all(dir: string): string[] {
          return readdirSync(dir).flatMap((name) => {
            const full = join(dir, name);
            if (statSync(full).isDirectory()) return name === '__tests__' ? [] : all(full);
            return name.endsWith('.ts') ? [readFileSync(full, 'utf8')] : [];
          });
        })(SRC)
      : [];
    const haystack = sources.join('\n');
    for (const route of UNRESOLVED_ROUTES) {
      if (route.reason !== 'checked-in-service') {
        expect([route.path, route.checkedIn ?? null]).toEqual([route.path, null]);
        continue;
      }
      expect([route.path, typeof route.checkedIn]).toEqual([route.path, 'string']);
      const method = route.checkedIn!.split('.')[1];
      expect([route.path, new RegExp(`async ${method}\\(`).test(haystack)]).toEqual([route.path, true]);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: правило действительно срабатывает на новом маршруте мимо заморозки', () => {
    // Обратная проба. За эту сессию пять раз выяснялось, что правило
    // сторожит ровно то, что уже исправлено.
    expect(parseDomainRoute('/dtp/projects')).toBeNull();
    expect(parseDomainRoute('/dtp/невиданный-раздел/abc')).toBeNull();
    // А то, что guard резолвит, — резолвится.
    expect(parseDomainRoute('/dtp/configs/abc')).toMatchObject({ domain: 'dtp', kind: 'configs', id: 'abc' });
    expect(parseDomainRoute('/dtp/projects/p1/что-угодно')).toMatchObject({ kind: 'projects', id: 'p1' });
  });
});

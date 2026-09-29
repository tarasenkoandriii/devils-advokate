// Пункт [badge-was-the-key] 2026-09-24 — исходная половина.
//
// ПРАВИЛО: НА ПОВЕРХНОСТИ БЕЗ АУТЕНТИФИКАЦИИ ПОЛЯ НАЗЫВАЮТСЯ ПОИМЁННО.
//
// Вывод сверки 2026-09-06 был записан дословно: считать чувствительным
// надо не по названию поля, а по ПОВЕРХНОСТИ — что уходит туда, где нет
// аутентификации. Применили его к одной поверхности из трёх, и на
// оставшихся двух наружу уходили целые строки: субъективный вес
// аргумента, внутренний идентификатор автора, ссылка на частный проект
// и, хуже всего, удостоверение участника.
//
// Поэтому правило проверяется ПО ФОРМЕ и сразу на всех трёх: чтение,
// результат которого возвращается из метода публичного контроллера,
// обязано нести `select`. Список полей — решение, принятое один раз;
// строка целиком — решение, не принятое никем, и растущее само собой с
// каждым новым полем схемы.

import * as fs from 'fs';
import * as path from 'path';

const API_SRC = path.join(__dirname, '..');

// ПОПРАВКА, Пункт [letters-were-not-the-language] 2026-09-24.
//
// Здесь стоял перебор файлов по имени `*.public-controller.ts`. Он
// находил ТРИ поверхности из СЕМИ: четыре контроллера без гварда живут
// в обычных `*.controller.ts` рядом с защищёнными — приём анкеты
// кандидата, предпросмотр карточки по ссылке, ревью текста вакансии,
// самошеринг соискателя.
//
// И это ровно та ловушка, о которой предупреждает шапка самого реестра:
// «три из них названы `*.public-controller.ts`... любая сверка,
// перебирающая контроллеры по обычному шаблону, проходит мимо». Я
// прочитал это предупреждение, сослался на реестр — и построил перебор
// по зеркальному отражению той же ошибки: по особому имени вместо
// обычного.
//
// Источник теперь один — сам реестр. Он и заводился, чтобы новая
// поверхность не появилась молча; перебор по имени файла был вторым
// источником правды, который с ним разошёлся.
import { UNGUARDED_SURFACES } from '../common/public-surfaces';

function publicControllers(): Array<{ file: string; controller: string }> {
  return UNGUARDED_SURFACES.filter((s) => s.protection === 'token-or-open').map((s) => ({
    file: path.join(API_SRC, ...s.file.split('/')),
    controller: s.controller,
  }));
}

function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Тело ОДНОГО класса контроллера: в обычном файле их может быть
 * несколько, и без этого перебор захватил бы методы защищённых
 * соседей — то есть потребовал бы `select` там, где он не нужен, и
 * правило выключили бы целиком. */
function controllerClass(source: string, name: string): string {
  const start = source.indexOf(`class ${name}`);
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const next = rest.search(/\nclass |\n@Controller/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Методы, которые этот класс контроллера зовёт у своих сервисов, —
 * только с маршрутов БЕЗ гварда.
 *
 * Реестр прямо предупреждает об этом случае: «Приём ссылки (accept) уже
 * требует гварда — он создаёт запись владельцу». То есть у публичного
 * по имени контроллера часть маршрутов защищена на уровне метода, и
 * требовать от них того же, что от открытых, — значит требовать
 * лишнего там, где риска нет. */
function calledMethods(controllerSource: string): Set<string> {
  const names = new Set<string>();
  const routes = controllerSource.split(/\n\s*@(?=Get|Post|Patch|Put|Delete)/);
  for (const route of routes) {
    if (/@UseGuards\s*\(/.test(route)) continue;
    for (const m of route.matchAll(/this\.\w+\.(\w+)\s*\(/g)) names.add(m[1]);
  }
  return names;
}

/** Файлы сервисов рядом с контроллером: метод может лежать не в
 * одноимённом сервисе (карточка кандидата — в `*-candidate.service.ts`,
 * анкета — в `hiring-extras.service.ts`). Перебираем всю папку. */
function servicesNear(controllerFile: string): string[] {
  const dir = path.dirname(controllerFile);
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.service.ts'))
    .map((n) => path.join(dir, n));
}

/** Тело метода сервиса: от его объявления до следующего объявления. */
function methodBody(serviceSource: string, name: string): string | null {
  const start = serviceSource.search(new RegExp(`\\n {2}(?:private |protected |static )*async ${name}\\s*\\(`));
  if (start < 0) return null;
  const rest = serviceSource.slice(start + 3);
  const next = rest.search(/\n {2}(?:private |protected |static )*(?:async )?[\w]+\s*[(<]/);
  return next < 0 ? rest : rest.slice(0, next);
}

// Запись на публичном маршруте возвращает ту же строку — и сужать её
// надо на тех же основаниях. Голос за заявку возвращал `participantId`,
// то есть удостоверение автора, уже после того как чтение сузили.
const READ = /\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|update|create)\s*\(\s*\{/g;

/** Строки, которые ПОКИДАЮТ метод без перечисления полей.
 *
 * ПОПРАВКА, Пункт [letters-were-not-the-language] 2026-09-24. Первая
 * редакция требовала `select` у КАЖДОГО обращения к базе внутри
 * публичного метода. На трёх поверхностях, которые она видела, это
 * совпадало с делом; на четырёх, которые она не видела, — нет: там
 * два десятка чтений и записей служат внутренней работой (найти
 * приглашение, создать разговор, отметить ссылку принятой), а наружу
 * возвращается объект, собранный по полям руками.
 *
 * Правило, требующее `select` от таких вызовов, — это правило, которое
 * «кричит всегда»: его выключают целиком, и вместе с ним исчезает
 * защита там, где она нужна. Опасна не выборка, а СТРОКА, ПОКИНУВШАЯ
 * МЕТОД: её `return` отдаёт целиком или разворачивает в ответ.
 *
 * `include` по-прежнему не считается перечислением: он ДОБАВЛЯЕТ связи
 * к полной строке, а не сужает её. */
/** Возвращает ли САМ метод эту переменную — то есть стоит ли её
 * `return` на глубине самого метода, а не внутри вложенной функции. */
function returnedByMethodItself(body: string, name: string): boolean {
  const pattern = new RegExp(`return\\s+${name}\\s*;|return\\s+${name}\\.map\\(|\\.\\.\\.${name}\\b`, 'g');
  for (const use of body.matchAll(pattern)) {
    let depth = 0;
    for (let i = 0; i < use.index!; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') depth--;
    }
    // Тело метода открывается первой скобкой: его собственный уровень —
    // единица. `return x;` глубже — это возврат из вложенной функции, и
    // наружу он строку не выносит. А вот разворот `...x` живёт внутри
    // возвращаемого объекта, то есть на уровень глубже, — и это как раз
    // выход наружу.
    const isSpread = use[0].startsWith('...');
    if (depth <= (isSpread ? 2 : 1)) return true;
  }
  return false;
}

// Разбор приблизителен, и это сказано вслух: он ловит те формы выхода
// строки наружу, которые в этом коде встречаются, и не претендует на
// полноту. Полный ответ дал бы только разбор типов; правило, которое
// нельзя объяснить в трёх строках, не переживёт первого спора о нём.

function rowsThatEscape(body: string): string[] {
  const bad: string[] = [];
  for (const m of body.matchAll(READ)) {
    const open = body.indexOf('{', m.index!);
    let depth = 0;
    let end = open;
    for (let i = open; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const args = body.slice(open, end + 1);
    if (/\bselect:/.test(args)) continue;

    // Строка уходит наружу прямо: `return this.prisma.x.findMany({…})`.
    const before = body.slice(Math.max(0, m.index! - 120), m.index!);
    const returnedDirectly = /return\s+(await\s+)?(this\.)?[\w.]*$/.test(before.replace(/\s+/g, ' ').trimEnd() + '');
    // Либо через переменную, которую возвращает или разворачивает САМ
    // метод. `return created;` внутри вложенной функции (транзакция,
    // колбэк) наружу не выходит — оно возвращает значение в ту же
    // функцию; первая редакция этого не различала и назвала нарушением
    // честный код.
    const assigned = /(?:const|let)\s+([\w{}\s,:]+?)\s*=\s*(?:await\s+)?[\w.]*$/.exec(before.trimEnd());
    let escapes = returnedDirectly;
    if (!escapes && assigned) {
      const name = assigned[1].trim();
      if (/^\w+$/.test(name)) escapes = returnedByMethodItself(body, name);
    }
    if (escapes) bad.push(`${m[1]}(${args.slice(0, 60).replace(/\s+/g, ' ')}…)`);
  }
  return bad;
}



describe('[badge-was-the-key] на поверхности без аутентификации поля названы поимённо', () => {
  it('поверхностей семь, и они известны поимённо', () => {
    const found = publicControllers()
      .map((s) => s.controller)
      .sort();
    // Новая публичная поверхность не должна появиться незаметно: этот
    // список и есть то, на что правило ниже распространяется. Прежде
    // здесь стояло «ровно три» — по перебору имён файлов; реестр всё
    // это время знал о семи.
    expect(found).toEqual([
      'CandidateSelfSharePublicController',
      'InterviewPoolShareController',
      'LibraryPublicController',
      'PostingReviewPublicController',
      'PreQuestionnairePublicController',
      'PublicDiscussionPublicController',
      'VenueApplicationPublicController',
    ]);
    // И каждый из них действительно существует в названном файле.
    for (const surface of publicControllers()) {
      expect(fs.existsSync(surface.file)).toBe(true);
      expect(controllerClass(code(surface.file), surface.controller).length).toBeGreaterThan(50);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни одно чтение и ни одна запись публичного метода не возвращают строку целиком', () => {
    const offenders: string[] = [];
    for (const surface of publicControllers()) {
      const methods = calledMethods(controllerClass(code(surface.file), surface.controller));
      for (const service of servicesNear(surface.file)) {
        const serviceSource = code(service);
        const rel = path.relative(API_SRC, service).split(path.sep).join('/');
        for (const method of methods) {
          const body = methodBody(serviceSource, method);
          if (!body) continue;
          for (const bad of rowsThatEscape(body)) offenders.push(`${rel}: ${method}: ${bad}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // ОБРАТНАЯ ПРОБА. Без неё пустой список выше проходил бы и тогда,
  // когда разбор перестал находить хоть какое-нибудь чтение.
  it('обратная проба: нарушением считается строка, ПОКИНУВШАЯ метод, а не всякое чтение', () => {
    expect(rowsThatEscape('return p.libraryEntry.findMany({ where: { a: 1 } });')).toHaveLength(1);
    expect(rowsThatEscape('return p.libraryEntry.findMany({ where: { a: 1 }, select: { id: true } });')).toEqual([]);
    // `include` не сужает строку, а расширяет её — это не перечисление.
    expect(rowsThatEscape('return p.x.findFirst({ include: { y: true } });')).toHaveLength(1);
    // Запись, возвращающая строку, проверяется на тех же основаниях.
    expect(rowsThatEscape('return p.x.update({ where: { id }, data: { n: 1 } });')).toHaveLength(1);
    expect(rowsThatEscape('return p.x.update({ where: { id }, data: { n: 1 }, select: { id: true } });')).toEqual([]);
    // Внутренний поиск, результат которого наружу не идёт, — не находка.
    expect(rowsThatEscape('{ const invite = await p.x.findFirst({ where: { t } }); if (!invite) throw e; return { ok: true }; }')).toEqual([]);
    // А тот же поиск, развёрнутый в ответ, — находка.
    expect(rowsThatEscape('{ const invite = await p.x.findFirst({ where: { t } }); return { ...invite }; }')).toHaveLength(1);
    // `return` внутри вложенной функции не выводит строку из метода.
    expect(
      rowsThatEscape('{ const p1 = await tx.x.create({ data: {} }); const r = await run(async () => { return p1; }); return { id: r.id }; }'),
    ).toEqual([]);
  });

  it('обратная проба: разбор различает классы контроллеров в одном файле', () => {
    // Без этого перебор захватил бы методы защищённых соседей — и
    // правило потребовало бы `select` там, где он не нужен.
    const src = code(path.join(API_SRC, 'hiring-extras', 'hiring-extras.controller.ts'));
    const publicOnly = controllerClass(src, 'PreQuestionnairePublicController');
    expect(publicOnly.length).toBeGreaterThan(50);
    expect(publicOnly.length).toBeLessThan(src.length);
    expect(calledMethods(publicOnly).has('preQuestionnaireForm')).toBe(true);
  });

  it('обратная проба: разбор действительно доходит до тел публичных методов', () => {
    const service = code(path.join(API_SRC, 'public-discussion', 'public-discussion.service.ts'));
    const body = methodBody(service, 'publicView');
    expect(body).toBeTruthy();
    expect(READ.test(body!)).toBe(true);
  });
});

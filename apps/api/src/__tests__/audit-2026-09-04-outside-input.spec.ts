// Сверка «что можно прислать снаружи» 2026-09-04.
//
// Предыдущий заход ([background-jobs]) разбирал то, у чего нет зрителя.
// Этот — то, у чего нет пропуска: маршруты, до которых дотягиваются без
// аутентификации.
//
// НАЙДЕНО.
//
// 1. Контроллеров с маршрутами без гварда — ПЯТНАДЦАТЬ, маршрутов —
//    тридцать два. При этом в коде стояло два взаимно противоречащих
//    честных утверждения: «единственный контроллер за весь проект без
//    Telegram-аутентификации» (public-discussion) и «второй (после
//    public-discussion) публичный контроллер проекта» (library). Оба
//    были написаны добросовестно, оба устарели, и ни одно ничем не
//    проверялось. Общего списка «что торчит наружу» не было нигде.
//
// 2. Шесть эндпоинтов ЗАПИСИ доступны без аутентификации, и DTO двух из
//    трёх принимающих контроллеров не имели ни одного декоратора:
//    `text!: string` — это тип TypeScript, он исчезает при компиляции,
//    и в базу уходил текст любой длины от любого, кто знает ссылку;
//    `stance!: 'PRO' | 'CON'` в рантайме не проверялось ничем. Пункт
//    [validation] 2026-09-01, вводя ValidationPipe, прямо назвал
//    «публичные POST» среди первых приоритетов — и именно до них не
//    дошёл.
//
// 3. `PublicDiscussionService.vote()` содержал ровно тот дефект, который
//    повторный аудит 2026-08-30 нашёл и исправил в соседней публичной
//    фиче (`LibraryService.vote()`, метод с тем же именем): чтение-
//    потом-запись счётчика на публичном эндпоинте (lost update) плюс
//    отсутствие проверки `direction`, из-за чего любое значение, кроме
//    'up', молча считалось голосом «против». Исправление было написано,
//    объяснено — и не перенесено на близнеца.
//
// 4. `ProtectedNoteService.update()` писал тело запроса целиком:
//    `data: input`. Тип входа — ИНТЕРФЕЙС (валидация невозможна в
//    принципе), а ValidationPipe работает без `whitelist` и лишние поля
//    не отбрасывает. То есть в теле можно было прислать `projectId`
//    чужого проекта и увезти туда свою заметку: проверка владения
//    подтверждает право на старую заметку, а не на новое место.
//
// ЛОВУШКА, СРАБОТАВШАЯ ПРИ НАПИСАНИИ ЭТОЙ СВЕРКИ. Первая версия
// разбора не снимала комментарии — и строка «НАМЕРЕННО БЕЗ
// @UseGuards(TelegramAuthGuard)» читалась как наличие гварда. Два
// публичных контроллера оказались невидимы ровно из-за фразы,
// объясняющей, что они публичные. Здесь комментарии снимаются до
// разбора; если это когда-нибудь уберут, тест недосчитается поверхностей
// и промолчит — поэтому ниже стоит отдельная проверка именно на это.
//
// НЕ ИСПРАВЛЕНО НАМЕРЕННО:
//  • глобальный `whitelist: true` у ValidationPipe. Он вырезает поля БЕЗ
//    декораторов — а таких DTO-классов в контроллерах 158 из 221; их
//    тела опустели бы целиком, то есть «усиление проверки» положило бы
//    большую часть API. Обоснование уже стоит в create-app.ts, здесь оно
//    подтверждено измерением, а не памятью;
//  • 15 тел запроса, типизированных ИНТЕРФЕЙСОМ: для них ValidationPipe
//    бессилен структурно (у интерфейса нет метатипа в рантайме),
//    сколько декораторов ни пиши. Это перевод их в классы — отдельная
//    работа, а не хвост этой; число зафиксировано измерением ниже, чтобы
//    следующий заход начинал с факта;
//  • ограничение частоты на публичную запись — прямо отложено ещё в
//    [page-limits]: правильный ответ там решение владельца о модерации,
//    а не выдуманное мной число. Потолок ДЛИНЫ — другой разговор: это не
//    политика, а границы поля, и они взяты по уже сложившимся в проекте.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UNGUARDED_SURFACES, surfacesAcceptingPublicWrites } from '../common/public-surfaces';
import {
  AddCommentDto,
  SubmitArgumentDto,
  VoteDto,
} from '../public-discussion/public-discussion.public-controller';
import { AddExperienceDto, LibraryVoteDto } from '../library/library.public-controller';

const SRC = join(__dirname, '..');

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : controllerFiles(full);
    // ВАЖНО: `controller.ts`, а НЕ `.controller.ts` — три публичных
    // контроллера названы `*.public-controller.ts` и под второй шаблон
    // не подходят. Именно так они и выпадали из всех прежних сверок.
    return name.endsWith('controller.ts') ? [full] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^.*?\/\/.*$/gm, (line) => line.replace(/\/\/.*$/, ''));
}

const ROUTE = /@(Get|Post|Patch|Put|Delete)\(/g;

interface Scanned {
  controller: string;
  file: string;
  openRoutes: string[];
}

function scanUnguarded(): Scanned[] {
  const found: Scanned[] = [];
  for (const file of controllerFiles(SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const classes = [...src.matchAll(/export class (\w+)/g)].map((m) => ({ at: m.index ?? 0, name: m[1] }));
    for (let i = 0; i < classes.length; i++) {
      const start = classes[i].at;
      const end = i + 1 < classes.length ? classes[i + 1].at : src.length;
      const head = src.slice(Math.max(0, start - 400), start);
      const classGuarded = head.includes('UseGuards');
      const body = src.slice(start, end);
      const openRoutes: string[] = [];
      for (const m of body.matchAll(ROUTE)) {
        const at = m.index ?? 0;
        const nearby = body.slice(at, at + 400).split('\n').slice(0, 6);
        const methodGuarded = nearby.some((l) => l.includes('UseGuards'));
        if (!classGuarded && !methodGuarded) {
          openRoutes.push(body.slice(at, body.indexOf('\n', at)).trim());
        }
      }
      if (openRoutes.length > 0) {
        found.push({ controller: classes[i].name, file: relative(SRC, file), openRoutes });
      }
    }
  }
  return found;
}

describe('Что можно прислать снаружи: поверхности без гварда', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: каждый маршрут без гварда принадлежит контроллеру из реестра', () => {
    // Новая поверхность наружу не может появиться молча: либо она в
    // реестре с причиной, либо тест падает. Это и есть замена
    // утверждениям «единственный» / «второй» в комментариях, которые
    // ничем не проверялись и оба устарели.
    const known = new Set(UNGUARDED_SURFACES.map((s) => s.controller));
    const unregistered = scanUnguarded()
      .filter((s) => !known.has(s.controller))
      .map((s) => `${s.controller} (${s.file}): ${s.openRoutes.join(', ')}`);
    expect(unregistered).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: реестр не содержит того, чего уже нет — иначе он тоже устареет', () => {
    // Обратная сторона: контроллер закрыли гвардом, а запись в реестре
    // осталась — и реестр начинает описывать не тот проект. Ровно так
    // устарели фразы в шапках.
    const actual = new Set(scanUnguarded().map((s) => s.controller));
    const stale = UNGUARDED_SURFACES.filter((s) => !actual.has(s.controller)).map((s) => s.controller);
    expect(stale).toEqual([]);

    // Сверка конвенционных проверок 2026-09-04 ([guard-audit]): реестр
    // проверялся только на состав. Мутация «оставить запись, стереть
    // причину» проходила — а реестр без причин это просто список имён,
    // ради которого его и не заводили: смысл был в том, чтобы каждая
    // дыра наружу была ОБЪЯСНЕНА, а не перечислена.
    const unexplained = UNGUARDED_SURFACES.filter((s) => s.reason.trim().length < 60).map((s) => s.controller);
    expect(unexplained).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: у поверхностей, принимающих запись снаружи, DTO размечены валидаторами', () => {
    // Тип TypeScript снаружи не проверяет ничего. Для этих файлов
    // разметка обязательна: их тело приходит от того, кого мы не знаем.
    const writers = surfacesAcceptingPublicWrites();
    const files = UNGUARDED_SURFACES.filter((s) => writers.includes(s.controller)).map((s) => s.file);
    expect(files.length).toBeGreaterThan(0);

    const undecorated: string[] = [];
    for (const rel of files) {
      const src = stripComments(readFileSync(join(SRC, rel), 'utf8'));
      for (const m of src.matchAll(/class (\w*Dto)\s*\{([\s\S]*?)\n\}/g)) {
        if (!/@(Is|Max|Min|Matches|ArrayMaxSize|ValidateNested)\w*/.test(m[2])) {
          undecorated.push(`${rel} → ${m[1]}`);
        }
      }
    }
    expect(undecorated).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: разбор снимает комментарии — иначе фраза «БЕЗ @UseGuards» читается как гвард', () => {
    // Эта ловушка сработала на первой версии сверки: два публичных
    // контроллера стали невидимы из-за комментария, объясняющего, что
    // они публичные. Проверяется на настоящем файле, а не на выдуманной
    // строке: в шапке public-discussion такая фраза стоит и сейчас.
    const raw = readFileSync(join(SRC, 'public-discussion/public-discussion.public-controller.ts'), 'utf8');
    expect(raw).toContain('БЕЗ @UseGuards(TelegramAuthGuard)');
    expect(stripComments(raw)).not.toContain('UseGuards');
    // И сам контроллер при этом виден сверке.
    expect(scanUnguarded().map((s) => s.controller)).toContain('PublicDiscussionPublicController');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: голос на публичном обсуждении считается атомарно и с проверкой направления', () => {
    // То же исправление, что уже было сделано в LibraryService.vote()
    // повторным аудитом 2026-08-30 и не перенесено на близнеца.
    // Комментарии снимаются: объяснение находки цитирует прежний код
    // дословно, и без снятия проверка «прежнего кода больше нет»
    // спотыкалась бы о собственное объяснение.
    const src = stripComments(readFileSync(join(SRC, 'public-discussion/public-discussion.service.ts'), 'utf8'));
    expect(src).toMatch(/upvotes: \{ increment: 1 \}/);
    expect(src).toMatch(/downvotes: \{ increment: 1 \}/);
    expect(src).not.toMatch(/submission\.upvotes \+ 1/);
    expect(src).toMatch(/direction !== 'up' && direction !== 'down'/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: тело запроса не уходит в БД целиком', () => {
    // `data: input` при интерфейсном типе входа и ValidationPipe без
    // whitelist означает, что присланное сверх ожидаемого пишется в БД.
    // Сверка конвенционных проверок 2026-09-04 ([guard-audit]): раньше
    // ловилась только форма `data: input,`. Мутация `data: { ...input }`
    // проходила мимо — а дыра при этом ровно та же: в UPDATE уезжает всё,
    // что прислали. Проверка ловит обе формы; «поимённо перечисленные
    // поля» отличаются от них тем, что там стоят `input.<поле>`.
    const offenders: string[] = [];
    for (const file of controllerFilesAndServices()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      if (/data:\s*(input|dto)\s*[,}]/.test(src)) offenders.push(`${relative(SRC, file)} (data: input)`);
      if (/data:\s*\{\s*\.\.\.(input|dto)\s*[,}]/.test(src)) offenders.push(`${relative(SRC, file)} (data: { ...input })`);
    }
    expect(offenders).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (поведение): проверки публичных DTO действительно срабатывают, а не просто написаны', async () => {
    // Статическая проверка выше говорит «декораторы есть». Этот тест
    // прогоняет их тем же class-validator, которым их исполняет
    // ValidationPipe: декоратор, который ничего не отвергает, — это
    // строка в файле, а не проверка.
    const long = 'а'.repeat(5000);

    expect(await validate(plainToInstance(SubmitArgumentDto, { text: long, stance: 'PRO' }))).not.toEqual([]);
    expect(await validate(plainToInstance(SubmitArgumentDto, { text: '', stance: 'PRO' }))).not.toEqual([]);
    // Главное: «направление» и «сторона» перестали быть только типом.
    expect(await validate(plainToInstance(SubmitArgumentDto, { text: 'ок', stance: 'МОЖЕТ БЫТЬ' }))).not.toEqual([]);
    expect(await validate(plainToInstance(VoteDto, { direction: 'UP' }))).not.toEqual([]);
    expect(await validate(plainToInstance(AddCommentDto, { text: long }))).not.toEqual([]);
    expect(await validate(plainToInstance(AddExperienceDto, { text: long }))).not.toEqual([]);
    expect(await validate(plainToInstance(LibraryVoteDto, { direction: 'вверх' }))).not.toEqual([]);

    // И нормальный ввод проходит — иначе проверка ломала бы саму фичу.
    expect(await validate(plainToInstance(SubmitArgumentDto, { text: 'Разумный довод', stance: 'CON' }))).toEqual([]);
    expect(await validate(plainToInstance(VoteDto, { direction: 'down' }))).toEqual([]);
    expect(await validate(plainToInstance(AddExperienceDto, { text: 'Было так же' }))).toEqual([]);
  });

  it('ИЗМЕРЕНИЕ: сколько поверхностей без гварда и сколько из них принимают запись', () => {
    // Числа живут здесь, чтобы следующая сверка начинала с факта.
    // Рост сам по себе не дефект — дефект, когда он не замечен.
    const scanned = scanUnguarded();
    expect(scanned.length).toBe(15);
    // 32 → 33: пункт [candidate-rights] 2026-09-04 добавил кандидату
    // отзыв согласия по его же токену. Проверка сработала как задумано —
    // новый открытый маршрут не появился незамеченным, а число обновлено
    // осознанно, вместе с записью причины в реестре поверхностей.
    // 2026-09-05: стало 35. Пункт [public-name] добавил участнику
    // публичного обсуждения два маршрута — забрать свой комментарий и
    // свою нерассмотренную заявку. До него у пришедшего по ссылке не было
    // НИ ОДНОГО способа убрать написанное. Число обновлено осознанно,
    // причина записана в реестре поверхностей.
    expect(scanned.reduce((sum, s) => sum + s.openRoutes.length, 0)).toBe(35);
    expect(surfacesAcceptingPublicWrites().length).toBe(4);
  });

  it('ИЗМЕРЕНИЕ: неразмеченные DTO и тела-интерфейсы — почему whitelist нельзя включить глобально', () => {
    // Обоснование в create-app.ts («whitelist:true молча вырезал бы у
    // них ВСЕ поля») подтверждается измерением, а не памятью.
    let total = 0;
    let undecorated = 0;
    for (const file of controllerFiles(SRC)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/class (\w*Dto)\s*\{([\s\S]*?)\n\}/g)) {
        total++;
        if (!/@(Is|Max|Min|Matches|ArrayMaxSize|ValidateNested|Type|Allow)\w*/.test(m[2])) undecorated++;
      }
    }
    expect(total).toBeGreaterThan(200);
    // Больше половины — вот цена включения whitelist одним движением.
    expect(undecorated).toBeGreaterThan(total / 2);
  });
});

/** Контроллеры и сервисы вместе: `data: input` встречается в сервисе, а
 * приходит из контроллера — искать надо в обоих. */
function controllerFilesAndServices(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === '__tests__' ? [] : walk(full);
      return name.endsWith('.service.ts') || name.endsWith('controller.ts') ? [full] : [];
    });
  return walk(SRC);
}

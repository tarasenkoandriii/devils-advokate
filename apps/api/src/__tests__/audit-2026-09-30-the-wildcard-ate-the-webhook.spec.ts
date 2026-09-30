// Пункт [the-wildcard-ate-the-webhook] 2026-09-30 — буквальный путь не
// перехватывается маршрутом с параметром.
//
// НАЙДЕННОЕ, и найдено оно НА ЖИВОМ ДЕПЛОЕ, а не в коде. Публичный
// экран библиотеки разборов отвечал «Не удалось загрузить» всегда.
// Запрос `GET /public/library` попадал в обработчик публичных
// обсуждений (`@Controller('public/:token')`) и получал 404 со словами
// «Ссылка на обсуждение недействительна или обсуждение больше не
// публично доступно» — про обсуждение, которого никто не спрашивал.
// Express подбирает маршрут по ПОРЯДКУ РЕГИСТРАЦИИ, а он идёт в порядке
// массива `imports` в `app.module.ts`: модуль обсуждений стоял выше
// модулей библиотеки и заведений.
//
// Перечисление роутера показало, что дело не в двух путях. Из 705
// маршрутов перехвачено было ЧЕТЫРЕ, и два из них — не экраны, а
// ВЕБХУКИ ПРОВАЙДЕРА РАСШИФРОВКИ:
//
//   POST /sparring-sessions/webhook/voice-reply      ← :sessionId/voice-reply
//   POST /material-chat-sessions/webhook/voice-reply ← :sessionId/voice-reply
//
// Там причина другая и хуже: обработчик вебхука объявлен в ТОМ ЖЕ
// контроллере, ниже маршрута с `:sessionId`. Запрос провайдера попадал
// в защищённый `TelegramAuthGuard` обработчик с `sessionId = 'webhook'`
// — то есть отвергался. Результат расшифровки голосового ответа не
// приходил НИКОГДА. И адрес вебхука продукт формирует сам
// (`sparring.service.ts`), то есть сам называл провайдеру путь, который
// потом сам же и перехватывал.
//
// ПОЧЕМУ ЭТОГО НЕ ВИДЕЛ НИ ОДИН ТЕСТ. Все тесты этих фич вызывают
// МЕТОДЫ контроллера напрямую: `controller.voiceReplyWebhook(payload)`.
// Такой вызов проверяет тело обработчика и не проверяет ровно одно —
// доходит ли до него запрос. Маршрутизация для него невидима по
// построению, ровно как DI-проводка была невидима для юнит-тестов до
// `app-bootstrap.spec.ts`. Это тот же класс дыры и закрывается так же:
// поднятием настоящего приложения.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Не четыре пути поимённо (это было бы «правило
// сторожит ровно то, что уже исправлено»), а ПРАВИЛО на всём роутере:
// для каждого пути без параметров ни один зарегистрированный ВЫШЕ
// маршрут того же метода с параметром не должен этому пути
// соответствовать. Поимённые проверки ниже — сверх правила, потому что
// про эти четыре известно, чем кончается их поломка.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';

/** Заглушка Prisma — та же, что в `app-bootstrap.spec.ts`: тесту нужен
 *  роутер, а не база. `app.init()` при этом исполняется по-настоящему,
 *  и именно он регистрирует маршруты. */
const prismaStub = {
  $connect: async () => undefined,
  $disconnect: async () => undefined,
};

interface Registered {
  order: number;
  method: string;
  path: string;
  matcher: RegExp;
}

async function registeredRoutes(): Promise<{ routes: Registered[]; close: () => Promise<void> }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prismaStub)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  const instance = app.getHttpAdapter().getInstance() as {
    _router?: { stack: unknown[] };
    router?: { stack: unknown[] };
  };
  // Express 4 держит стек в `_router`, Express 5 — в `router`.
  // Проверяются оба, иначе обновление Express превратило бы сверку в
  // «ноль маршрутов — значит нарушений нет».
  const stack = (instance._router?.stack ?? instance.router?.stack ?? []) as Array<{
    route?: { path: string; methods: Record<string, boolean> };
    regexp?: RegExp;
  }>;
  const routes: Registered[] = [];
  stack.forEach((layer, order) => {
    if (!layer.route || !layer.regexp) return;
    const method = Object.keys(layer.route.methods)[0]?.toUpperCase() ?? 'GET';
    routes.push({ order, method, path: layer.route.path, matcher: layer.regexp });
  });
  return { routes, close: () => app.close() };
}

/** Буквальные пути, перехваченные маршрутом с параметром, стоящим ВЫШЕ. */
function shadowed(routes: Registered[]): string[] {
  const found: string[] = [];
  for (const route of routes) {
    if (route.path.includes(':')) continue;
    for (const earlier of routes) {
      if (earlier.order >= route.order) break;
      if (earlier.method !== route.method) continue;
      if (!earlier.path.includes(':')) continue;
      if (earlier.matcher.test(route.path)) {
        found.push(`${route.method} ${route.path} ← ${earlier.path}`);
        break;
      }
    }
  }
  return found;
}


// ─────────────────────────────────────────────────────────────────────
// ЗЕРКАЛЬНОЕ ПРАВИЛО, измерено тем же поднятым приложением.
//
// Перехват — это «запрос дошёл не туда». Обратная беда — «запрос не
// дошёл никуда»: экран зовёт путь, которого на сервере нет. Найти это
// можно только сверив ОБЕ стороны, и до сих пор в проекте такой сверки
// не было: клиентские тесты проверяют, какой URL собрала функция,
// серверные — что делает обработчик, а совпадают ли они, не проверял
// никто.
//
// Замер на 2026-09-30: 359 уникальных путей у двух клиентов против 705
// зарегистрированных маршрутов — несовпадений НЕТ. Правило оставлено
// не ради находки, а ради переименования: путь, переименованный на
// сервере, иначе обнаружит человек, у которого «кнопка не работает».
// ─────────────────────────────────────────────────────────────────────

const MONOREPO = join(__dirname, '..', '..', '..', '..');

function clientFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules' && name !== '.next' && name !== '__tests__') out.push(...clientFiles(p));
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

/** Толкования одного пути — или `null`, если путь этим разбором не
 *  читается.
 *
 *  Вынесено отдельной функцией НАМЕРЕННО: на ней стои́т проба ниже.
 *  Мутация «перестать пересчитывать нечитаемые вызовы» пережила первую
 *  версию правила — потому что пустой список нечитаемых выглядел так же,
 *  как отсутствие нечитаемых. Проверять надо МЕХАНИЗМ распознавания, а
 *  не только итоговое число. */
function classifyRawPath(raw: string): string[] | null {
  // Незакрытая подстановка = захват оборвался на вложенном шаблоне
  // (`` `/x${q ? `?${q}` : ''}` ``). Такой путь не прочитать.
  const opens = (raw.match(/\$\{/g) ?? []).length;
  const closes = (raw.match(/\}/g) ?? []).length;
  if (opens !== closes) return null;
  // Подстановки снимаются первыми, запрос отрезается вторым.
  //
  // ОГОВОРКА, добавленная после мутации, которая этот порядок поменяла
  // и СВЕРКУ НЕ УРОНИЛА. Порядок важен только там, где `?` стои́т
  // ВНУТРИ подстановки, а такие строки сюда не доходят вовсе — они
  // отсекаются выше как нечитаемые. Для читаемых путей оба порядка
  // дают одно и то же, и первая версия этого комментария утверждала
  // больше, чем делает код. Порядок оставлен (он верен по смыслу), а
  // утверждение исправлено: правило здесь — «подстановка и запрос
  // снимаются оба», а не «непременно в этом порядке».
  const asSegment = raw.replace(/\$\{[^}]*\}/g, 'X').split('?')[0].replace(/\/+$/, '') || '/';
  const asEmpty = raw.replace(/\$\{[^}]*\}/g, '').split('?')[0].replace(/\/+$/, '') || '/';
  return [...new Set([asSegment, asEmpty])];
}

/** Пути, которые строят клиенты: `apiGet('/x')`, `apiPost(`/y/${id}`)`.
 *
 *  ЧТО ЭТОТ РАЗБОР ВИДЕТЬ НЕ МОЖЕТ, и это сказано вслух, а не обойдено
 *  молчанием. Вызов, у которого внутри подстановки лежит СВОЙ шаблон
 *  (`` `/admin/users${qs ? `?${qs}` : ''}` ``), регулярным выражением не
 *  читается: захват обрывается на вложенной обратной кавычке, и от пути
 *  остаётся огрызок. Первые две версии этой сверки сообщали про такие
 *  огрызки как про «несуществующие маршруты» — то есть находили
 *  собственную неспособность их прочесть.
 *
 *  Поэтому нечитаемые вызовы НЕ проверяются, а ПЕРЕСЧИТЫВАЮТСЯ: их
 *  число проверяется отдельно и ограничено. Правило, которое молча
 *  выбрасывает то, чего не понимает, со временем перестаёт смотреть на
 *  что-либо вовсе — а названный и ограниченный пробел остаётся
 *  пробелом, а не полнотой. */
function clientPaths(): {
  readable: Array<{ file: string; raw: string; candidates: string[] }>;
  unreadable: string[];
  /** Сколько вызовов вообще найдено — до всякой классификации. Нужен для
   *  закона сохранения ниже: прочитанные плюс нечитаемые обязаны дать
   *  ровно его. Мутация «перестать пересчитывать нечитаемые» иначе
   *  проходит насквозь, потому что пустой список нечитаемых выглядит как
   *  их отсутствие. */
  attempted: number;
} {
  const readable: Array<{ file: string; raw: string; candidates: string[] }> = [];
  const unreadable: string[] = [];
  let attempted = 0;
  for (const app of ['tma', 'admin']) {
    for (const file of clientFiles(join(MONOREPO, 'apps', app, 'src'))) {
      const src = readFileSync(file, 'utf8');
      const pattern = /api(?:Get|Post|Put|Patch|Delete)\s*(?:<[^>]*>)?\s*\(\s*[`'"]([^`'"]+)[`'"]/g;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(src)) !== null) {
        const raw = m[1];
        if (!raw.startsWith('/')) continue;
        attempted++;
        const where = `${raw} (${file.slice(MONOREPO.length + 1)})`;
        const verdict = classifyRawPath(raw);
        if (!verdict) { unreadable.push(where); continue; }
        readable.push({ file: file.slice(MONOREPO.length + 1), raw, candidates: verdict });
      }
    }
  }
  return { readable, unreadable, attempted };
}

describe('Пункт [the-wildcard-ate-the-webhook]: до обработчика доходит именно его запрос', () => {
  jest.setTimeout(120_000);

  let routes: Registered[];
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ routes, close } = await registeredRoutes());
  });

  afterAll(async () => {
    if (close) await close();
  });

  it('выборка непустая: роутер действительно прочитан', () => {
    // Сверка, которой не на что смотреть, зеленеет и ничего не значит.
    // Здесь это особенно легко: сменится внутреннее поле Express — и
    // «нарушений нет» станет означать «маршрутов не видно».
    expect(routes.length).toBeGreaterThan(500);
    expect(routes.some((r) => r.path.includes(':'))).toBe(true);
    expect(routes.some((r) => !r.path.includes(':'))).toBe(true);
  });

  it('КЛЮЧЕВОЕ ПРАВИЛО: ни один буквальный путь не перехвачен маршрутом с параметром', () => {
    expect(shadowed(routes)).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: вебхуки расшифровки зарегистрированы ВЫШЕ своих `:sessionId`', () => {
    // Про эти два известно, чем кончается поломка: результат расшифровки
    // голосового ответа не приходит никогда, а разговор остаётся ждать.
    for (const prefix of ['sparring-sessions', 'material-chat-sessions']) {
      const hook = routes.find((r) => r.method === 'POST' && r.path === `/${prefix}/webhook/voice-reply`);
      const byId = routes.find((r) => r.method === 'POST' && r.path === `/${prefix}/:sessionId/voice-reply`);
      expect(hook).toBeDefined();
      expect(byId).toBeDefined();
      expect(hook!.order).toBeLessThan(byId!.order);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: публичные экраны не перехвачены маршрутом обсуждений', () => {
    const token = routes.find((r) => r.method === 'GET' && r.path === '/public/:token');
    expect(token).toBeDefined();
    for (const literal of ['/public/library', '/public/venues']) {
      const own = routes.find((r) => r.method === 'GET' && r.path === literal);
      expect(own).toBeDefined();
      expect(own!.order).toBeLessThan(token!.order);
    }
  });

  it('обратная проба: сам разбор находит перехват в подложенном порядке', () => {
    // Иначе «нарушений нет» может означать, что разбор не умеет их
    // находить вовсе. Порядок здесь задан руками: параметр выше
    // буквального.
    const fake: Registered[] = [
      { order: 0, method: 'GET', path: '/public/:token', matcher: /^\/public\/(?:([^/]+?))\/?$/i },
      { order: 1, method: 'GET', path: '/public/library', matcher: /^\/public\/library\/?$/i },
    ];
    expect(shadowed(fake)).toEqual(['GET /public/library ← /public/:token']);
  });

  it('обратная проба: обратный порядок нарушением не считается, и метод учитывается', () => {
    const ordered: Registered[] = [
      { order: 0, method: 'GET', path: '/public/library', matcher: /^\/public\/library\/?$/i },
      { order: 1, method: 'GET', path: '/public/:token', matcher: /^\/public\/(?:([^/]+?))\/?$/i },
    ];
    expect(shadowed(ordered)).toEqual([]);
    // Разные методы не перехватывают друг друга: POST :token не мешает
    // GET library, и правило не должно выдумывать нарушение.
    const otherMethod: Registered[] = [
      { order: 0, method: 'POST', path: '/public/:token', matcher: /^\/public\/(?:([^/]+?))\/?$/i },
      { order: 1, method: 'GET', path: '/public/library', matcher: /^\/public\/library\/?$/i },
    ];
    expect(shadowed(otherMethod)).toEqual([]);
  });


  it('ЗЕРКАЛЬНОЕ ПРАВИЛО: каждый путь, который зовёт клиент, обслуживается маршрутом', () => {
    const { readable, unreadable, attempted } = clientPaths();
    // ЗАКОН СОХРАНЕНИЯ: ни один найденный вызов не исчезает по дороге.
    // Он и держит честность пробела: перестать пересчитывать
    // нечитаемые теперь нельзя — сумма разойдётся.
    expect(readable.length + unreadable.length).toBe(attempted);
    // Выборка непустая и большая: если разбор перестанет находить
    // вызовы, «несовпадений нет» будет означать «смотреть не на что».
    expect(readable.length).toBeGreaterThan(300);
    const unserved = readable
      .filter((c) => !c.candidates.some((probe) => routes.some((r) => r.matcher.test(probe))))
      .map((c) => `${c.raw} (${c.file})`);
    expect([...new Set(unserved)]).toEqual([]);
    // И пробел назван числом: вызовы с вложенным шаблоном этим разбором
    // не читаются. Их мало и их рост заметен — правило не должно тихо
    // переставать смотреть.
    expect(unreadable.length).toBeLessThanOrEqual(5);
  });

  it('обратная проба: вызов с вложенным шаблоном опознаётся как НЕчитаемый, а обычный — как читаемый', () => {
    // Мутация «не пересчитывать нечитаемые» пережила первую версию
    // правила: пустой список нечитаемых неотличим от их отсутствия.
    // Поэтому проверяется сам механизм — на подложенных строках, а не
    // на состоянии репозитория, которое может измениться законно.
    expect(classifyRawPath("/admin/users${qs ? ")).toBeNull();
    expect(classifyRawPath('/admin/users${qs}')).toEqual(['/admin/usersX', '/admin/users']);
    expect(classifyRawPath('/healthz')).toEqual(['/healthz']);
    // И запрос внутри подстановки не рвёт путь надвое.
    expect(classifyRawPath('/admin/users${suffix}')![1]).toBe('/admin/users');
  });

  it('обратная проба: выдуманный путь сверка считает необслуженным', () => {
    // Иначе зелёное зеркальное правило ничего не значит.
    const invented = '/zz-no-such-endpoint-for-the-probe';
    expect(routes.some((r) => r.matcher.test(invented))).toBe(false);
    // И на настоящем пути та же машинерия говорит «обслужен».
    expect(routes.some((r) => r.matcher.test('/healthz'))).toBe(true);
  });

  it('адрес вебхука, который продукт отдаёт провайдеру, совпадает с зарегистрированным путём', () => {
    // Половина дефекта была в том, что продукт САМ называл провайдеру
    // путь, который потом сам же и перехватывал. Значит сверять надо не
    // только порядок, но и совпадение двух половин.
    const registered = routes
      .filter((r) => r.method === 'POST' && r.path.endsWith('/webhook/voice-reply'))
      .map((r) => r.path);
    expect(registered.sort()).toEqual(['/material-chat-sessions/webhook/voice-reply', '/sparring-sessions/webhook/voice-reply']);
  });
});

// Пункт [gate-locked-the-public-door] 2026-09-26 — рисуется САМ ШЛЮЗ.
//
// Утверждение пункта — «публичная страница открывается, когда проверки
// дисклеймера падают». Это утверждение о поведении `AppGate` в
// конкретных условиях, и проверять его чистой функцией `isPublicRoute`
// было бы той самой ошибкой, которую проект уже называл: правило
// проверено, а МЕСТО ЕГО ПРИМЕНЕНИЯ — нет. Мутация «перестать звать
// правило в шлюзе» такую проверку пережила бы.
//
// Поэтому `next/navigation` и `lib/features` подменяются в `require`,
// а шлюз рисуется настоящий. Подмена стоит ДО его загрузки: иначе он
// успеет захватить настоящие модули.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { NOT_PUBLIC_LITERALS, PUBLIC_ROUTES, isPublicRoute } from '../lib/public-routes';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const state: { path: string; disclaimer: () => Promise<{ acknowledged: boolean }> } = {
  path: '/',
  disclaimer: () => Promise.reject(new Error('Telegram WebApp недоступен')),
};

function stub(resolved: string, exports: Record<string, unknown>) {
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as never;
}

stub(require.resolve('next/navigation', { paths: [join(__dirname, '..', '..')] }), {
  usePathname: () => state.path,
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
});
stub(require.resolve('../lib/features'), { getDisclaimerStatus: () => state.disclaimer() });

const { AppGate, checkDisclaimer } = require('../components/AppGate') as {
  AppGate: (p: { children: unknown }) => unknown;
  checkDisclaimer: (
    publicPage: boolean,
    setState: (s: string) => void,
    setError: (e: string) => void,
    fetchStatus?: () => Promise<{ acknowledged: boolean }>,
  ) => Promise<void>;
};

const PAGE_TEXT = 'СОДЕРЖИМОЕ-СТРАНИЦЫ';

function gateAt(path: string): string {
  state.path = path;
  return renderToStaticMarkup(
    createElement(AppGate as never, null, createElement('p', null, PAGE_TEXT)) as never,
  );
}

const APP = join(__dirname, '..', 'app');

/** Все маршруты приложения — по файлам `page.tsx`. */
function allRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}/${name}`);
      else if (name === 'page.tsx') out.push(prefix || '/');
    }
  };
  walk(APP, '');
  return out;
}

/** Страницы, чьи ДАННЫЕ приходят публичным клиентом. */
function pagesUsingPublicApi(): string[] {
  return allRoutes().filter((route) => {
    const file = join(APP, route === '/' ? '' : route, 'page.tsx');
    return readFileSync(file, 'utf8').includes("lib/public-api");
  });
}

const scenarios: Array<[string, () => void | Promise<void>]> = [
  ['проба механизма: подменённый шлюз рисуется и видит подменённый путь', () => {
    // Без этого всё ниже могло бы «проходить», рисуя пустоту.
    const html = gateAt('/projects');
    assert(html.length > 0, 'шлюз нарисовал пустоту — остальные проверки ничего не значат');
    assert(PUBLIC_ROUTES.length === 7, `публичных маршрутов в реестре ${PUBLIC_ROUTES.length}`);
    assert(allRoutes().length >= 20, `маршрутов приложения найдено ${allRoutes().length}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: публичная страница открывается, хотя проверка дисклеймера падает', () => {
    // Именно так это и выглядело у человека: вне Telegram
    // `getAuthHeaders()` не отдаёт 401, а БРОСАЕТ.
    for (const { route } of PUBLIC_ROUTES) {
      const path = route.replace(/\[[^\]]+\]/g, 'abc123');
      const html = gateAt(path);
      assert(html.includes(PAGE_TEXT), `публичная страница не открылась: ${path} → ${html}`);
      assert(!html.includes('Не удалось загрузить'), `на публичной странице ошибка шлюза: ${path}`);
    }
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: приватная страница по-прежнему за шлюзом', () => {
    // Дисклеймер проверяется в layout'е именно потому, что прямой заход
    // по закладке обходил проверку на главной. Это не должно сломаться.
    for (const path of ['/', '/projects', '/projects/p-1', '/projects/p-1/card', '/privacy', '/settings', '/venues/apply']) {
      const html = gateAt(path);
      assert(!html.includes(PAGE_TEXT), `приватная страница отрисовалась мимо шлюза: ${path}`);
    }
  }],

  ['обратная проба: и при УСПЕШНОЙ проверке приватная страница ждёт, а не открывается сразу', () => {
    // Иначе предыдущий тест проходил бы просто потому, что заглушка
    // всегда падает, а не потому, что шлюз держит страницу.
    state.disclaimer = () => Promise.resolve({ acknowledged: true });
    const html = gateAt('/projects');
    assert(!html.includes(PAGE_TEXT), 'приватная страница отрисовалась до проверки');
    assert(html.includes('Загрузка'), `вместо ожидания шлюз показал: ${html}`);
    state.disclaimer = () => Promise.reject(new Error('Telegram WebApp недоступен'));
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: на публичной странице авторизованный запрос не делается вовсе', () => {
    // Мутация «убрать пропуск из эффекта» пережила первую версию: эффект
    // в статическом рендере не запускается, а страница всё равно
    // рисовалась коротким замыканием. Пропуск при этом не украшение —
    // вне Telegram `getAuthHeaders()` бросает СИНХРОННО, и без него на
    // каждой публичной странице возникала бы необработанная ошибка.
    let calls = 0;
    const fetchStatus = () => {
      calls += 1;
      return Promise.resolve({ acknowledged: true });
    };
    void checkDisclaimer(true, () => undefined, () => undefined, fetchStatus);
    assert(calls === 0, 'на публичной странице всё равно запрошен статус дисклеймера');
    // Обратная проба: на приватной — запрашивается, иначе проверка
    // проходила бы от того, что заглушку вообще никто не зовёт.
    void checkDisclaimer(false, () => undefined, () => undefined, fetchStatus);
    assert(calls === 1, 'на приватной странице статус дисклеймера не запрошен');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: непринятый дисклеймер по-прежнему блокирует приложение', () => {
    // Строка «принят → open, не принят → blocked» существовала до этого
    // пункта и не была покрыта ничем: мутация «всегда open» проходила
    // насквозь. Я перенёс её в отдельную функцию — значит она теперь
    // моя, и оставить её непокрытой было бы тише, чем честно.
    const seen: string[] = [];
    void checkDisclaimer(false, (st) => seen.push(st), () => undefined, () => Promise.resolve({ acknowledged: false }));
    void checkDisclaimer(false, (st) => seen.push(st), () => undefined, () => Promise.resolve({ acknowledged: true }));
    // И сбой проверки закрывает, а не открывает: шлюз обязан падать
    // закрытым. Иначе достаточно уронить один запрос, чтобы приложение
    // открылось без дисклеймера.
    void checkDisclaimer(false, (st) => seen.push(st), () => undefined, () => Promise.reject(new Error('сеть')));
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert(seen[0] === 'blocked', `непринятый дисклеймер не заблокировал приложение: ${seen[0]}`);
        assert(seen[1] === 'open', `принятый дисклеймер не открыл приложение: ${seen[1]}`);
        assert(seen[2] === 'error', `сбой проверки выдан за успех: ${seen[2]}`);
        resolve();
      }, 0);
    }) as unknown as void;
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: соседнее имя не проходит за публичное', () => {
    // `startsWith` пустил бы `/library-admin` как `/library`, и шлюз
    // открыл бы то, чего не открывал.
    for (const path of ['/library-admin', '/venues-internal', '/public', '/public/abc/edit', '/librarysomething']) {
      assert(!isPublicRoute(path), `соседний путь признан публичным: ${path}`);
      assert(!gateAt(path).includes(PAGE_TEXT), `соседний путь открылся мимо шлюза: ${path}`);
    }
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: каждая страница на публичном клиенте — в реестре', () => {
    // Реестр не должен отставать от кода: новая публичная страница,
    // забытая здесь, снова упрётся в шлюз и снова покажет ошибку.
    // `/projects/[id]` и `/public/[token]` обе тянут публичный клиент —
    // первая через раздел обсуждения внутри своего проекта, — поэтому
    // смотрим ИМПОРТЫ САМОЙ страницы, а не её компонентов.
    const registered = new Set(PUBLIC_ROUTES.map((r) => r.route));
    const missing = pagesUsingPublicApi().filter((r) => !registered.has(r));
    assert(missing.length === 0, `страницы на публичном клиенте вне реестра: ${missing.join(', ')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: буквальная страница под публичным шаблоном названа поимённо', () => {
    // Next.js отдаёт статическому сегменту приоритет над динамическим.
    // `/venues/apply` подошла под `/venues/[id]` и была признана
    // публичной — поймано собственной проверкой приватных маршрутов.
    // Здесь список сверяется с настоящими страницами: новая такая
    // страница не может появиться молча.
    const registered = new Set(PUBLIC_ROUTES.map((r) => r.route));
    const shadowed = allRoutes().filter(
      (r) => !registered.has(r) && !r.includes('[') && PUBLIC_ROUTES.some(({ route }) => {
        const pat = route.split('/').filter(Boolean);
        const parts = r.split('/').filter(Boolean);
        return pat.length === parts.length && pat.every((seg, i) => seg.startsWith('[') || seg === parts[i]);
      }),
    );
    const forgotten = shadowed.filter((r) => !NOT_PUBLIC_LITERALS.includes(r));
    assert(forgotten.length === 0, `буквальные страницы под публичным шаблоном, не названные приватными: ${forgotten.join(', ')}`);
    // И обратно: список не держит того, чего нет или что и так публично.
    const stale = NOT_PUBLIC_LITERALS.filter((r) => !shadowed.includes(r));
    assert(stale.length === 0, `в списке приватных буквальных страниц лишнее: ${stale.join(', ')}`);
  }],

  ['в реестре нет маршрутов, которых в приложении не существует', () => {
    const exists = new Set(allRoutes());
    const ghosts = PUBLIC_ROUTES.map((r) => r.route).filter((r) => !exists.has(r));
    assert(ghosts.length === 0, `реестр называет несуществующие страницы: ${ghosts.join(', ')}`);
  }],

  ['у каждого публичного маршрута записан довод, а не отметка', () => {
    for (const r of PUBLIC_ROUTES) {
      assert(r.why.length > 40, `довод для ${r.route} слишком короток: «${r.why}»`);
    }
  }],
];

void (async () => {
  let failed = 0;
  for (const [name, fn] of scenarios) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`✗ ${name}: ${(e as Error).message}`);
    }
  }
  if (failed > 0) process.exit(1);
})();

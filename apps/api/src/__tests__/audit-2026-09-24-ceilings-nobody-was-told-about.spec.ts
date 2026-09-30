// Пункт [ceilings-nobody-was-told-about] 2026-09-24 — потолки расходов,
// о которых владельцу не сказали.
//
// ЧТО ПРОВЕРЯЕТСЯ И ПОЧЕМУ ИМЕННО ТАК. Обещание в VERCEL.md было:
// «список сверен со `apps/api/.env.example` автоматически». Сверка
// существовала и сравнивала ДОКУМЕНТ С ДОКУМЕНТОМ — переменная,
// прочитанная из `process.env` и не записанная в `.env.example`,
// невидима для обеих её сторон. Здесь сверка идёт с КОДОМ: что код
// читает, то и обязано быть объявлено.

import * as fs from 'fs';
import * as path from 'path';
import { SPEND_LIMITS, limitFrom, spendLimit } from '../common/spend-limits';
import { PUBLIC_WRITE_LIMITS } from '../common/public-write-limits';

const REPO = path.join(__dirname, '..', '..', '..', '..');
const APPS = ['api', 'tma', 'admin', 'landing'];

/** Переменные, которые объявлять в `.env.example` НЕ НАДО, с причиной.
 * Список короткий намеренно: каждая строчка здесь — дырка в правиле. */
const PLATFORM_PROVIDED: Array<{ name: string; why: string }> = [
  { name: 'NODE_ENV', why: 'выставляет сборщик (Next.js/Nest), значение в .env.example только сбивало бы с толку' },
  { name: 'PORT', why: 'выставляет платформа (Vercel/локальный запуск), продукт лишь читает' },
  // Пункт [green-deploy-pointed-at-localhost] 2026-09-30: обе появились
  // как ПРИЗНАК ПЛАТФОРМЫ — по ним мини-приложение и админка отличают
  // сборку, которая уедет людям, от локальной, где дефолт разработки
  // уместен. Объявлять их в `.env.example` нельзя именно потому, что
  // объявление означало бы «оператор их выставляет»: выставленная руками
  // VERCEL=1 в локальном окружении уронила бы локальную сборку.
  { name: 'VERCEL', why: 'выставляет платформа на всех своих сборках; признак «этот бандл уедет людям», руками не задаётся' },
  { name: 'VERCEL_ENV', why: 'выставляет платформа (production/preview/development); тот же признак, что VERCEL, для превью' },
];

function readEnvNames(dir: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__' && e.name !== 'node_modules' && e.name !== '.next') walk(p);
      } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/process\.env\.([A-Z_0-9]+)/g)) {
          const list = found.get(m[1]) ?? [];
          list.push(p);
          found.set(m[1], list);
        }
      }
    }
  };
  walk(dir);
  return found;
}

function declaredNames(file: string): Set<string> {
  if (!fs.existsSync(file)) return new Set();
  const names = new Set<string>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*#?\s*([A-Z_0-9]+)\s*=/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

describe('[ceilings-nobody-was-told-about] о потолках расходов сказано там, где их выставляют', () => {
  /** Что правило обязано проверить у приложения. Отдельной функцией —
   * чтобы её ПОКРЫТИЕ само было предметом проверки: мутация «убрать
   * реестр из объединения» иначе проходит насквозь, потому что
   * переменные-то объявлены, и правило просто начинает смотреть меньше.
   * Меньше — это и есть дефект. */
  function namesToCheck(app: string): Set<string> {
    const used = new Set(readEnvNames(path.join(REPO, 'apps', app, 'src')).keys());
    // Потолки читаются через общий разбор (`process.env[env]`), и по
    // тексту исходника их имён не видно.
    if (app === 'api') for (const l of SPEND_LIMITS) if (l.env) used.add(l.env);
    /** ВТОРОЙ РЕЕСТР ДОБАВЛЕН 2026-09-30, Пункт
     * [the-guard-missed-the-second-registry] — и это ДОСЛОВНОЕ
     * повторение того дефекта, ради которого писан этот файл.
     *
     * `PUBLIC_WRITE_LIMITS` появился Пунктом
     * [the-open-door-had-no-counter] и читает свои шесть переменных
     * тем же `process.env[env]` через `resolveLimit`. В объединение
     * выше он не попал — а по тексту исходника этих имён не видно,
     * ровно как и имён `SPEND_LIMITS`. То есть все шесть были
     * невидимы для обеих сторон сверки, и при этом экран потолков в
     * админке печатает их оператору по имени
     * («`PUBLIC_COMMENTS_PER_DISCUSSION` не задана»), а найти это имя
     * в документах было негде.
     *
     * Урок, который стоит записать рядом: правило «что код читает, то
     * и объявлено» держится не само — его держит ПОЛНОТА ОБЪЕДИНЕНИЯ.
     * Каждый новый реестр потолков обязан быть дописан сюда, иначе
     * правило начинает смотреть меньше, оставаясь зелёным. */
    if (app === 'api') for (const l of PUBLIC_WRITE_LIMITS) if (l.env) used.add(l.env);
    return used;
  }

  it('КЛЮЧЕВОЙ ТЕСТ: правило смотрит и на переменные, читаемые через реестр', () => {
    // Утверждение — о МНОЖЕСТВАХ, а не о тексте: какие имена правило
    // вообще берёт в рассмотрение. Записано равенством множеств, а не
    // перебором `toContain`, потому что так оно и формулируется; мера
    // «проверок по тексту исходника» при этом считает файл целиком, и
    // подгонять под неё формулировку смысла нет — тест от этого не
    // становится слабее и не становится сильнее.
    const checked = namesToCheck('api');
    const registry = [...SPEND_LIMITS, ...PUBLIC_WRITE_LIMITS]
      .map((l) => l.env)
      .filter((e): e is string => e !== null && e !== undefined);
    expect(registry.filter((e) => checked.has(e)).sort()).toEqual([...registry].sort());
  });

  it('КЛЮЧЕВОЙ ТЕСТ: всё, что код читает из окружения, объявлено в .env.example своего приложения', () => {
    const excused = new Set(PLATFORM_PROVIDED.map((p) => p.name));
    const missing: string[] = [];
    for (const app of APPS) {
      const used = namesToCheck(app);
      const declared = declaredNames(path.join(REPO, 'apps', app, '.env.example'));
      for (const name of used) {
        if (excused.has(name) || declared.has(name)) continue;
        missing.push(`${app}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('ОБРАТНАЯ ПРОБА: разбор действительно находит переменные, а не пустоту', () => {
    // Без этого пустой список выше означал бы не порядок, а сломанный
    // разбор — ошибка, на которой этот ряд сверок себя уже ловил.
    const used = readEnvNames(path.join(REPO, 'apps', 'api', 'src'));
    expect(used.size).toBeGreaterThan(3);
    // И сами реестры не пусты — иначе объединение выше ничего бы не
    // добавило. ОБА, а не один: пустой второй реестр вернул бы правило
    // в то состояние, в котором его застал Пункт
    // [the-guard-missed-the-second-registry].
    expect(SPEND_LIMITS.filter((l) => l.env).length).toBeGreaterThan(5);
    expect(PUBLIC_WRITE_LIMITS.filter((l) => l.env).length).toBeGreaterThan(5);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: потолки расходов названы в таблице деплоя, а не только в коде', () => {
    const vercel = fs.readFileSync(path.join(REPO, 'VERCEL.md'), 'utf8');
    // Оба реестра: потолки публичной записи оператор выставляет в той
    // же панели и по той же таблице.
    const unnamed = [...SPEND_LIMITS, ...PUBLIC_WRITE_LIMITS]
      .filter((l) => l.env && !vercel.includes(l.env))
      .map((l) => l.env);
    expect(unnamed).toEqual([]);
  });

  it('каждая настраиваемая переменная читается через общий разбор и попадает в реестр', () => {
    for (const limit of SPEND_LIMITS) {
      if (!limit.env) continue;
      expect(spendLimit(limit.env)).toBe(limit.fallback); // в тестовом окружении переменных нет
      expect(limit.costs.length).toBeGreaterThan(25);
      expect(limit.what.length).toBeGreaterThan(20);
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: неверное значение падает на умолчание, а не снимает потолок', () => {
    // Раньше разборов было пять и отличались они мелочами: где-то
    // `> 0`, где-то `>= 0`, где-то `?? '300'`. Мелочи и разъезжаются.
    const saved = process.env.TEST_LIMIT_PROBE;
    const cases: Array<[string | undefined, number]> = [
      [undefined, 42],
      ['', 42],
      ['не число', 42],
      ['-5', 42],
      ['0', 0], // явное отключение потолка — не умолчание
      ['7', 7],
      ['7.9', 7], // дробное усекается, а не округляется вверх
    ];
    for (const [value, expected] of cases) {
      if (value === undefined) delete process.env.TEST_LIMIT_PROBE;
      else process.env.TEST_LIMIT_PROBE = value;
      expect(limitFrom('TEST_LIMIT_PROBE', 42)).toBe(expected);
    }
    if (saved === undefined) delete process.env.TEST_LIMIT_PROBE;
    else process.env.TEST_LIMIT_PROBE = saved;
  });

  it('КЛЮЧЕВОЙ ТЕСТ: опечатка в имени потолка падает громко, а не означает «без потолка»', () => {
    // Молчаливый ноль здесь был бы худшим из возможных поведений:
    // потолок исчезает, и никто не узнаёт.
    expect(() => spendLimit('AI_CALLS_PER_USER_PER_DEY')).toThrow(/не описан/);
    expect(spendLimit('AI_CALLS_PER_USER_PER_DAY')).toBeGreaterThan(0);
  });

  it('у каждого исключения из правила записана причина', () => {
    for (const p of PLATFORM_PROVIDED) expect(p.why.length).toBeGreaterThan(30);
    // Потолок был 3 при двух записях — то есть ровно один запас, и это
    // сделано намеренно: список исключений не должен расти молча.
    // Поднят до 4 Пунктом [green-deploy-pointed-at-localhost]
    // 2026-09-30, когда добавились `VERCEL` и `VERCEL_ENV`. Это ОДИН
    // признак («бандл уедет людям»), записанный двумя именами платформы,
    // а не два независимых исключения, — поэтому запас снова один, а не
    // два. Поднимать потолок ради очередной записи можно только так:
    // назвав Пункт и причину здесь же, иначе проверка превращается в
    // формальность, которую обходят цифрой.
    expect(PLATFORM_PROVIDED.length).toBeLessThanOrEqual(4);
    // И обратная сторона: обе новые записи — действительно платформенные
    // имена, а не переменные продукта, спрятанные в список исключений.
    const platformNames = PLATFORM_PROVIDED.filter((p) => p.name.startsWith('VERCEL')).map((p) => p.name);
    expect(platformNames.sort()).toEqual(['VERCEL', 'VERCEL_ENV']);
  });

  // Проверки, которым файлы не нужны (сам реестр), живут в
  // `…-spend-limits.spec.ts`: мера «проверок по тексту исходника»
  // считает файл целиком, и держать их здесь значило бы записывать в
  // текстовые утверждения то, что к тексту отношения не имеет.
});

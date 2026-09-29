// Аудит 2026-09-03 — «сбой не должен выглядеть как пустота», как тест.
//
// У продукта есть прямое обещание: конфигурационные и технические пробелы
// не выдаются за отсутствие находок. На фронтенде это обещание нарушается
// одной строкой — `.catch(() => setX([]))`: секция получает пустой список,
// рисует «ничего не найдено» (или не рисуется вовсе), и человек читает нашу
// аварию как факт о своём деле. Сверка нашла десять таких мест, включая
// хронологию конфликта, сводку открытых вопросов и юридические ориентиры
// домена — то есть ровно те секции, молчание которых успокаивает.
//
// Тест держит именно это, не стиль: если файл гасит ошибку загрузки в
// пустое состояние, он обязан иметь признак сбоя — состояние `failed`/
// `error`, SectionLoadError или AiErrorNotice. Проверка текстом файла, как
// schema-conventions.spec.ts на бэкенде: дешёвая защита ровно от того
// класса регрессии, который уже случался.
//
// Раннер здесь «свой» (без describe/it) сознательно: в TMA jest не
// настроен, и describe-спек не запускался бы вовсе — сам по себе тот же
// класс дефекта, что этот файл и проверяет.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['components', 'app'].map((d) => join(__dirname, '..', d));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const SHOWS_FAILURE = /setFailed\(|setError\(|SectionLoadError|AiErrorNotice|generation-error/;
const SWALLOWS = /\.catch\(\(\)\s*=>\s*set\w+\(/;

// ── Пункт [false-success] 2026-09-04 ──
//
// У проверки выше ДВЕ дыры, и обе — тот же урок [guard-audit]: правило
// уровня ФАЙЛА о свойстве уровня ОПЕРАТОРА.
//   1. `SWALLOWS` ловит только `.catch(() => setX(...))`; форму
//      `try { … } catch { … }` она не видит вовсе.
//   2. `SHOWS_FAILURE` проверяется ПО ФАЙЛУ: если где-то в файле есть
//      `setError(`, то ЛЮБОЙ молчащий catch в нём прощён.
// Из-за этого мимо прошли два места на самой открытой странице продукта —
// публичном обсуждении, которое открывает кто угодно по ссылке: сбой
// присоединения ВЫДАВАЛСЯ ЗА УСПЕХ (`setJoined(true)` в обработчике
// ошибки), а потерянный голос не объяснялся никак.
//
// Ниже — разбор по каждому catch отдельно. Молчать по-прежнему можно, но
// теперь это осознанное решение: в теле обязана быть НАПИСАННАЯ ПРИЧИНА
// (комментарий). Проект и так пишет их почти везде — «тихий сбой цикла не
// должен ломать саму сессию», — правило лишь требует того же от новых
// мест.

/** Комментарии прочь перед разбором КОДА. За эту сессию проверка ловила
 * собственный текст в комментарии трижды: здесь она объявила «сбой выдан
 * за успех» на месте, где `setJoined(true)` упоминается в объяснении
 * того, как было РАНЬШЕ. Ошибка разбора, выданная за находку, — ровно
 * то, чего эти сверки делать не должны. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Тела всех `catch` в файле: и оператор, и `.catch(...)`.
 *
 * Принимает ИСХОДНЫЙ текст: код в теле разбирается со снятыми
 * комментариями, а причина молчания ищется в исходном — иначе проверка
 * либо примет комментарий за код, либо не увидит объяснение. */
function catchBodies(source: string): Array<{ line: number; body: string; raw: string }> {
  const out: Array<{ line: number; body: string; raw: string }> = [];
  /** Тело в фигурных скобках от позиции открывающей скобки. */
  const braced = (open: number): string => {
    let depth = 0;
    for (let j = open; j < source.length; j++) {
      if (source[j] === '{') depth++;
      else if (source[j] === '}') {
        depth--;
        if (depth === 0) return source.slice(open + 1, j);
      }
    }
    return source.slice(open + 1);
  };
  /** Причина может стоять НАД обработчиком, а не внутри — так в проекте
   * написано чаще. Первая версия смотрела только внутрь и объявила
   * молчащими места с объяснением строкой выше: ошибка разбора, снова
   * едва не выданная за находку. Окно в девять строк, а не в одну:
   * объяснение обычно стоит над всем блоком, а не над самим `catch`. */
  const withLeadIn = (at: number, raw: string): string => {
    const before = source.slice(0, at).split('\n').slice(-9).join('\n');
    return `${before}\n${raw}`;
  };

  for (const m of source.matchAll(/\bcatch\s*(\([^)]*\))?\s*\{/g)) {
    const at = m.index ?? 0;
    const raw = braced(source.indexOf('{', at));
    out.push({ line: source.slice(0, at).split('\n').length, body: stripComments(raw), raw: withLeadIn(at, raw) });
  }
  // `.catch(x => { … })` — тело тоже в скобках; первая версия правила
  // обрывала его на первой строке и видела один символ `{`.
  for (const m of source.matchAll(/\.catch\(\s*(\([^)]*\)|\w+)\s*=>\s*\{/g)) {
    const at = m.index ?? 0;
    const raw = braced(source.indexOf('{', at + 7));
    out.push({ line: source.slice(0, at).split('\n').length, body: stripComments(raw), raw: withLeadIn(at, raw) });
  }
  // `.catch(x => выражение)` — однострочная форма.
  for (const m of source.matchAll(/\.catch\(\s*(\([^)]*\)|\w+)\s*=>\s*([^{;\n][^;\n]{0,200})/g)) {
    const at = m.index ?? 0;
    out.push({ line: source.slice(0, at).split('\n').length, body: stripComments(m[2]), raw: withLeadIn(at, m[2]) });
  }
  return out;
}

/** Сбой либо ПОКАЗАН человеку, либо ОБЪЯСНЕН в коде — третьего не дано. */
// ПОПРАВКА, Пункт [one-buzz-was-the-whole-answer] 2026-09-24. Здесь
// стояло `haptic('error')` — то есть ВИБРАЦИЯ СЧИТАЛАСЬ СИГНАЛОМ
// человеку. Из-за этого тридцать обработчиков, у которых не было
// ничего, кроме толчка, измерение относило к «сообщающим», и число
// внизу описывало не то, что называло. Вибрация не несёт ни факта, ни
// причины, а на части устройств выключена вовсе.
const SIGNALS = /set\w*[Ee]rror|setFailed|setNotFound|setLoadError|reportFailure|console\.(warn|error)|throw/;
const HAS_REASON = /\/\/|\/\*/;

/** Установка состояния (в том числе пустого) — это домен ПЕРВОГО
 * правила выше: там пустой список считается признаком сбоя, если файл
 * умеет показать ошибку. Двойной учёт сделал бы новое правило шумным и
 * бесполезным. */
const SETS_STATE = /set\w+\(/;

/** Страницы, которые открывает человек БЕЗ аккаунта и без другого
 * канала: кандидат с анкетой, получатель профиля, читатель публичного
 * обсуждения и библиотеки, заказчик с текстом вакансии. Для него
 * молчание безвыходно — спросить ему некого. */
const PUBLIC_PAGES = [
  'app/public/',
  'app/library/',
  'app/pre-questionnaire/',
  'app/posting-review/',
  'app/candidate-shares/',
  'app/media-review/',
];

/** Ложный успех: в обработчике ОШИБКИ выставляется признак удачи. */
const FALSE_SUCCESS = /set(Joined|Done|Saved|Sent|Accepted|Confirmed|Completed|Success)\w*\(\s*true\s*\)/;

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const scenarios: Array<[string, () => void]> = [
  ['в проекте есть что проверять', () => {
    const files = ROOTS.flatMap((r) => walk(r));
    assert(files.length > 20, `найдено всего ${files.length} файлов — похоже, сломан обход каталогов`);
  }],
  ['КЛЮЧЕВОЙ ТЕСТ: ни один экран не гасит ошибку загрузки в пустое состояние молча', () => {
    const offenders: string[] = [];
    for (const f of ROOTS.flatMap((r) => walk(r))) {
      const src = readFileSync(f, 'utf8');
      if (!SWALLOWS.test(src)) continue;
      if (SHOWS_FAILURE.test(src)) continue;
      offenders.push(f.slice(f.indexOf('/src/') + 1));
    }
    assert(
      offenders.length === 0,
      `эти экраны при сбое загрузки покажут пустоту без единого признака ошибки:\n  ${offenders.join('\n  ')}`,
    );
  }],

  ['КЛЮЧЕВОЙ ТЕСТ, Пункт [empty-looked-like-an-answer] 2026-09-24: ни одна загрузка не превращает сбой в пустой результат молча', () => {
    // ПРАВИЛО ПО МЕСТУ ВЫЗОВА, а не по файлу. Проверка выше прощает
    // ВЕСЬ файл, если в нём где-нибудь есть `setError(`, — и эта дыра
    // названа в шапке этого же файла, но исправлена была только для
    // двух соседних тестов. Отсюда сорок три загрузки, у которых сбой
    // неотличим от «здесь ничего нет».
    //
    // Разрешено ровно два случая, и оба названы поимённо ниже: сбой,
    // который САМ выставляет признак отказа, и «закрыться при
    // сомнении» — проверка согласия, которая при сбое сети спрашивает
    // заново вместо того, чтобы считать согласие данным.
    const ALLOWED = [
      { call: 'setFailed(true)', why: 'сам выставляет признак отказа — экран показывает его' },
      { call: 'setStatusFailed(true)', why: 'сам выставляет признак отказа — статус заявки показывается отдельно' },
      { call: 'setNotFound(true)', why: 'сам выставляет признак отказа — страница показывает «ссылка не найдена»' },
      { call: 'setCopied(false)', why: 'состояние кнопки «скопировано», а не загрузка данных' },
      { call: "setState('needed')", why: 'проверка согласия закрывается при сомнении: спросить заново безопаснее, чем счесть согласие данным' },
      { call: "setAiConsent('needed')", why: 'то же: сбой проверки согласия ведёт к вопросу, а не к действию без согласия' },
    ];
    const silentLoads = (src: string): string[] => {
      const found: string[] = [];
      for (const m of src.matchAll(/\.catch\(\(\)\s*=>\s*(set\w+\([^()]*?\))\s*\)/g)) {
        const call = m[1].replace(/\s+/g, '');
        if (ALLOWED.some((a) => a.call.replace(/\s+/g, '') === call)) continue;
        found.push(`${src.slice(0, m.index!).split('\n').length} · ${m[1]}`);
      }
      return found;
    };

    // ОБРАТНАЯ ПРОБА ВНУТРИ ТОГО ЖЕ РАЗБОРА. Мутация «пропускать всё»
    // оставляла список нарушителей пустым, и тест проходил: пустота
    // означала не чистоту, а то, что никто не смотрел.
    assert(silentLoads('load().then(setX).catch(() => setX([]))').length === 1, 'разбор не находит молчаливую загрузку');
    assert(silentLoads('load().then(setX).catch(() => setFailed(true))').length === 0, 'разбор не узнаёт разрешённую форму');

    const offenders: string[] = [];
    for (const f of ROOTS.flatMap((r) => walk(r))) {
      const src = readFileSync(f, 'utf8');
      for (const hit of silentLoads(src)) offenders.push(`${f.slice(f.indexOf('/src/') + 1)}:${hit}`);
    }
    assert(
      offenders.length === 0,
      `сбой загрузки тут выглядит как ответ продукта «здесь ничего нет» (${offenders.length}):\n  ${offenders.join('\n  ')}`,
    );
    // Разрешения обязаны относиться к существующим строкам: реестр,
    // переживший свой код, — это «проверка, которая выглядит
    // существующей».
    const all = ROOTS.flatMap((r) => walk(r)).map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const a of ALLOWED) {
      assert(all.includes(`.catch(() => ${a.call})`), `разрешение «${a.call}» больше ни к чему не относится`);
      assert(a.why.length > 30, `у разрешения «${a.call}» нет причины`);
    }
  }],

  ['КЛЮЧЕВОЙ ТЕСТ, Пункт [empty-looked-like-an-answer] 2026-09-24: признак сбоя не только ставится, но и ПОКАЗЫВАЕТСЯ', () => {
    // Мутация «убрать подпись, оставив флаг» проходила предыдущую
    // проверку насквозь: обработчик честно выставляет признак, а на
    // экране его никто не читает — и список снова молча пуст. Знакомая
    // форма: механизм есть, доступа к нему нет.
    const offenders: string[] = [];
    for (const f of ROOTS.flatMap((r) => walk(r))) {
      const src = readFileSync(f, 'utf8');
      const rel = f.slice(f.indexOf('/src/') + 1);
      // Булев признак: `setNotLoaded(true)` → читается как `notLoaded`
      // рядом с подписью.
      for (const m of src.matchAll(/set([A-Z]\w*)\(true\)/g)) {
        const flag = m[1][0].toLowerCase() + m[1].slice(1);
        if (!/NotLoaded|Failed/.test(m[1])) continue;
        // «Показывается» — значит стоит условием в разметке. Форма
        // записи бывает и однострочной, и многострочной, поэтому
        // проверяется начало условия, а не строка целиком: первая
        // редакция требовала `NotLoadedNotice` в ТОЙ ЖЕ строке и
        // объявила нарушением семь честных мест.
        const shown = new RegExp(`${flag}\\s*(&&|\\?)|if\\s*\\(\\s*${flag}\\s*\\)`).test(src);
        if (!shown) offenders.push(`${rel} · ${flag} ставится, но не показывается`);
      }
      // Признак по имени блока: `.add('x')` → должен быть `.has('x')`.
      for (const m of src.matchAll(/\.add\('(\w+)'\)/g)) {
        if (!src.includes(`.has('${m[1]}')`)) offenders.push(`${rel} · блок «${m[1]}» помечается сбойным, но нигде не читается`);
      }
    }
    assert(offenders.length === 0, `признак сбоя загрузки некому показать:\n  ${[...new Set(offenders)].join('\n  ')}`);
  }],

  ['ОБРАТНАЯ ПРОБА: правило по месту вызова действительно строже правила по файлу', () => {
    // Файл, где есть и `setError(` где-то, и молчаливая загрузка, —
    // ровно то, что прощало прежнее правило.
    const sample = "function A(){ setError('x'); }\nfunction B(){ load().then(setX).catch(() => setX([])); }";
    assert(SHOWS_FAILURE.test(sample), 'образец не подходит: в нём нет setError');
    const perSite = [...sample.matchAll(/\.catch\(\(\)\s*=>\s*(set\w+\([^()]*?\))\s*\)/g)];
    assert(perSite.length === 1, 'разбор по месту вызова не нашёл молчаливую загрузку');
  }],

  ['ИЗМЕРЕНИЕ, Пункт [one-buzz-was-the-whole-answer] 2026-09-24: сколько загрузок всё ещё превращают сбой в пустой список', () => {
    // ДЫРА, НАЗВАННАЯ ТРЕМЯ СТРОКАМИ ВЫШЕ И НЕ ЗАКРЫТАЯ ЗДЕСЬ.
    // Комментарий к пункту [false-success] прямо пишет: «`SHOWS_FAILURE`
    // проверяется ПО ФАЙЛУ: если где-то в файле есть `setError(`, то
    // ЛЮБОЙ молчащий catch в нём прощён». Для двух тестов ниже это
    // исправили разбором по каждому обработчику; ДЛЯ ТЕСТА ВЫШЕ —
    // оставили. Поэтому он зелёный, а в коде пятьдесят с лишним
    // загрузок, у которых сбой неотличим от «здесь ничего нет».
    //
    // Это ровно то, что запрещает главное правило продукта: пробел не
    // должен выглядеть как отсутствие находок. `NotLoadedNotice` для
    // этого и написан — и применён в четырёх местах.
    //
    // Число записано здесь потолком, а не оставлено в отчёте: оно
    // обязано ИДТИ ВНИЗ. Работа названа и измерена, а не забыта.
    let sites = 0;
    for (const f of ROOTS.flatMap((r) => walk(r))) {
      sites += (readFileSync(f, 'utf8').match(/\.catch\(\(\)\s*=>\s*set\w+\(/g) ?? []).length;
    }
    // ОБРАТНАЯ ПРОБА: потолок сверху проходит и тогда, когда счётчик
    // перестал считать. Ноль здесь означал бы не победу, а поломку
    // разбора — и именно так эта проверка когда-нибудь тихо умрёт.
    assert(sites > 0, 'разбор не нашёл ни одной такой загрузки — счётчик сломан, а не работа сделана');
    // Потолок опущен с 52 до 6, Пункт [empty-looked-like-an-answer]
    // 2026-09-24: сорок три загрузки научились говорить, что данных нет
    // из-за сбоя, а шесть оставшихся перечислены поимённо в правиле
    // выше — там сбой сам выставляет признак отказа либо закрывается
    // при сомнении.
    assert(
      sites <= 6,
      `загрузок, превращающих сбой в пустой результат, стало ${sites} — их должно становиться меньше, а не больше`,
    );
  }],
  ['КЛЮЧЕВОЙ ТЕСТ (пункт [false-success] 2026-09-04): обработчик ошибки НЕ выставляет признак успеха', () => {
    // Хуже молчания. На публичном обсуждении стояло `setJoined(true)` в
    // `catch`: человек вводил имя, получал экран участника — и писал
    // дальше без имени, потому что на сервер он не попал. Экран не
    // промолчал, он сказал неправду.
    const offenders: string[] = [];
    for (const f of ROOTS.flatMap((r) => walk(r))) {
      for (const { line, body } of catchBodies(readFileSync(f, 'utf8'))) {
        if (FALSE_SUCCESS.test(body)) offenders.push(`${f.slice(f.indexOf('/src/') + 1)}:${line}`);
      }
    }
    assert(offenders.length === 0, `здесь сбой выдаётся за успех:\n  ${offenders.join('\n  ')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ (пункт [false-success] 2026-09-04): на ПУБЛИЧНЫХ страницах молчащий обработчик обязан объяснять, почему он молчит', () => {
    // Правило уровня ОПЕРАТОРА вместо правила уровня файла: прежняя
    // проверка прощала любой молчащий `catch` в файле, где `setError`
    // встречался хоть раз, — из-за чего мимо неё прошли оба места на
    // публичном обсуждении.
    //
    // ГРАНИЦА ПРАВИЛА НАЗВАНА ЧЕСТНО. Строго — только публичные страницы:
    // их открывает человек, который продуктом не пользуется, аккаунта не
    // имеет и спросить ему некого; для него молчание безвыходно. По
    // всему остальному интерфейсу измерено 33 таких обработчика — почти
    // все фоновые и идемпотентные (опрос, необязательная подгрузка), — и
    // выписывать им 33 объяснения «под правило» значило бы наплодить
    // пустых формул, ровно то, что запретила сверка [guard-audit].
    // Оставлено измерением ниже, а не требованием.
    const offenders: string[] = [];
    for (const f of ROOTS.flatMap((r) => walk(r))) {
      const rel = f.slice(f.indexOf('/src/') + 1);
      if (!PUBLIC_PAGES.some((p) => rel.includes(p))) continue;
      for (const { line, body, raw } of catchBodies(readFileSync(f, 'utf8'))) {
        if (SIGNALS.test(body)) continue;      // сбой ПОКАЗАН
        if (HAS_REASON.test(raw)) continue;    // молчание ОБЪЯСНЕНО
        if (SETS_STATE.test(body)) continue;   // пустое состояние — домен правила выше
        offenders.push(`${rel}:${line}  ${body.replace(/\s+/g, ' ').trim().slice(0, 50)}`);
      }
    }
    assert(
      offenders.length === 0,
      `на публичных страницах обработчики молчат и не объясняют почему:\n  ${[...new Set(offenders)].join('\n  ')}`,
    );
  }],

  ['КЛЮЧЕВОЙ ТЕСТ (пункт [false-success] 2026-09-04): на публичной странице сбой ДЕЙСТВИЯ показывается, а не просто объясняется в коде', () => {
    // Граница между двумя правилами, и она содержательная. Фоновой
    // загрузке достаточно НАПИСАННОЙ ПРИЧИНЫ: человек её не запускал и
    // ждать ответа не может. Но если он НАЖАЛ — голос, отправку своего
    // опыта, присоединение, — комментарий в коде ему не виден. Здесь
    // требуется настоящее сообщение, и мутация «оставить объяснение,
    // убрать сообщение» обязана падать.
    const offenders: string[] = [];
    for (const f of ROOTS.flatMap((r) => walk(r))) {
      const rel = f.slice(f.indexOf('/src/') + 1);
      if (!PUBLIC_PAGES.some((p) => rel.includes(p))) continue;
      const source = readFileSync(f, 'utf8');
      // Тела обработчиков действий: `async function handleX() { … }`.
      for (const m of source.matchAll(/async function (handle\w+)\s*\([^)]*\)\s*\{/g)) {
        const open = source.indexOf('{', m.index ?? 0);
        let depth = 0;
        let end = source.length;
        for (let j = open; j < source.length; j++) {
          if (source[j] === '{') depth++;
          else if (source[j] === '}') {
            depth--;
            if (depth === 0) { end = j; break; }
          }
        }
        const fn = source.slice(open, end);
        for (const { body } of catchBodies(fn)) {
          if (SIGNALS.test(body)) continue;
          offenders.push(`${rel} · ${m[1]}()`);
        }
      }
    }
    assert(
      offenders.length === 0,
      `здесь человек нажал, действие не удалось, и на экране об этом ничего:\n  ${[...new Set(offenders)].join('\n  ')}`,
    );
  }],

  ['ИЗМЕРЕНИЕ: сколько молчащих обработчиков вне публичных страниц', () => {
    // Число живёт здесь, чтобы следующая сверка начинала с факта. Рост
    // сам по себе не дефект — дефект, когда он не замечен.
    const quiet = new Set<string>();
    for (const f of ROOTS.flatMap((r) => walk(r))) {
      const rel = f.slice(f.indexOf('/src/') + 1);
      for (const { line, body, raw } of catchBodies(readFileSync(f, 'utf8'))) {
        if (SIGNALS.test(body) || HAS_REASON.test(raw) || SETS_STATE.test(body)) continue;
        quiet.add(`${rel}:${line}`);
      }
    }
    // Потолок опущен с 45 до 25, Пункт [one-buzz-was-the-whole-answer]
    // 2026-09-24, и число под ним теперь значит не то, что раньше.
    // Прежде проверка считала ВИБРАЦИЮ сигналом человеку: обработчик, у
    // которого не было ничего, кроме толчка, проходил как сообщающий, и
    // потолок 45 прикрывал тридцать таких мест. Теперь толчок не
    // засчитывается, сами обработчики говорят словами — и осталось 24,
    // где молчание объяснено в коде или безобидно.
    assert(quiet.size < 25, `молчащих обработчиков стало ${quiet.size} — стоит пересмотреть, все ли они безобидны`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ (сверка чтений без потолка 2026-09-04): экран, получающий hasMore, обязан сказать человеку, что список неполный', () => {
    // Тот же дефект, только про объём: список, молча показанный не
    // целиком, читается как полный. Если экран разбирает `hasMore` из
    // ответа сервера, он обязан и показать это — иначе флаг существует
    // ради самого себя, ровно как отзыв согласия, который писался и не
    // читался (заход [authz-sweep]).
    const offenders: string[] = [];
    for (const f of ROOTS.flatMap((r) => walk(r))) {
      const src = readFileSync(f, 'utf8');
      if (!/hasMore/i.test(src)) continue; // ловит и `submissionsHasMore`
      if (/TruncatedListNotice/.test(src)) continue;
      offenders.push(f.slice(f.indexOf('/src/') + 1));
    }
    assert(
      offenders.length === 0,
      `эти экраны знают, что список обрезан, и не говорят об этом:\n  ${offenders.join('\n  ')}`,
    );
  }],
  ['КЛЮЧЕВОЙ ТЕСТ (сверка отзыва согласия 2026-09-04): экран отзыва обязан сказать, чего отзыв НЕ отменяет', () => {
    // Третья форма того же дефекта. Первая: сбой выглядит как пустота.
    // Вторая: обрезанный список выглядит как полный. Эта — зеркальная:
    // БЕЗДЕЙСТВИЕ ВЫГЛЯДИТ КАК ДЕЙСТВИЕ. Отзыв согласия отвечал «готово»,
    // и человек читал это как «всё, что собрано под этим согласием,
    // удалено», тогда как для одиннадцати типов из тринадцати отзыв
    // запрещает будущее, а не отменяет прошлое.
    const src = readFileSync(join(__dirname, '..', 'app', 'privacy', 'page.tsx'), 'utf8');
    assert(/revokeConsent\(/.test(src), 'экран приватности перестал отзывать согласия — проверка смотрит не туда');
    assert(
      /doesNotUndo/.test(src),
      'экран отзывает согласие и не показывает, чего отзыв НЕ отменяет — молчание здесь читается как «всё стёрли»',
    );
    assert(
      /alsoDone/.test(src),
      'экран не показывает, что отзыв сделал сверх пометки (закрытые ссылки, удалённый голосовой отпечаток)',
    );
  }],
  ['подпись об обрезанном списке действительно где-то используется — проверка не проходит от того, что искать нечего', () => {
    const used = ROOTS.flatMap((r) => walk(r)).filter((f) => /TruncatedListNotice/.test(readFileSync(f, 'utf8')));
    assert(used.length >= 3, `подпись используется всего в ${used.length} местах — ожидались компонент и два экрана`);
  }],
];

const results: Array<{ name: string; error?: string }> = [];
for (const [name, fn] of scenarios) {
  try {
    fn();
    results.push({ name });
  } catch (err: any) {
    results.push({ name, error: err.message });
  }
}

const failed = results.filter((r) => r.error);
console.log(`\nsilent-failure-conventions: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

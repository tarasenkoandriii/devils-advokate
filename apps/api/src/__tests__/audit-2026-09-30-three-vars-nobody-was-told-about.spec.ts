// Пункт [three-vars-nobody-was-told-about] 2026-09-30 — имя, которое
// код читает, обязано быть названо в документации.
//
// НАЙДЕННОЕ. Сверка после деплоя перечислила все имена переменных
// окружения, читаемые продуктовым кодом, и сверила с документацией.
// Трёх не было НИ в `.env.example`, НИ в `VERCEL.md`:
// `SUPPORT_CONTACT` (без неё из уведомления о блокировке исчезает канал
// обжалования), `LEGAL_REFERENCES_CONFIRMED` (без неё не показываются
// номера норм права) и `EMPLOYER_REGISTRY_HOSTS` (без неё — полный
// список реестров по умолчанию). У всех трёх есть умолчание, поэтому
// «не выставлена» не ронял сервис, а молча менял поведение: именно
// поэтому их и не хватились — отсутствие выглядело как норма.
//
// ПОЧЕМУ ЭТО ПРАВИЛО, А НЕ ТРИ ПРАВКИ. У проекта уже есть сторож имён
// потолков (`ceilings-nobody-was-told-about`), и его урок записан прямо
// в `VERCEL.md`: правило «что код читает, то и объявлено» держится не
// само — его держит ПОЛНОТА ОБЪЕДИНЕНИЯ мест, откуда берутся имена. Тот
// сторож брал два реестра потолков; здесь берётся третий источник имён,
// самый обычный, — синтаксис чтения окружения в исходниках.
//
// ГРАНИЦА, НАЗВАННАЯ ВСЛУХ. Проверяются `apps/*/src` без тестов: сиды и
// дев-скрипты (`prisma/seed-dev.ts`, `scripts/diagnose-gemini.ts`) на
// платформу не едут, и требовать для них строки в документации деплоя
// значило бы засорять её тем, чего оператор никогда не выставляет.
// Имена секретов, лежащие в базе (`AIProvider.credentialRef`), этим
// сторожем не видны по построению — их держит `API-AND-KEYS.md` и
// отдельная проверка ключей.

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { loadRegistryHosts } from '../employer-dossier/registry-hosts';

const MONOREPO = join(__dirname, '..', '..', '..', '..');

/** Переменные, которые выставляет ПЛАТФОРМА, а не владелец. Требовать
 *  для них строки в документации деплоя бессмысленно: оператор их не
 *  задаёт и задать не может.
 *
 *  Список берётся ИЗ СОСЕДНЕГО СТОРОЖА
 *  (`audit-2026-09-24-ceilings-nobody-was-told-about.spec.ts`), а не
 *  пишется здесь второй раз: два списка исключений для одного правила
 *  разъезжаются, и тогда одно и то же имя оказывается освобождённым в
 *  одной сверке и запрещённым в другой. Проверка ниже требует, чтобы
 *  списки совпадали. */
const PROVIDED_BY_PLATFORM = new Set(
  [...readFileSync(join(__dirname, 'audit-2026-09-24-ceilings-nobody-was-told-about.spec.ts'), 'utf8')
    .matchAll(/\{ name: '([A-Z_0-9]+)', why:/g)].map((m) => m[1]),
);

/** Убирает комментарии и оставляет код.
 *
 *  Без этого сверка считает документацией упоминание имени в
 *  комментарии, а чтением — имя в рассказе о нём. Проект ловил эту
 *  ошибку в один день шесть раз, включая подсчёт cron-джоб, где
 *  комментарии дали 9 вместо 7. */
function stripComments(src: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | '"' | "'" | '`' = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (state === 'code') {
      if (two === '//') { state = 'line'; i++; continue; }
      if (two === '/*') { state = 'block'; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { state = c; out += c; continue; }
      out += c;
    } else if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
    } else if (state === 'block') {
      if (two === '*/') { state = 'code'; i++; }
    } else {
      if (c === '\\') { out += src.slice(i, i + 2); i++; continue; }
      if (c === state) state = 'code';
      out += c;
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

/** Три способа прочитать окружение, которыми пользуется этот проект.
 *  Четвёртый — `process.env[ключ]` по имени из реестра — покрыт
 *  сторожем потолков; он здесь тоже ловится, когда ключ записан
 *  литералом. */
const READ_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
  /config\.get(?:OrThrow)?(?:<[^>]*>)?\(['"]([A-Z][A-Z0-9_]+)['"]/g,
  /\benv\.([A-Z][A-Z0-9_]+)/g,
];

/** Имена, читаемые ОДНИМ исходником. Вынесено отдельно намеренно: на
 *  этой же функции стои́т обратная проба ниже — иначе она проверяла бы
 *  соседнее выражение, а не ту машинерию, которой решает ключевой тест
 *  (Пункт [probe-checked-the-neighbour] поймал ровно это). */
function namesInSource(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const pattern of READ_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(code)) !== null) if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function namesReadByCode(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const app of ['api', 'tma', 'admin', 'landing']) {
    for (const file of sourceFiles(join(MONOREPO, 'apps', app, 'src'))) {
      const rel = file.slice(MONOREPO.length + 1);
      for (const name of namesInSource(readFileSync(file, 'utf8'))) {
        const where = found.get(name) ?? [];
        if (!where.includes(rel)) where.push(rel);
        found.set(name, where);
      }
    }
  }
  return found;
}

const DOC_FILES = [
  'apps/api/.env.example',
  'apps/tma/.env.example',
  'apps/admin/.env.example',
  'apps/landing/.env.example',
  'VERCEL.md',
  'API-AND-KEYS.md',
];

function documentation(): string {
  return DOC_FILES.map((f) => (existsSync(join(MONOREPO, f)) ? readFileSync(join(MONOREPO, f), 'utf8') : '')).join('\n');
}

/** Имя названо, только если названо ЦЕЛИКОМ и не как часть имени файла.
 *
 *  Две ловушки, обе поймались на себе же. Первая: подстрока — `PORT`
 *  находится внутри `SUPPORT_CONTACT`, и сверка считала бы объявленным
 *  то, чего нет. Вторая, тоньше: граница слова СЧИТАЕТ названным
 *  `VERCEL` в тексте «см. VERCEL.md» — точка не буква, и правило
 *  зеленело от упоминания ФАЙЛА. Поэтому за именем не должно идти
 *  расширение. */
function named(docs: string, name: string): boolean {
  const pattern = new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])(?!\\.[a-z])`, 'g');
  return pattern.test(docs);
}

describe('Пункт [three-vars-nobody-was-told-about]: что код читает, то и объявлено', () => {
  it('КЛЮЧЕВОЕ ПРАВИЛО: каждое имя, читаемое продуктовым кодом, названо в документации', () => {
    const docs = documentation();
    const undocumented = [...namesReadByCode().entries()]
      .filter(([name]) => !PROVIDED_BY_PLATFORM.has(name))
      .filter(([name]) => !named(docs, name))
      .map(([name, files]) => `${name} (${files.slice(0, 2).join(', ')})`);
    expect(undocumented).toEqual([]);
  });

  it('три имени этого Пункта названы поимённо и с последствием пустого значения', () => {
    const envExample = readFileSync(join(MONOREPO, 'apps/api/.env.example'), 'utf8');
    const vercel = readFileSync(join(MONOREPO, 'VERCEL.md'), 'utf8');
    for (const name of ['SUPPORT_CONTACT', 'LEGAL_REFERENCES_CONFIRMED', 'EMPLOYER_REGISTRY_HOSTS']) {
      // В `.env.example` — именно СТРОКОЙ ПРИСВОЕНИЯ, а не упоминанием в
      // тексте: мутация «закомментировать строку, оставив имя в
      // объяснении» пережила первую версию этой проверки. Оператор
      // копирует файл целиком, и закомментированное имя в копию не
      // попадает — то есть «названо» и «есть в файле» разные вещи.
      expect(envExample.includes(`\n${name}=""`)).toBe(true);
      expect(named(vercel, name)).toBe(true);
    }
    // Названо не только имя, но и что означает пустое значение: имя без
    // последствия не даёт владельцу решить, выставлять ли его.
    expect(envExample.includes('ПУСТО ⇒')).toBe(true);
    expect(vercel.includes('Пусто ⇒')).toBe(true);
  });

  it('обратная проба: имя, упомянутое только в комментарии, чтением не считается', () => {
    // Иначе правило самоисполняется наоборот: достаточно было бы
    // ЗАБЫТЬ объявить переменную, но написать её имя в комментарии — и
    // сверка молчит. Проба гоняет ту же функцию, что и ключевой тест
    // (`namesInSource` внутри `namesReadByCode`), на выдуманном имени.
    const invented = 'ZZZ_INVENTED_FOR_THE_PROBE';
    expect(namesInSource(`// ${invented}\nconst a = 1;`)).toEqual([]);
    // И наоборот: настоящее чтение видно, даже когда рядом комментарий.
    expect(namesInSource(`const x = process.env.${invented}; // ${invented}`)).toEqual([invented]);
    // Выдуманного имени нет в настоящем проходе по дереву — то есть
    // проба говорит о том же множестве, что и правило.
    expect(namesReadByCode().has(invented)).toBe(false);
  });

  it('обратная проба: подстрока не считается названным именем', () => {
    expect(named('см. VERCEL.md', 'VERCEL')).toBe(false);
    expect(named('SUPPORT_CONTACT=""', 'PORT')).toBe(false);
    expect(named('PORT="3000"', 'PORT')).toBe(true);
  });

  it('список «выставляет платформа» — один на два сторожа, короткий и только платформенный', () => {
    // Список — единственная лазейка правила, поэтому он ограничен
    // явно: разрастаясь, он превращает сверку в формальность. И он
    // ОДИН: вычитан из соседнего сторожа, а не написан здесь второй
    // раз.
    expect(PROVIDED_BY_PLATFORM.size >= 4).toBe(true);
    expect(PROVIDED_BY_PLATFORM.size <= 6).toBe(true);
    for (const name of PROVIDED_BY_PLATFORM) {
      expect(/^(NODE_ENV|PORT|VERCEL|VERCEL_ENV|TZ)$/.test(name)).toBe(true);
    }
    // Признак платформы обязан быть в списке: без него правило
    // потребовало бы объявить `VERCEL` в `.env.example`, то есть
    // предложило бы оператору выставить его руками — и уронить свою
    // локальную сборку.
    expect(PROVIDED_BY_PLATFORM.has('VERCEL')).toBe(true);
    expect(PROVIDED_BY_PLATFORM.has('VERCEL_ENV')).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────
  // Пункт [typo-looked-like-a-decision] 2026-09-30 — та же порода, что
  // выше, но на стороне ЧТЕНИЯ: переменная названа, владелец её задал,
  // а продукт её молча не принял. Битый JSON в `EMPLOYER_REGISTRY_HOSTS`
  // заменялся полным списком по умолчанию без единой строки в логе:
  // владелец, СУЗИВШИЙ список реестров и поставивший лишнюю запятую,
  // получал ровно то, что убирал. «Опечатался» и «решил так» выглядели
  // одинаково.
  // ───────────────────────────────────────────────────────────────

  it('КЛЮЧЕВОЙ ТЕСТ: битый JSON в списке реестров назван в логе, а не проглочен', () => {
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    let result: ReturnType<typeof loadRegistryHosts>;
    try {
      result = loadRegistryHosts({ EMPLOYER_REGISTRY_HOSTS: '{ "registry": [ , ] }' } as NodeJS.ProcessEnv);
    } finally {
      console.error = realError;
    }
    // Поведение прежнее и намеренное: дефолт вместо падения.
    expect(Object.keys(result).length > 0).toBe(true);
    // Но теперь оно названо, и названо ИМЕНЕМ переменной — иначе
    // владелец не поймёт, какую настройку не прочитали.
    expect(errors.length).toBe(1);
    expect(errors[0].includes('EMPLOYER_REGISTRY_HOSTS')).toBe(true);
    expect(errors[0].includes('НЕ ДЕЙСТВУЕТ')).toBe(true);
  });

  it('обратная проба: не выставленная переменная НЕ пишет в лог — это обычный случай, а не ошибка', () => {
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      loadRegistryHosts({} as NodeJS.ProcessEnv);
      // И корректное значение тоже молчит, иначе лог обесценится.
      loadRegistryHosts({ EMPLOYER_REGISTRY_HOSTS: '{"registry":[]}' } as NodeJS.ProcessEnv);
    } finally {
      console.error = realError;
    }
    expect(errors).toEqual([]);
  });

  it('значение, разобравшееся не в объект, тоже названо', () => {
    // `"42"` — валидный JSON и бесполезная настройка: молчаливый дефолт
    // здесь так же неотличим от решения.
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      loadRegistryHosts({ EMPLOYER_REGISTRY_HOSTS: '42' } as NodeJS.ProcessEnv);
    } finally {
      console.error = realError;
    }
    expect(errors.length).toBe(1);
  });

  it('выборка непустая: сторож действительно читает исходники', () => {
    // Сверка, которой не на что смотреть, зеленеет и ничего не значит —
    // эта порода находилась в проекте четыре раза.
    const found = namesReadByCode();
    expect(found.size > 15).toBe(true);
    expect(found.has('DATABASE_URL')).toBe(true);
    expect(found.has('NEXT_PUBLIC_API_BASE_URL')).toBe(true);
    // И все три способа чтения действительно распознаются — иначе
    // сверка велика по объёму и слепа по существу.
    expect(namesInSource("const a = process.env.AAA_ONE;").includes('AAA_ONE')).toBe(true);
    expect(namesInSource("config.getOrThrow('BBB_TWO')").includes('BBB_TWO')).toBe(true);
    expect(namesInSource("function f(env = process.env) { return env.CCC_THREE; }").includes('CCC_THREE')).toBe(true);
  });
});

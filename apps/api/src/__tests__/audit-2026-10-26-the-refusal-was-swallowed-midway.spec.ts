// Сверка [the-refusal-was-swallowed-midway] 2026-10-26 — отказ, который
// продукт УЖЕ СФОРМУЛИРОВАЛ, съедался по пути и превращался в более
// бедный результат, выданный за полный.
//
// ЧТО ЭТО ЗА ОТКАЗ. Суточные потолки — не сбои. У каждого есть текст,
// он называет предел, называет, через сколько освободится место
// (Пункт [the-day-was-the-servers] 2026-10-26), и он адресован
// человеку: подождать — это то, что человек может сделать. Ровно так
// же устроен отказ «нет согласия EXTERNAL_AI»: исправимо в два
// нажатия.
//
// ЧТО С НИМИ ПРОИСХОДИЛО. `try { … spend… ; провайдер… } catch { … }`
// ставил рядом две совершенно разные причины — сбой провайдера и
// отказ потолка — и обращался с ними одинаково: деградировал. Сбой
// провайдера деградировать ПРАВИЛЬНО. Отказ потолка — нет: он
// превращался в
//   • список заведений короче найденного, выданный за весь список;
//   • публичную карточку заведения без рейтинга НАВСЕГДА (снимок
//     делается один раз, повторной модерации не будет);
//   • кейс evaluation, помеченный «версия промпта ответила неверно»,
//     когда версия промпта не отвечала вовсе;
//   • сравнение с объявлением без цены, как будто цены в объявлении
//     нет;
//   • онбординг без подсказки конфессии, как будто для этой страны
//     подсказки нет.
//
// И САМОЕ ДОРОГОЕ. В `runClassification` проглоченный отказ делал
// гейт `prompt_promotion` ЗЕЛЁНЫМ: `strongDiscrepancyFpr` считается от
// `cases.length`, а не от выполненных, и при потолке на втором кейсе
// давал 0/40 = 0 ≤ порога. Это дословно [the-gate-passed-on-nine-
// failures] 2026-09-30, закрытый в СОСЕДНЕМ методе ЭТОГО ЖЕ файла —
// и не распространённый на этот. Урок был записан в двадцати строках
// от дефекта.
//
// КАК ИЗМЕРЕНО (замер в самом тесте, не в этом комментарии). Файлов
// API без тестов — 491. Пар `try/catch`, внутри `try` которых стоит
// вызов, умеющий отказать человеку, — 82. Из них съедали отказ 6,
// в шести разных файлах. Седьмая (`discrepancy-analysis`) уже была
// честной: она выносит `aiError` в ответ — то есть образец правильного
// обращения в проекте был, просто не применялся рядом.
//
// СПИСОК ОТКАЗЫВАЮЩИХ ПОМОЩНИКОВ ВЫВОДИТСЯ ИЗ КОДА, А НЕ ПИШЕТСЯ
// РУКАМИ. Сверка [the-kind-was-never-checked] 2026-10-26 закончилась
// сторожем, который знает ИМЕНА методов, и это было названо её
// границей вслух. Здесь граница закрыта: помощник считается
// отказывающим, если в его теле (или в теле локальной функции,
// которую он зовёт) стоит `TOO_MANY_REQUESTS`. Добавить пятый потолок
// под новым именем и остаться незамеченным нельзя.
//
// СЕДЬМАЯ ПРАВКА СДЕЛАНА ПОПУТНО И ЭТИМ СТОРОЖЕМ НЕ
// ОХРАНЯЕТСЯ: в `onboarding.suggestFromLocation` ветка `NominatimError`
// возвращала три пустых поля без причины. Это сбой провайдера,
// а не отказ продукта, и вид его — [failure-looks-empty] 2026-09-05,
// другой сверки. Правка стоила одной строки и сделана рядом;
// сказано, что охраняет её не этот сторож, а счётчик `suggestionNote`
// в тесте правок ниже.
//
// ЧЕСТНАЯ ГРАНИЦА, И ОНА ЕСТЬ. Сторож доказывает, что отказ ВЫНЕСЕН
// ИЗ `catch` — переброшен, или его текст уехал наружу значением. Он
// НЕ доказывает, что текст дошёл до экрана: это предмет другой сверки
// ([computed-for-the-person-never-shown] 2026-09-30), и для пяти
// правок этого пункта показ на экране проверен здесь отдельными
// тестами по файлам клиентов. `catch`, который взял `err.message` и
// выбросил переменную, сторож пропустит: поток данных он не
// отслеживает.
//
// ДВЕ МУТАЦИИ ВЫЖИЛИ С ПЕРВОГО РАЗА, и обе — по одной причине:
// тест искал ИМЯ в файле вместо РЕШЕНИЯ. (1) Мутация, убравшая
// `priceNote` из ОТВЕТА и оставившая объявление, прошла мимо
// `toContain('priceNote')`. (2) Мутация, заменившая УСЛОВИЕ показа
// среза на `false`, прошла мимо `toContain('found.skippedCount')`.
// Первый тест теперь смотрит на сам возврат, второй — на разметку
// вынесенного компонента (`apps/tma/.../PartialResultNotice.tsx`).
// Записано здесь, а не исправлено молча: вид ошибки
// повторяется в этом проекте регулярно.
//
// ТРЕТЬЯ ОШИБКА БЫЛА В САМОЙ ЗАПИСИ ТЕСТА: в регулярное выражение
// попал байт 0x08 вместо `\b` — и тест краснел НА ЧИСТОМ коде,
// то есть выглядел находкой. Найдено тем, что прогон БЕЗ мутации
// тоже был красным: мутационная проверка без сверки с чистым
// состоянием доказывает только то, что тест красный.
//
// ЧЕГО СТОРОЖ НЕ ТРЕБУЕТ. Он не требует ронять операцию. Деградация
// по одному заведению из трёх осталась — и должна была остаться.
// Требование одно: не молчать о ней.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const API_SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/** Гасит комментарии и ТЕКСТ строк/шаблонов, сохраняя длину и
 * переводы строк: смещения и номера строк остаются верными, а
 * фигурные скобки внутри текста (их в этом проекте много — один
 * только системный промпт venue-recommendation содержит
 * `{"suitabilityReason": …}`) больше не ломают счёт блоков.
 *
 * ВЫРАЖЕНИЯ `${…}` В ШАБЛОНАХ СОХРАНЯЮТСЯ: это код, а не
 * текст. Первая версия этой функции гасила шаблон целиком — и
 * сторож объявил съеденными ЧЕТЫРЕ ИЗ ШЕСТИ СВОИХ ЖЕ
 * ПРАВОК: именно там причина выносится наружу в виде
 * `${err instanceof Error ? err.message : String(err)}`. Слепота была
 * ровно на самом частом способе сделать правильно.
 *
 * Ловушка, в которую этот проект попадал двенадцать раз (дважды —
 * внутри самого сторожа): разбирать текст, не сняв комментарии.
 * Здесь она стоит дорого вдвойне, потому что ПОЯСНЕНИЯ К ЭТИМ ЖЕ
 * ПРАВКАМ содержат слова `try`, `catch` и `spendPlacesRequest`. */
function blanked(source: string): string {
  const out = source.split('');
  const n = source.length;
  const wipe = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Стек раскрытых рамок: 'tpl' — текст шаблона (гасим),
  // 'expr' — выражение `${…}` (оставляем), 'brace' — вложенный
  // `{` внутри выражения (иначе `${ {a: 1} }` закроет рамку рано).
  const stack: ('tpl' | 'expr' | 'brace')[] = [];
  let i = 0;
  while (i < n) {
    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    const c = source[i];
    if (top === 'tpl') {
      if (c === '\\') {
        wipe(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        i++;
        continue;
      }
      if (c === '$' && source[i + 1] === '{') {
        stack.push('expr');
        i += 2;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      let j = source.indexOf('\n', i);
      if (j < 0) j = n;
      wipe(i, j);
      i = j;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      let j = source.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      wipe(i, j);
      i = j;
      continue;
    }
    if (c === '`') {
      stack.push('tpl');
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === c || source[j] === '\n') break;
        j++;
      }
      wipe(i + 1, j);
      i = Math.min(j + 1, n);
      continue;
    }
    if (c === '{' && (top === 'expr' || top === 'brace')) {
      stack.push('brace');
      i++;
      continue;
    }
    if (c === '}' && (top === 'expr' || top === 'brace')) {
      stack.pop();
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Снимает только комментарии, оставляя строки: нужно там, где
 * проверяется ИМЯ, живущее в строковом литерале (имя метрики), и
 * при этом УПОМИНАНИЕ того же имени в пояснении считаться не должно.
 * Та же ловушка, с той же стороны: первая версия этого теста
 * насчитала три вместо двух, третье — в моём же комментарии. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function matchingBrace(code: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Имя → тело, для объявлений функций (не методов класса: отказывающие
 * помощники проекта — свободные функции в `*-spend.ts`). */
function functionBodies(code: string): Map<string, string> {
  const res = new Map<string, string>();
  const re = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const open = code.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;
    const close = matchingBrace(code, open);
    if (close < 0) continue;
    res.set(m[1], code.slice(open, close + 1));
  }
  return res;
}

/** Экспортируемые функции файла, которые УМЕЮТ ОТКАЗАТЬ человеку: сами
 * бросают 429 либо зовут локальную функцию, которая бросает. */
function refusingExportsIn(code: string): string[] {
  const bodies = functionBodies(code);
  const refusing = new Set<string>();
  for (const [name, body] of bodies) if (body.includes('TOO_MANY_REQUESTS')) refusing.add(name);
  for (let pass = 0; pass < 4; pass++) {
    for (const [name, body] of bodies) {
      if (refusing.has(name)) continue;
      for (const known of refusing) {
        if (new RegExp(`\\b${known}\\s*\\(`).test(body)) {
          refusing.add(name);
          break;
        }
      }
    }
  }
  return [...refusing].filter((name) => new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(code));
}

interface TryCatch {
  readonly tryBody: string;
  readonly catchParam: string | null;
  readonly catchBody: string;
  readonly line: number;
}

function tryCatchPairs(code: string): TryCatch[] {
  const res: TryCatch[] = [];
  const re = /\btry\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const open = code.indexOf('{', m.index);
    const close = matchingBrace(code, open);
    if (close < 0) continue;
    const after = code.slice(close + 1, close + 200);
    const cm = /^\s*catch\s*(\(\s*([A-Za-z_$][\w$]*)?[^)]*\))?\s*\{/.exec(after);
    if (!cm) continue;
    const cOpen = close + 1 + after.indexOf('{', cm[0].length - 1);
    const cClose = matchingBrace(code, cOpen);
    if (cClose < 0) continue;
    res.push({
      tryBody: code.slice(open + 1, close),
      catchParam: cm[2] ?? null,
      catchBody: code.slice(cOpen + 1, cClose),
      line: code.slice(0, m.index).split('\n').length,
    });
  }
  return res;
}

/** `aiRouter.execute()` — метод класса, а не свободная функция, поэтому
 * в выведенный список он не попадает и назван здесь. Он отказывает
 * ровно так же: суточный потолок AI-вызовов и медиа-задач бросает 429
 * с текстом и сроком, отсутствие согласия — 403. Проект это знает:
 * `rethrowClientVisibleAiError` существует именно для этого и зовётся
 * из 133 точек. */
const REFUSING_METHOD_CALLS = [/\baiRouter\s*\.\s*execute\s*\(/];

function refusalCanReachHere(tryBody: string, helpers: readonly string[]): boolean {
  if (REFUSING_METHOD_CALLS.some((re) => re.test(tryBody))) return true;
  return helpers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(tryBody));
}

/** Отказ вынесен из `catch`, если: его перебрасывают; его отдаёт общий
 * шлюз проекта; либо его ТЕКСТ уезжает наружу значением. */
function refusalLeavesTheCatch(pair: TryCatch): boolean {
  const body = pair.catchBody;
  if (body.includes('rethrowClientVisibleAiError')) return true;
  if (/\bthrow\b/.test(body)) return true;
  const p = pair.catchParam;
  if (p && (new RegExp(`\\b${p}\\s*\\.\\s*message\\b`).test(body) || new RegExp(`\\bString\\s*\\(\\s*${p}\\s*\\)`).test(body))) {
    return true;
  }
  return false;
}

interface Swallow {
  readonly file: string;
  readonly line: number;
}

function swallowSites(): Swallow[] {
  const files = tsFiles(API_SRC);
  const helpers = new Set<string>();
  for (const f of files) for (const name of refusingExportsIn(blanked(readFileSync(f, 'utf8')))) helpers.add(name);
  const helperList = [...helpers];
  const found: Swallow[] = [];
  for (const f of files) {
    const code = blanked(readFileSync(f, 'utf8'));
    for (const pair of tryCatchPairs(code)) {
      if (!refusalCanReachHere(pair.tryBody, helperList)) continue;
      if (refusalLeavesTheCatch(pair)) continue;
      found.push({ file: f.slice(API_SRC.length + 1), line: pair.line });
    }
  }
  return found;
}

/** Точки, где отказ съедается ОСОЗНАННО. Пусто — и это измеренное
 * состояние, а не заготовка: до правок этого пункта здесь было бы
 * шесть записей. */
const DELIBERATE_SWALLOWS: readonly { readonly at: string; readonly why: string }[] = [];

describe('Сверка [the-refusal-was-swallowed-midway]: отказ, уже сформулированный продуктом, не съедается по пути', () => {
  test('замер не пуст: файлы найдены, пары try/catch с отказывающим вызовом найдены', () => {
    const files = tsFiles(API_SRC);
    expect(files.length).toBeGreaterThan(450);
    const helpers = new Set<string>();
    for (const f of files) for (const n of refusingExportsIn(blanked(readFileSync(f, 'utf8')))) helpers.add(n);
    const helperList = [...helpers];
    let bearing = 0;
    for (const f of files) {
      const code = blanked(readFileSync(f, 'utf8'));
      for (const pair of tryCatchPairs(code)) if (refusalCanReachHere(pair.tryBody, helperList)) bearing++;
    }
    // Пункт [the-empty-scan-was-green] 2026-10-02: сверка, которая
    // ничего не нашла, обязана падать, а не зеленеть.
    expect(bearing).toBeGreaterThan(60);
  });

  test('список отказывающих помощников ВЫВЕДЕН из кода и содержит все четыре известных потолка', () => {
    const helpers = new Set<string>();
    for (const f of tsFiles(API_SRC)) for (const n of refusingExportsIn(blanked(readFileSync(f, 'utf8')))) helpers.add(n);
    expect([...helpers].sort()).toEqual(
      ['assertOutwardCallsLeft', 'assertUnderDailyTranscriptionLimit', 'spendOutwardCall', 'spendPlacesRequest'].sort(),
    );
  });

  test('КЛЮЧЕВОЙ ТЕСТ: ни один catch вокруг отказывающего вызова не съедает отказ молча', () => {
    const sites = swallowSites();
    const registered = new Set(DELIBERATE_SWALLOWS.map((s) => s.at));
    const unexplained = sites.filter((s) => !registered.has(`${s.file}:${s.line}`));
    expect(unexplained.map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });

  test('реестр осознанных исключений замкнут: в нём нет записей о точках, которых больше нет', () => {
    const live = new Set(swallowSites().map((s) => `${s.file}:${s.line}`));
    expect(DELIBERATE_SWALLOWS.filter((s) => !live.has(s.at)).map((s) => s.at)).toEqual([]);
  });

  describe('сам определитель проверен на синтетическом коде — иначе зелёный цвет ничего не значит', () => {
    const helpers = ['spendPlacesRequest'];
    const detect = (src: string) =>
      tryCatchPairs(blanked(src))
        .filter((p) => refusalCanReachHere(p.tryBody, helpers))
        .filter((p) => !refusalLeavesTheCatch(p)).length;

    test('съеденный отказ — находится', () => {
      expect(detect('try { await spendPlacesRequest(p, u, "x"); await go(); } catch { skip(); }')).toBe(1);
    });

    test('переброшенный — не находится', () => {
      expect(detect('try { await spendPlacesRequest(p, u, "x"); } catch (e) { throw e; }')).toBe(1 - 1);
    });

    test('отданный общим шлюзом проекта — не находится', () => {
      expect(detect('try { await aiRouter.execute(a); } catch (e) { rethrowClientVisibleAiError(e); return null; }')).toBe(0);
    });

    test('вынесенный текстом наружу — не находится', () => {
      expect(detect('try { await spendPlacesRequest(p, u, "x"); } catch (e) { note = e.message; }')).toBe(0);
    });

    test('вызов ВНЕ try — не находится, даже если рядом есть деградирующий catch', () => {
      expect(detect('await spendPlacesRequest(p, u, "x"); try { await go(); } catch { skip(); }')).toBe(0);
    });

    test('упоминание в КОММЕНТАРИИ не считается вызовом — ловушка, в которую проект попадал двенадцать раз', () => {
      expect(detect('try { /* spendPlacesRequest стоял здесь */ await go(); } catch { skip(); }')).toBe(0);
      expect(detect('// try { spendPlacesRequest(x) } catch { }\nawait go();')).toBe(0);
    });

    test('фигурные скобки внутри строки не сбивают счёт блоков', () => {
      expect(detect('const s = "{{{"; try { await spendPlacesRequest(p, u, "}"); } catch { skip(); }')).toBe(1);
    });
  });
});

describe('[the-refusal-was-swallowed-midway] форма шести правок — то, чего не видно из поведения', () => {
  // ПОЧЕМУ ЗДЕСЬ МАЛО. Сторож [guard-audit] считает утверждения,
  // опирающиеся на ТЕКСТ исходника, и держит их число под потолком.
  // Первая версия этого блока добавила десять таких утверждений и увела
  // счёт с 260 на 270. Потолок НЕ поднят: у всех десяти есть
  // поведенческие двойники, и они перенесены туда, где есть рантайм:
  //
  //   срез и два числа          → venue-recommendation.service.spec.ts
  //                                   + apps/tma/.../the-refusal-…spec.ts (разметка)
  //   причина отсутствия рейтинга  → venue-application.service.spec.ts (два сценария)
  //                                   + apps/admin/.../the-refusal-…spec.ts
  //   гейт и причина в записи кейса → evaluation.service.spec.ts (39 из 40)
  //
  // Осталось то, у чего двойника нет по устройству: ФОРМА кода
  // (где стоит вызов относительно `try`) и число мест, где сделано
  // одно и то же. Ни одно из этих утверждений не считается текстовым
  // по мерке [guard-audit] — и не потому, что матчер подобран хитро,
  // а потому что проверяется ЧИСЛО, а не наличие слова.
  const read = (rel: string) => readFileSync(join(API_SRC, rel), 'utf8');

  test('подбор заведений: расход отмечается ВНЕ деградирующего try', () => {
    const code = blanked(read('venue-recommendation/venue-recommendation.service.ts'));
    // Ни одного `try`, внутри которого стоит расход: поведением
    // проверен ОДИН виток цикла, формой — весь файл.
    expect(tryCatchPairs(code).filter((p) => /\bspendPlacesRequest\s*\(/.test(p.tryBody))).toEqual([]);
  });

  test('модерация заведений: расход в своём try, и его catch выносит отказ наружу', () => {
    const code = blanked(read('venue-application/venue-application.service.ts'));
    const spendPairs = tryCatchPairs(code).filter((p) => /\bspendPlacesRequest\s*\(/.test(p.tryBody));
    // Ровно один: расход и запрос к провайдеру больше не стоят в
    // одном `try` — именно потому их причины теперь различимы.
    expect(spendPairs.length).toBe(1);
    expect(spendPairs.filter((p) => !refusalLeavesTheCatch(p))).toEqual([]);
  });

  test('evaluation: «cases_not_executed» пишется в ОБОИХ методах, а не только в соседнем', () => {
    // Дефект был именно в ТОМ, что урок закрыл один метод из двух.
    // Поведение доказывает каждый метод по отдельности; число ЗДЕСЬ
    // говорит, что третий метод, добавленный позже, без строки не уйдёт.
    expect(withoutComments(read('evaluation/evaluation.service.ts')).split('cases_not_executed').length - 1).toBe(2);
  });

  test('причина подставляется в запись кейса в обоих методах evaluation', () => {
    const code = blanked(read('evaluation/evaluation.service.ts'));
    expect(code.split('err instanceof Error ? err.message : String(err)').length - 1).toBe(2);
  });

  test('онбординг: причина есть во ВСЕХ четырёх выходах подсказки, а не в одном', () => {
    // Четыре выхода: сбой геокодера, «страны нет», сбой/отказ AI
    // и успех (там `null` — и это тоже утверждение, а не пропуск).
    expect(blanked(read('onboarding/onboarding.service.ts')).split('suggestionNote').length - 1).toBe(4);
  });

  test('сравнение с объявлением: причина уезжает В ОТВЕТ, а не только считается', () => {
    // ГРАНИЦА, НАЗВАННАЯ МУТАЦИЕЙ: первая версия искала слово
    // `priceNote` где угодно и пропустила мутацию, убравшую его из
    // возврата.
    //
    // И ЕЩЁ ОДНА ОШИБКА, ЗДЕСЬ ЖЕ: первая версия этого комментария
    // утверждала, что поведенческого двойника у `addComparison` нет
    // вовсе. Неправда: `major-purchase.service.spec.ts` зовёт его дважды.
    // Утверждение о пробеле без замера — та же порода, что искала
    // эта сверка. Двойник теперь там есть (отказ потолка при цене В
    // СТРАНИЦЕ), и эта проверка сторожит то, чего он не видит:
    // что причина стоит именно в ВОЗВРАТЕ, а не только считается.
    const n = blanked(read('major-purchase/major-purchase.service.ts')).split(/return \{ \.\.\.created,[^}]*priceNote/).length - 1;
    expect(n).toBe(1);
  });
});

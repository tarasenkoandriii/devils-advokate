// Пункт [probe-checked-the-neighbour] 2026-09-25 — сторож обратных проб.
//
// ПОВОД. Три сверки подряд ([server-said-which-day],
// [decisions-spoke-machine], [the-sentence-did-not-look-at-the-fact])
// нашли в МОЁМ ЖЕ новом коде одну и ту же ошибку: обратная проба
// вызывала НЕ ТО выражение, которое проверяет ключевой тест. Выглядит
// это безобидно — оба теста зелёные, — а означает вот что: мутация
// «пусть разбор всегда возвращает пусто» роняет только ключевой тест,
// если он смотрит на результат разбора, и не роняет НИЧЕГО, если
// ключевой тест сам построен на той же пустоте. Проба, стоящая рядом и
// проверяющая соседнее выражение, создаёт ощущение защиты и не защищает.
//
// ИЗМЕРЕНИЕ ПЕРЕД ПРАВИЛОМ. Обратных проб, вынесенных отдельным блоком,
// во всём монорепо — девятнадцать. Все девятнадцать делят машинерию с
// каким-нибудь неподозрительным тестом того же файла, то есть написаны
// верно. Сорок четыре сканирующие спеки, утверждающие «список пуст»,
// проверены отдельно: у каждой есть доказательство, что разбор вообще
// что-то находит. Иными словами, правило заводится НЕ на существующий
// беспорядок, а на ошибку, которую я делал трижды за три дня и которую
// ничто не ловило, кроме мутаций.
//
// ЧЕСТНАЯ ГРАНИЦА. Правило смотрит на обратные пробы, ВЫНЕСЕННЫЕ В
// ОТДЕЛЬНЫЙ ТЕСТ, — только их и можно проверить механически. Проба
// внутри того же теста (таких тринадцать) делит машинерию по построению:
// это тот же код. Правило не требует и не может требовать, чтобы проба
// была «правильной по смыслу»; оно ловит ровно один признак — что проба
// вообще трогает то же, что и проверка.

import * as fs from 'fs';
import * as path from 'path';

const APPS = ['api', 'tma', 'admin', 'landing'];
/** Собирается из кусков намеренно — см. комментарий у образцов ниже. */
const IT = ['i', 't'].join('');
const PROBE_WORD = ['обратная', 'проба'].join(' ');
const REPO = path.join(__dirname, '..', '..', '..', '..');

interface Block {
  name: string;
  body: string;
}

function specFiles(): string[] {
  const out: string[] = [];
  for (const app of APPS) {
    const dir = path.join(REPO, 'apps', app, 'src', '__tests__');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.spec.ts')) out.push(path.join(dir, f));
  }
  return out;
}

/** Блоки `it(...)`/`test(...)` — грубо, по следующему объявлению. Точный
 * разбор TypeScript здесь не нужен: правило смотрит на имена, которые
 * встречаются в теле, а не на структуру. */
function blocks(src: string): Block[] {
  const out: Block[] = [];
  // Пункт [the-empty-scan-was-green] 2026-10-02 — НАЧАЛО ОПЕРАТОРА, а не
  // просто `test(`. Прежняя редакция считала блоком любой `test('…')`,
  // включая ВЫЗОВ РЕГУЛЯРКИ `/rule/.test('образец')`, которых в спеках
  // этого проекта полно. Замер: 2958 «блоков» против 2856 настоящих —
  // 102 призрака в 55 файлах, а в девяти файлах собственного раннера
  // все «блоки» были призраками целиком.
  //
  // Чем это было плохо на деле: призрак РЕЗАЛ тело настоящего теста по
  // месту вызова регулярки. У пробы, начинавшейся с `.test('…')`, тело
  // обрывалось на первой строке, общих имён не оставалось — и сторож
  // сообщал о нарушении там, где машинерия как раз общая. Поймано на
  // живом прогоне, на пробе из этого же захода. Ложная тревога учит
  // обходить сторож, а не исправлять код.
  const re = /(?:^|[^.\w])(?:it|test)\(\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  const starts: Array<{ name: string; at: number }> = [];
  while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index + m[0].length });
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].at : src.length;
    out.push({ name: starts[i].name, body: src.slice(starts[i].at, end) });
  }
  return out;
}

/** Имена, объявленные в самом файле: хелперы разбора, регулярные
 * выражения, реестры. Именно они и есть «машинерия решения». */
function locals(src: string): Set<string> {
  // `export` перед объявлением — 2026-10-02. Прежняя редакция не
  // считала локальным `export function foo`, и проба, построенная на
  // таком помощнике, объявлялась «не трогающей ничего общего». То есть
  // сторож ошибался в ту же сторону, против которой стои́т: сообщал о
  // проблеме там, где машинерия как раз общая. Поймано на собственном
  // прогоне, когда помощник счёта индексов был объявлен с `export`.
  return new Set(
    [...src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|function)\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
  );
}

function used(body: string, local: Set<string>): Set<string> {
  return new Set([...body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((m) => m[1]).filter((w) => local.has(w)));
}

/** Проба опознаётся по НАЧАЛУ названия, а не по упоминанию где угодно:
 * ключевой тест, в названии которого встретилось слово «проба»,
 * пробой не является. Именно на этом правило сначала и поймало само
 * себя — и это тот же класс ошибки, ради которого оно написано:
 * измерять по упоминанию, а не по роли. Все девятнадцать существующих
 * проб названы именно так, с начала строки.
 *
 * И граница слова здесь — НЕ `\b`: в JavaScript он ASCII-only, после
 * кириллической буквы не срабатывает, и правило молча переставало
 * находить что бы то ни было. Этот самый дефект уже разбирался в
 * [letters-were-not-the-language] — и я повторил его дословно, в правиле
 * про повторяющиеся ошибки. Поймано обратной пробой ниже. */
const isProbe = (name: string) => /^\s*(обратная проба|проба механизма)(?![А-Яа-яЁё])/i.test(name);

/** Пробы, не делящие ни одного локального имени ни с одним НЕ-пробным
 * тестом того же файла. */
function probesCheckingNothingShared(files: string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const local = locals(src);
    const bs = blocks(src);
    const keyIdents = new Set<string>();
    for (const b of bs) if (!isProbe(b.name)) for (const id of used(b.body, local)) keyIdents.add(id);
    for (const b of bs) {
      if (!isProbe(b.name)) continue;
      const mine = used(b.body, local);
      if ([...mine].some((id) => keyIdents.has(id))) continue;
      offenders.push(`${path.basename(file)}: ${b.name}`);
    }
  }
  return offenders;
}

describe('[probe-checked-the-neighbour] обратная проба трогает то же, что и проверка', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: ни одна обратная проба не проверяет соседнее выражение', () => {
    expect(probesCheckingNothingShared(specFiles())).toEqual([]);
  });

  it('ОБРАТНАЯ ПРОБА: вызов регулярки `.test(…)` блоком теста не считается — иначе он резал бы тело настоящего', () => {
    // Образец из кусков: литералом он нашёлся бы в тексте самой этой
    // спеки и посчитался бы настоящим блоком.
    const IT = ['i', 't'].join('');
    const DOT_TEST = ['.', 'test'].join('');
    const sample = [
      `${IT}('КЛЮЧЕВОЙ ТЕСТ: признак срабатывает', () => {`,
      `  expect(/rule/${DOT_TEST}('строка с rule')).toBe(true);`,
      '});',
    ].join('\n');
    const found = blocks(sample);
    expect(found).toHaveLength(1);
    // И тело НЕ обрезано вызовом регулярки внутри него.
    expect(found[0].body.includes('toBe(true)')).toBe(true);
  });

  it('ОБРАТНАЯ ПРОБА: помощник, объявленный с `export`, считается общей машинерией — иначе сторож тревожил бы впустую', () => {
    // 2026-10-02: ровно на этом сторож ошибся сам. Помощник счёта
    // индексов в [three-said-seven] был объявлен `export function`,
    // проба делила с ключевым тестом ИМЕННО его — а сторож сообщил о
    // нарушении, потому что не видел объявления. Ложная тревога здесь
    // опаснее, чем кажется: она учит обходить сторож, а не исправлять
    // код. Проверяется ТЕМ ЖЕ проходом, на временном файле.
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'probe-export-'));
    const file = path.join(dir, 'sample-export.spec.ts');
    const DECL = ['export', 'function'].join(' ');
    fs.writeFileSync(
      file,
      // Из кусков — по той же причине, что и образцы ниже: литерал
      // нашёлся бы в исходнике самой этой спеки.
      [
        `${DECL} scan(xs: string[]) { return xs.filter((x) => x === 'bad'); }`,
        `${IT}('КЛЮЧЕВОЙ ТЕСТ: нарушителей нет', () => { expect(scan([])).toEqual([]); });`,
        `${IT}('${PROBE_WORD}: тот же проход находит нарушителя', () => { expect(scan(['bad'])).toHaveLength(1); });`,
      ].join('\n'),
    );
    expect(probesCheckingNothingShared([file])).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ОБРАТНАЯ ПРОБА: тот же проход ловит пробу, которая ничего общего не трогает', () => {
    // Иначе пустой список выше означал бы не порядок, а сломанный
    // разбор — ровно та ошибка, ради которой это правило и написано.
    // Проба идёт ТЕМ ЖЕ проходом, на временном файле.
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'probe-guard-'));
    const bad = path.join(dir, 'sample-bad.spec.ts');
    fs.writeFileSync(
      bad,
      // Образцы собираются ИЗ КУСКОВ, а не пишутся литералом: иначе
      // разбор нашёл бы их в исходнике самой этой спеки и посчитал
      // настоящими тестами — сторож поймал бы собственную декорацию.
      [
        'const scan = () => [] as string[];',
        'const unrelated = () => 42;',
        `${IT}('КЛЮЧЕВОЙ ТЕСТ: нарушителей нет', () => { expect(scan()).toEqual([]); });`,
        `${IT}('${PROBE_WORD}: что-то ещё', () => { expect(unrelated()).toBe(42); });`,
      ].join('\n'),
    );
    const good = path.join(dir, 'sample-good.spec.ts');
    fs.writeFileSync(
      good,
      [
        "const scan = (xs: string[]) => xs.filter((x) => x === 'bad');",
        `${IT}('КЛЮЧЕВОЙ ТЕСТ: нарушителей нет', () => { expect(scan([])).toEqual([]); });`,
        `${IT}('${PROBE_WORD}: тот же проход находит нарушителя', () => { expect(scan(['bad'])).toHaveLength(1); });`,
      ].join('\n'),
    );

    expect(probesCheckingNothingShared([bad])).toHaveLength(1);
    expect(probesCheckingNothingShared([good])).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('измерение: обратные пробы в отдельных блоках есть, и их немало', () => {
    // Правило, которому нечего проверять, — это правило, о котором
    // нельзя сказать, работает ли оно.
    let separate = 0;
    for (const file of specFiles()) {
      for (const b of blocks(fs.readFileSync(file, 'utf8'))) if (isProbe(b.name)) separate++;
    }
    expect(separate).toBeGreaterThanOrEqual(19);
  });
});

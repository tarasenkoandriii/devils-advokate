// Пункт [draft-spoke-machine] 2026-09-24 — исходная половина сверки.
//
// ПРАВИЛО. Сообщение исключения — это текст ЧЕЛОВЕКУ: он приходит на
// экран целиком, как написан. Значит оно должно быть на языке
// интерфейса. Единственное исключение — ИМЯ СОБСТВЕННОЕ: название
// реестра, закона, юрисдикции. «ЄДРПОУ» по-русски — уже не ЄДРПОУ, и
// по переводу ничего не найдётся.
//
// Граница проходит не по языку, а по тому, СОЧИНЯЕТ ли продукт текст
// или ЦИТИРУЕТ существующее имя. Поэтому украинские названия в
// `legal-reference-seed.ts`, `registry-hosts.ts` и `legal-norms.ts`
// эта сверка не трогает, а сообщение с цитатой имени должно быть
// названо здесь поимённо и с причиной.
//
// ЧЕГО ЭТА СВЕРКА НЕ ДЕЛАЕТ. Она не проверяет промпты. Промпт — это
// инструкция модели, а не текст человеку, и язык ОТВЕТА задан
// отдельно и централизованно (`common/ai-response-language.ts`).
// Правило «весь исходник на одном языке» кричало бы на 210 мест,
// подавляющее большинство которых менять не нужно.

import * as fs from 'fs';
import * as path from 'path';

const API_SRC = path.join(__dirname, '..');

/** Буквы, которых нет в языке интерфейса. Их присутствие в строке —
 * признак того, что текст писали на другом языке.
 *
 * ПОПРАВКА, Пункт [letters-were-not-the-language] 2026-09-24. Одних
 * букв мало, и это не теоретическая оговорка: на публичной странице по
 * ссылке стояло «Посилання прострочене» — целиком украинская фраза, в
 * которой НЕТ НИ ОДНОЙ из этих букв. Сверка её не увидела и объявила
 * ось чистой.
 *
 * Буквы ловят написание, а не язык. Поэтому рядом — список слов и
 * окончаний, которых в языке интерфейса нет; он собран из того, что
 * реально встретилось, и растёт по находкам, а не по догадкам. */
const FOREIGN_LETTERS = /[іїєґ]/i;

/** Украинские слова и окончания, отличимые без специфических букв.
 * Список заведомо неполон — и именно поэтому он ЕСТЬ: полного признака
 * языка по строке не существует, а этот ловит то, что уже было. */
// `\b` в JavaScript определена по ASCII: `\bпосилання\b` не совпадает
// НИКОГДА, потому что кириллическая буква для неё не «буква». Первая
// редакция этого списка была написана именно так и не находила ничего —
// то есть повторяла ошибку, ради которой пишется: выражение, которое
// выглядит проверкой. Границы заданы явным кириллическим классом.
const CYR = 'А-Яа-яЁёІіЇїЄєҐґ';
const FOREIGN_WORDS = new RegExp(
  `(?<![${CYR}])(посилання|прострочен[${CYR}]*|вже|немає|бути|треба|користувач[${CYR}]*|повідомлен[${CYR}]*|налаштуван[${CYR}]*|видален[${CYR}]*|дозволен[${CYR}]*|заборонен[${CYR}]*|щоб|лише|зараз|цього|який|яка|має|мають|розмов[${CYR}]*|питання|завдання|зроблен[${CYR}]*|прийнят[${CYR}]*|відпов[${CYR}]*|не вдалося)(?![${CYR}])`,
  'i',
);

function looksForeign(text: string): boolean {
  return FOREIGN_LETTERS.test(text) || FOREIGN_WORDS.test(text);
}

/** Сообщения, в которых чужие буквы стоят ЗАКОННО: это цитата имени
 * собственного. Каждое названо целиком и с причиной — запись здесь
 * стоит дороже, чем перевод, поэтому список не растёт незаметно. */
const QUOTED_PROPER_NAMES: Array<{ file: string; fragment: string; reason: string }> = [
  {
    file: 'employer-dossier/employer-dossier.service.ts',
    fragment: 'ЄДРПОУ',
    reason:
      'Название украинского реестра юридических лиц и его код ФОП (РНОКПП). ' +
      'Человек вводит именно этот код и ищет его под этим именем; перевод сделал бы подсказку бесполезной.',
  },
];

/** Методы, собирающие ДОКУМЕНТ: они возвращают поле `disclaimer`.
 * Поведение каждого проверяется в парном файле сверки. */
const DOCUMENT_ASSEMBLERS = ['dtp/dtp-v2.service.ts', 'family-law/family-law-v2.service.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ПОПРАВКА, Пункт [refusal-spoke-english] 2026-09-24. Выражение знало
// ОДНУ форму записи — строковый литерал сразу за скобкой. Мимо него
// проходили:
//   • `new ConflictException({ message: '…' })` — объектная форма,
//     одиннадцать сообщений (все оказались на языке интерфейса, но
//     проверял их никто);
//   • `@Matches(…, { message: '…' })` — собственные тексты валидаторов;
//   • и главное — сообщения `class-validator` ПО УМОЛЧАНИЮ, у которых
//     литерала нет вовсе. Это самый частый отказ API, и правило о языке
//     его не видело в принципе. Отдельная проверка ниже требует, чтобы
//     этот канал шёл через свой шлюз.
const EXCEPTION_MESSAGE = /new\s+\w*Exception\(\s*(?:\{\s*message:\s*)?(`[^`]*`|'[^']*'|"[^"]*")|\{\s*message:\s*('[^']*'|"[^"]*")\s*\}/g;

/** Сообщения исключений с чужими буквами. Вынесено отдельной функцией,
 * чтобы обратная проба прогоняла ТОТ ЖЕ разбор, а не его пересказ. */
function foreignExceptionMessages(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(EXCEPTION_MESSAGE)) {
    const literal = m[1] ?? m[2];
    if (literal && looksForeign(literal)) found.push(literal);
  }
  return found;
}

describe('[draft-spoke-machine] текст человеку написан на языке интерфейса', () => {
  it('ни одно сообщение исключения не написано на чужом языке, кроме цитат имён собственных', () => {
    const unexplained: string[] = [];

    for (const file of walk(API_SRC)) {
      const rel = path.relative(API_SRC, file).split(path.sep).join('/');
      const source = fs.readFileSync(file, 'utf8');
      for (const message of foreignExceptionMessages(source)) {
        const allowed = QUOTED_PROPER_NAMES.some((a) => a.file === rel && message.includes(a.fragment));
        if (!allowed) unexplained.push(`${rel}: ${message}`);
      }
    }

    expect(unexplained).toEqual([]);
  });

  // ОБРАТНАЯ ПРОБА РАЗБОРА. Без неё `toEqual([])` выше проходило бы и в
  // случае, когда выражение перестало находить хоть что-нибудь.
  it('обратная проба: разбор действительно находит сообщение на чужом языке', () => {
    const synthetic = "throw new ForbiddenException('Досягнуто денний ліміт');";
    expect(foreignExceptionMessages(synthetic)).toHaveLength(1);
    expect(foreignExceptionMessages("throw new ForbiddenException('Достигнут суточный лимит');")).toEqual([]);
  });

  // РЕГРЕССИЯ, Пункт [letters-were-not-the-language] 2026-09-24. Ровно
  // эта фраза стояла на публичной странице по ссылке и прошла сверку
  // насквозь: специфических букв в ней нет. Тест держит исправленный
  // разбор — и он же объясняет, почему список слов вообще существует.
  it('фраза на чужом языке БЕЗ отличительных букв всё равно находится', () => {
    expect(FOREIGN_LETTERS.test('Посилання прострочене')).toBe(false);
    expect(looksForeign('Посилання прострочене')).toBe(true);
    expect(foreignExceptionMessages("throw new BadRequestException('Посилання прострочене');")).toHaveLength(1);
    // И не ловит язык интерфейса: «уже», «нет», «нужно» — не маркеры.
    expect(looksForeign('Ссылка недействительна или просрочена')).toBe(false);
    expect(looksForeign('Эта ссылка уже была принята')).toBe(false);
  });

  // ОБРАТНАЯ ПРОБА СПИСКА. Разрешение, пережившее строку, к которой
  // относилось, — это «проверка, которая выглядит существующей»:
  // список растёт, а прикрывает уже ничего.
  it('каждое разрешение всё ещё относится к существующей строке', () => {
    for (const allowed of QUOTED_PROPER_NAMES) {
      const source = fs.readFileSync(path.join(API_SRC, allowed.file), 'utf8');
      const messages = foreignExceptionMessages(source);
      expect(messages.some((m) => m.includes(allowed.fragment))).toBe(true);
      expect(allowed.reason.length).toBeGreaterThan(60);
    }
  });

  // Пункт [refusal-spoke-english] 2026-09-24: канал без литерала.
  it('КЛЮЧЕВОЙ ТЕСТ: отказы проверки запроса идут через свой шлюз, а не текстами class-validator', () => {
    const app = fs.readFileSync(path.join(API_SRC, 'create-app.ts'), 'utf8');
    // Без `exceptionFactory` наружу уходит «rawText must be shorter than
    // or equal to 30000 characters» — английская фраза с именем поля из
    // кода, и это самый частый отказ продукта.
    expect(/new ValidationPipe\(\{[^}]*exceptionFactory/.test(app.replace(/\s+/g, ' '))).toBe(true);
    expect(app.includes('validationException')).toBe(true);
  });

  it('обратная проба: расширенное выражение видит объектную форму сообщения', () => {
    expect(foreignExceptionMessages("throw new ConflictException({ message: 'Посилання прострочене' });")).toHaveLength(1);
    expect(foreignExceptionMessages("throw new ConflictException({ message: 'Ссылка просрочена' });")).toEqual([]);
    expect(foreignExceptionMessages("@Matches(/x/, { message: 'Досягнуто ліміт' })")).toHaveLength(1);
  });

  // Список сборщиков документов обязан оставаться полным: третий такой
  // метод, появившись, не должен остаться без поведенческой проверки.
  it('список сборщиков документов совпадает с тем, что есть в коде', () => {
    const found: string[] = [];
    for (const file of walk(API_SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      if (/return\s*\{[^}]*\bdisclaimer\b/.test(source)) {
        found.push(path.relative(API_SRC, file).split(path.sep).join('/'));
      }
    }
    expect(found.sort()).toEqual([...DOCUMENT_ASSEMBLERS].sort());
  });
});

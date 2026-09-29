// Сверка 2026-09-04, серверная половина — на чём на самом деле построен
// вывод, который читает человек.
//
// НАЙДЕННОЕ. В четырёх местах подряд контекст о человеке собирался так:
//
//   behaviorPrecedent.findMany({ where: { personId }, take: 5,
//                                orderBy: { createdAt: 'desc' } })
//   → «Известные прецеденты поведения: …»
//
// Модели говорилось «ИЗВЕСТНЫЕ прецеденты», а отдавались пять последних
// из скольких угодно. Разница не косметическая: на полном списке вывод
// «он так никогда не делал» неверен, на срезе выглядит обоснованным — и
// модель не может знать, что видит часть, если ей не сказать. Ровно так
// же собирались «ключевые аргументы»: пять самых весомых из всех, без
// слова «пять».
//
// Сами лимиты законны — промпт не резиновый, и в коде это честно
// объяснено комментариями. Незаконно было то, что усечение видно ТОЛЬКО
// в комментариях: пробел не должен выглядеть как полнота.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  partialBasis,
  isTruncated,
  promptBasisNote,
  humanBasisNote,
} from '../common/partial-basis';

const API_SRC = join(__dirname, '..');

/** Комментарии прочь перед разбором КОДА: за эту сессию проверки пять
 * раз ловили собственный объяснительный текст, а здесь старые
 * формулировки процитированы в комментариях как «было раньше». */
function code(rel: string): string {
  return readFileSync(join(API_SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Все сервисы, которые вообще берут прецеденты срезом. Список не
 * захардкожен: новый сервис с тем же срезом обязан либо назвать
 * усечение, либо уронить эту проверку. */
function servicesTruncatingPrecedents(): string[] {
  const found: string[] = [];
  (function walk(dir: string, rel: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else if (entry.name.endsWith('.service.ts')) {
        const src = code(r);
        if (/behaviorPrecedent\.findMany\([^)]*take:/s.test(src)) found.push(r);
      }
    }
  })(API_SRC, '');
  return found;
}

describe('Основание разбора: срез не выдаётся за полноту', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: усечение названо модели прямо в списке', () => {
    const cut = partialBasis('прецеденты поведения', 5, 23, 'recent');
    const note = promptBasisNote(cut);
    expect(note).toMatch(/последние 5 из 23/);
    // Главное — прямой запрет достраивать отсутствующее: без него модель
    // делает вывод «такого за ним не водится» из среза.
    expect(note).toMatch(/не делай выводов о том, чего в списке нет/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отбор по весу и по дате называются по-разному', () => {
    // «Пять последних» и «пять самых весомых» — разные утверждения о
    // том, чего в списке нет, и путать их нельзя.
    expect(promptBasisNote(partialBasis('аргументы', 5, 12, 'weight'))).toMatch(/5 самых весомых из 12/);
    expect(promptBasisNote(partialBasis('аргументы', 5, 12, 'weight'))).not.toMatch(/последние/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: там, где усечения НЕ БЫЛО, не говорится ничего', () => {
    // Сообщение об усечении там, где его не было, — такой же обман,
    // только в другую сторону. У большинства людей прецедентов меньше
    // лимита, и молчание здесь единственно верное.
    const whole = partialBasis('прецеденты поведения', 3, 3, 'recent');
    expect(isTruncated(whole)).toBe(false);
    expect(promptBasisNote(whole)).toBe('');
    expect(humanBasisNote([whole])).toBeNull();
    expect(humanBasisNote([])).toBeNull();
  });

  it('КЛЮЧЕВОЙ ТЕСТ: человеку названы ВСЕ урезанные источники, а не первый', () => {
    const note = humanBasisNote([
      partialBasis('аргументы', 5, 12, 'weight'),
      partialBasis('прецеденты поведения', 5, 23, 'recent'),
    ]);
    expect(note).toMatch(/аргументы — 5 самых весомых из 12/);
    expect(note).toMatch(/прецеденты поведения — последние 5 из 23/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: причина усечения названа честно — это лимит запроса, а не важность', () => {
    // Иначе человек прочитает «остальное не учли» как «остальное неважно»
    // и решит, что его данные оценили и отбросили.
    const note = humanBasisNote([partialBasis('прецеденты поведения', 5, 23, 'recent')]);
    expect(note).toMatch(/ограничение размера запроса к модели/);
    expect(note).toMatch(/не признак того, что остальное неважно/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: ни один сервис не берёт прецеденты срезом молча', () => {
    // Правило измеряется по всему дереву, а не по списку из четырёх
    // файлов: пятое такое место должно уронить проверку, а не тихо
    // повторить изъян. Ровно так же было в [decision-basis], где
    // правило существовало «просто не везде».
    const services = servicesTruncatingPrecedents();
    expect(services.length).toBeGreaterThanOrEqual(4);
    for (const rel of services) {
      const src = code(rel);
      expect({ rel, hasNote: /promptBasisNote\(/.test(src) }).toEqual({ rel, hasNote: true });
      // И счёт целого: без него доля неизвестна, а приписка была бы
      // выдумкой.
      expect({ rel, counts: /behaviorPrecedent\.count\(/.test(src) }).toEqual({ rel, counts: true });
    }
  });

  it('КЛЮЧЕВОЙ ТЕСТ: заголовок над срезом объявляет усечение, как бы его ни назвали', () => {
    // Первая версия правила искала конкретную формулировку — «Известные
    // прецеденты поведения». Пункт [inference-as-observation] переписал
    // эти заголовки (слово «известные» само по себе было обещанием), и
    // проверка на текст стала бы вакуумной: ни одного совпадения, ноль
    // претензий, зелено. Поэтому правило теперь о СТРОКЕ, где список
    // прецедентов подставляется в промпт, а не о словах в ней.
    for (const rel of servicesTruncatingPrecedents()) {
      const lines = code(rel)
        .split('\n')
        .filter((line) => /\$\{precedentsText\}/.test(line));
      expect({ rel, lines: lines.length }).not.toEqual({ rel, lines: 0 });
      for (const line of lines) {
        expect({ rel, line, disclosed: line.includes('promptBasisNote') }).toEqual({ rel, line, disclosed: true });
      }
    }
  });

  it('смешанный случай: урезанное названо, целое — нет', () => {
    const note = humanBasisNote([
      partialBasis('аргументы', 4, 4, 'weight'),
      partialBasis('прецеденты поведения', 5, 23, 'recent'),
    ]);
    expect(note).toMatch(/прецеденты поведения/);
    expect(note).not.toMatch(/аргументы/);
  });
});

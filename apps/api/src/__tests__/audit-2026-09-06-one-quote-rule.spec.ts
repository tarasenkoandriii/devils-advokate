// Сверка 2026-09-06 — цитатный барьер был написан пять раз.
//
// ЧТО ЭТО ЗА БАРЬЕР. Модель, разбирая документ, возвращает не только
// вывод, но и ЦИТАТУ — отрывок источника, на который опирается.
// Продукт проверяет её детерминированно: нет цитаты в источнике —
// вывод не сохраняется. Это центральный механизм честности всего
// проекта: «CV только из ваших слов», опора у каждого факта,
// «улучшенная» формулировка опорой не считается.
//
// НАЙДЕННОЕ. Барьер существовал в пяти реализациях, и они расходились:
//
//  1. `quoteIsFromSource` (terms-matching) — пробелы + регистр; её
//     зовут шесть модулей: условия листа, чек-листы соответствия,
//     досье компании, брифы клиента;
//  2. `quoteIsFromDocument` (cv-evidence) — та же, отдельной копией;
//  3. `quoteOccursIn` (cv-variant-barriers) — пробелы, регистр, И
//     типографика, И минимальная длина 3;
//  4-5. две встроенные копии в job-search-tools — пробелы и регистр
//     БЕЗ `trim()`.
//
// ОШИБКИ В ОБЕ СТОРОНЫ:
//
//  • ЛОЖНЫЙ ОТКАЗ: модель цитирует верно, но подставляет «ёлочки» или
//    длинное тире — для четырёх из пяти реализаций это другая строка.
//    Цитата отвергается, и человек читает причину, которая на его
//    языке звучит как «модель сослалась на то, чего вы не говорили».
//    Продукт делает неверное утверждение о СОБСТВЕННОМ источнике
//    человека — ровно то, от чего барьер и поставлен. Та же цитата в
//    варианте CV при этом проходит;
//  • ЛОЖНОЕ ПРИНЯТИЕ: минимальной длины не было у четырёх из пяти.
//    Цитата из одного символа содержится в любом тексте — и такая
//    «опора» проходила в досье компании, в брифе клиента и в чек-листе
//    соответствия, то есть там, где цитатой утверждается, ЧТО ЧЕЛОВЕК
//    НАПИСАЛ ИЛИ СКАЗАЛ;
//  • отсутствие `trim()` у двух встроенных — ещё один ложный отказ.
//
// РЕШЕНИЕ: одна реализация, самая осторожная из пяти. Правило не
// выдумано заново — выбрана та, что уже была строже прочих.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { MIN_QUOTE_CHARS, normalizeForQuoteMatch, quoteIsFromSource } from '../common/quote-match';
import { quoteIsFromSource as fromTermsMatching } from '../terms-sheet/terms-matching.service';
import { quoteOccursIn } from '../terms-sheet/cv-variant-barriers';
import { quoteIsFromDocument } from '../job-search/cv-evidence';

const API_SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

describe('Сверка [one-quote-rule]: барьер цитаты — один на проект', () => {
  describe('правило на своих данных', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: типографика не считается расхождением — «ёлочки» и длинное тире', () => {
      const source = 'Работодатель написал: "удалённая работа - возможна".';
      expect(quoteIsFromSource('«удалённая работа — возможна»', source)).toBe(true);
    });

    it('КЛЮЧЕВОЙ ТЕСТ: цитата в один-два символа не считается опорой', () => {
      const source = 'Любой текст со всеми буквами алфавита.';
      expect(quoteIsFromSource('а', source)).toBe(false);
      expect(quoteIsFromSource('ат', source)).toBe(false);
      expect(quoteIsFromSource('тек', source)).toBe(true);
      expect(MIN_QUOTE_CHARS).toBe(3);
    });

    it('ведущие и хвостовые пробелы не считаются расхождением', () => {
      expect(quoteIsFromSource('  удалённая работа  ', 'Условия: удалённая работа.')).toBe(true);
    });

    it('переформулировка опорой не считается — барьер не ослаблен заодно с объединением', () => {
      expect(quoteIsFromSource('работа из дома', 'Условия: удалённая работа.')).toBe(false);
    });

    it('перенос строки в источнике не мешает совпадению', () => {
      expect(quoteIsFromSource('оплата 2000 USD', 'Оплата\n2000   USD\nежемесячно')).toBe(true);
    });

    it('нормализация публична и применяется к обеим сторонам, а не к одной', () => {
      expect(normalizeForQuoteMatch(' «А—Б»  ')).toBe('"а-б"');
    });
  });

  describe('прежние имена ведут в одну реализацию', () => {
    const cases: Array<[string, (q: string, s: string) => boolean]> = [
      ['terms-matching.quoteIsFromSource', fromTermsMatching],
      ['cv-variant-barriers.quoteOccursIn', quoteOccursIn],
      ['cv-evidence.quoteIsFromDocument', quoteIsFromDocument],
    ];
    const source = 'Компания пишет: "гибкий график - обсуждается".';

    for (const [name, fn] of cases) {
      it(`${name} — то же поведение, что у общего барьера`, () => {
        expect(fn('«гибкий график — обсуждается»', source)).toBe(true); // типографика
        expect(fn('а', source)).toBe(false); // минимальная длина
        expect(fn('  гибкий график  ', source)).toBe(true); // trim
        expect(fn('свободный график', source)).toBe(false); // переформулировка
      });
    }
  });

  describe('шестой копии не будет', () => {
    /** ПРАВИЛО ПЕРЕПИСАНО ПО ХОДУ СВЕРКИ. Первая версия искала
     * определения функций по ИМЕНИ (`export function quote…`) — и
     * сработала на `quotedSpans()` из quote-limit.ts, который считает
     * ОБЪЁМ цитирования в ответе модели и к сверке цитаты с источником
     * отношения не имеет. Имя — не признак; признак — форма: функция
     * нормализует строку и спрашивает `.includes`. Правило переписано
     * на форму, здоровый файл не тронут. */
    it('КЛЮЧЕВОЙ ТЕСТ: сверку «цитата внутри источника» делает ровно один файл', () => {
      const offenders: string[] = [];
      for (const f of tsFiles(API_SRC)) {
        if (/common[\\/]quote-match\.ts$/.test(f)) continue;
        const code = readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, '');
        if (/normalize\w*\([^)]*\)\s*\.includes\(/.test(code)) offenders.push(f.slice(API_SRC.length + 1));
      }
      expect(offenders).toEqual([]);
    });

    it('проба: новый файл с собственной нормализацией цитаты правилом ловится', () => {
      // Правило проверяется НАСТОЯЩИМ нарушителем, а не рассуждением о
      // нём: иначе повторилась бы слепая проверка из [guard-scope].
      const offender = "const q = normalizeForQuoteMatch(quote);\nreturn normalizeForQuoteMatch(source).includes(q);";
      expect(/normalize\w*\([^)]*\)\s*\.includes\(/.test(offender)).toBe(true);
    });

    it('КЛЮЧЕВОЙ ТЕСТ: ни один файл не сверяет цитату встроенной нормализацией', () => {
      // Форма обеих встроенных копий: `norm.includes(x.quote.replace(...))`.
      const offenders: string[] = [];
      for (const f of tsFiles(API_SRC)) {
        const code = readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, '');
        if (/\.includes\(\s*\w+\.quote\b/.test(code) || /\w+\.quote\.replace\(/.test(code)) {
          offenders.push(f.slice(API_SRC.length + 1));
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});

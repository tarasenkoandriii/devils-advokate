/** Пункт [guard-scope] 2026-09-06 — обход дерева экранов, один на все
 * проверки.
 *
 * НАЙДЕНО ПРОБАМИ. Три правила, написанные прошлыми сверками, смотрели
 * в СПИСОК ФАЙЛОВ, а не в дерево, — и подсунутый новый экран-нарушитель
 * они пропускали:
 *
 *   quotation-marks  — новый экран с «{quoteText}» прошёл насквозь;
 *   partial-basis    — новый экран, режущий список до пяти и зовущий
 *                      остаток «ключевым», прошёл насквозь;
 *   source-collapse  — новый экран с фактами о человеке без
 *                      происхождения прошёл насквозь, при том что
 *                      комментарий в самой проверке обещал: «Третье
 *                      должно уронить эту проверку».
 *
 * Последнее хуже первых двух: правило УТВЕРЖДАЛО о себе то, чего не
 * делало. Это ровно тот изъян, который вся сессия ищет в продукте, —
 * только найденный в собственных проверках.
 *
 * ПОЧЕМУ ОБХОД ОДИН. Три копии одного `readdirSync`-обхода разойдутся
 * так же, как разошлись карта подписей и перечисление в пункте
 * [label-is-the-choice]. */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/** Все .tsx экранов TMA. Тесты исключены: проверка не должна ловить
 * саму себя — за эту сессию так случалось шесть раз. */
export function screenFiles(src: string): string[] {
  return readdirSync(src).flatMap((name) => {
    const full = join(src, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : screenFiles(full);
    return name.endsWith('.tsx') ? [full] : [];
  });
}

/** Исходник без комментариев: объяснительный текст самой проверки и
 * цитаты «как было раньше» не должны считаться нарушением. */
export function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Экраны, где встречается образец, — относительными путями. */
export function screensMatching(src: string, pattern: RegExp): string[] {
  return screenFiles(src)
    .filter((f) => pattern.test(codeOf(f)))
    .map((f) => f.slice(src.length + 1));
}

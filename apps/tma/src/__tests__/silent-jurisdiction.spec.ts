// Сверка 2026-09-06, экранная половина — блок о законе исчезал молча.
//
// НАЙДЕННОЕ. Экран делал `if (!data) return null`, и для тридцати пар
// «домен + юрисдикция» из тридцати шести блок «Что говорит закон»
// пропадал целиком — включая ДТП и семейное право в Украине, всё
// здоровье и весь поиск работы. Комментарий соседнего компонента
// (`SectionLoadError`) к тому времени уже называл эту самую ошибку
// своими словами: «юридические ориентиры, исчезнувшие молча, читаются
// как „этот домен ничем не регулируется“». Там её закрыли для СБОЯ
// загрузки — и оставили для ПРОБЕЛА на том же экране.
//
// ВТОРОЕ: экран печатал «проверено 15.01.2026» и обещал «если она
// старше года, перепроверьте актуальность». Никто ничего не проверял в
// тот день — это дата, когда норму вписали в продукт; у всех ссылок
// она была одна и та же и не менялась ни разу. Порог «год» обещал
// процесс перепроверки, которого нет.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

/** Комментарии прочь: прежние формулировки процитированы и в шапке
 * этого файла, и в комментариях самого компонента. */
function code(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const DISCLAIMER = 'components/domains/DomainLegalDisclaimer.tsx';

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: пробел показывается, а не прячется', () => {
    const src = code(DISCLAIMER);
    assert(/ссылки не собраны/.test(src), 'пробел снова не назван на экране');
    assert(/не искали, а не искали и не нашли/.test(src), 'не сказано, чем пробел отличается от отсутствия норм');
    assert(/пробел продукта/.test(src), 'пробел не назван пробелом ПРОДУКТА');
    // Объявляемое: блок появляется сам при открытии экрана.
    assert(/role="status"/.test(src), 'сообщение о пробеле не объявляется вслух');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: пробел не подан как «закон тут ничего не регулирует»', () => {
    // Ровно та подмена, ради которой пункт и затеян: экран не должен
    // делать за продукт вывод о законе.
    const src = code(DISCLAIMER);
    const gapBlock = src.slice(src.indexOf('notResearched'), src.indexOf('return ('  , src.indexOf('notResearched')) + 1200);
    assert(!/норм нет|не регулируется(?!\.)/.test(gapBlock) || /не признак того/.test(gapBlock),
      'пробел читается как утверждение об отсутствии норм');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: «проверено» больше не обещается', () => {
    const src = code(DISCLAIMER);
    assert(!/проверено \{/.test(src), 'дата снова подана как дата проверки');
    assert(/вписано \{/.test(src), 'не сказано, что это дата записи');
    assert(/Это дата записи, а не проверки/.test(src), 'разница между записью и проверкой снова стёрта');
    // И прежнее успокаивающее обещание порога убрано.
    assert(!/старше года/.test(src), 'вернулся порог «год», обещающий перепроверку, которой нет');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: сказано, что делать перед тем, как опереться на норму', () => {
    // Честность без выхода — просто плохая новость.
    const src = code(DISCLAIMER);
    assert(/откройте источник сами/.test(src), 'не сказано, что делать с непроверенной нормой');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: сбой загрузки по-прежнему отличается от пробела', () => {
    // Три разных состояния — сбой, пробел, ссылки — и ни одно не
    // должно выглядеть как другое.
    const src = code(DISCLAIMER);
    assert(/<SectionLoadError/.test(src), 'сообщение о сбое загрузки пропало');
    assert(/failed\)/.test(src), 'состояние сбоя больше не различается');
    assert(src.indexOf('SectionLoadError') < src.indexOf('ссылки не собраны'), 'сбой перестал проверяться раньше пробела');
  }],

  ['ИЗМЕРЕНИЕ: экран не возвращает пустоту вместо блока о законе', () => {
    // `return null` остаётся ровно один — на состояние «ещё грузим»,
    // и оно приходит из `data === undefined`, а не из ответа сервера.
    const src = code(DISCLAIMER);
    const nulls = [...src.matchAll(/return null;/g)].length;
    assert(nulls === 1, `«return null» должен остаться один (загрузка), найдено ${nulls}`);
    assert(/if \(!data\) return null;/.test(src), 'состояние загрузки перестало различаться');
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
console.log(`\nsilent-jurisdiction: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

// Сверка 2026-09-05, панель — самоотчёт, показанный как сумма к оплате.
//
// НАЙДЕНО: оператор видел в строке заведения «N броней · M к оплате» —
// вид бухгалтерского факта. Обе цифры собраны из САМООТЧЁТОВ
// пользователей: любой нажимает «я забронировал это место», заведение об
// этом не знает и ничего не подтверждало, платёжной инфраструктуры в
// проекте нет. Про отсутствие платежей в шапке страницы было сказано
// честно; про происхождение самих чисел — ни слова там, где эти числа
// стоят, а читают их именно там.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function code(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const PAGE = 'app/moderation/venues/page.tsx';

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: числа названы отметками, а не бронями и не суммой к оплате', () => {
    const src = code(PAGE);
    assert(/отметок от/.test(src), 'счётчик снова называется «броней»');
    assert(/расчётно/.test(src), 'сумма снова названа «к оплате»');
    assert(!/> ?\{summaries\[venue\.id\]\.totalFeesOwed\.toFixed\(2\)\} к оплате/.test(src),
      'вернулась подпись «к оплате» вплотную к сумме');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: происхождение стоит РЯДОМ с числами, а не только в шапке', () => {
    // В шапке страницы про отсутствие платежей было сказано и раньше —
    // и это не помогло: читают строку заведения, а не введение.
    const src = code(PAGE);
    const row = src.slice(src.indexOf('distinctReporters'), src.indexOf('distinctReporters') + 900);
    assert(/Самоотчёты пользователей/.test(row), 'у чисел не сказано, откуда они');
    assert(/не подтверждённые заведением/.test(row), 'не сказано, что заведение их не подтверждало');
    assert(/Это не счёт/.test(row), 'не сказано, что это не счёт');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: видно, сколько РАЗНЫХ людей отметилось', () => {
    // Три отметки от одного человека и три от троих — разные вещи, а
    // выглядели одинаково.
    const src = code(PAGE);
    assert(/distinctReporters/.test(src), 'число разных отметившихся не показывается');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: заголовок столбца тоже не обещает бухгалтерии', () => {
    const src = code(PAGE);
    assert(!/<th>Брони \/ к оплате<\/th>/.test(src), 'заголовок столбца снова обещает счёт');
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
console.log(`\nself-reported-money: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

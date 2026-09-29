// Сверка 2026-09-24 — бюджет выдумывал валюту, а экран об этом молчал.
//
// КАК СВЕРКА ВЫРОСЛА ИЗ ПРЕДЫДУЩЕЙ. [draft-spoke-machine] убрал из
// документа машинные константы ролей. Здесь — та же форма на деньгах:
// слово `UNSPECIFIED` стояло на месте кода валюты и выходило и на
// экран жирной строкой, и в черновик для юриста.
//
// ДВЕ ЧАСТИ, И ЭКРАННАЯ ВАЖНЕЕ.
//
// 1. Заглушка вместо валюты. На экране она неотличима от настоящего
//    кода: человек видит корзину «UNSPECIFIED» и не понимает, что это
//    его же строки без указанной валюты.
//
// 2. Сравнение с целевым бюджетом считал САМ ЭКРАН:
//
//        const over = data.targetBudget !== null
//          && b.currency === (data.currency ?? b.currency)
//          && b.netBudget > data.targetBudget;
//
//    При незаданной валюте проекта средняя часть истинна ВСЕГДА — то
//    есть цель сравнивалась с корзиной ЛЮБОЙ валюты. А когда валюты
//    расходились, экран просто НИЧЕГО не показывал, и молчание
//    читалось как «в пределах бюджета». Это ровно та форма, которой
//    заняты последние сверки: пробел выглядит как определённость.
//
// СДЕЛАНО. Решение принимается на сервере, рядом с правилом о валютах,
// и «не с чем сравнивать» — отдельный ответ, который экран произносит
// вслух. Валюта, которой нет, названа словами.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function code(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const BUDGET_SCREENS = [
  'components/domains/shared/ConsultationPipeline.tsx',
  'components/domains/BudgetPanel.tsx',
];

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: экран не считает превышение бюджета сам', () => {
    for (const rel of BUDGET_SCREENS) {
      const source = code(rel);
      assert(
        !/netBudget\s*>\s*[\w.]*targetBudget/.test(source),
        `${rel}: сравнение с целевым бюджетом считается на экране. ` +
          'Правило о валютах живёт на сервере, и решение должно приниматься там же: ' +
          'иначе экран заново изобретает, какие валюты сравнимы.',
      );
    }
  }],

  ['валюта, которой нет, названа словами, а не кодом-заглушкой', () => {
    for (const rel of BUDGET_SCREENS) {
      const source = code(rel);
      if (!/b\.currency/.test(source)) continue;
      assert(
        /b\.currency \?\? 'валюта не указана'/.test(source),
        `${rel}: отсутствующая валюта выводится как есть. ` +
          'Человек увидит пустоту или служебное слово на месте кода валюты.',
      );
    }
  }],

  ['«не с чем сравнивать» сказано вслух, а не показано молчанием', () => {
    const source = code('components/domains/shared/ConsultationPipeline.tsx');
    assert(
      /not-comparable/.test(source) && /не сравнивается/.test(source),
      'Экран не объясняет, почему корзина не сравнена с целью. ' +
        'Молчание в этом месте читается как «в пределах бюджета».',
    );
  }],

  ['ОБРАТНАЯ ПРОБА: разбор действительно ловит расчёт на экране', () => {
    const offending = 'const over = b.netBudget > data.targetBudget;';
    assert(
      /netBudget\s*>\s*[\w.]*targetBudget/.test(offending),
      'Выражение перестало находить расчёт на экране — тогда первый тест ' +
        'проходит не потому, что расчёта нет, а потому, что его не ищут.',
    );
    assert(
      !/netBudget\s*>\s*[\w.]*targetBudget/.test('const over = b.targetComparison === "over";'),
      'Выражение находит лишнее: готовый ответ сервера — не расчёт на экране.',
    );
  }],

  ['подпись о заглушке в BudgetPanel исправлена, а не оставлена как была', () => {
    // Шапка экрана утверждала, что класс ошибок «суммирование, слепое к
    // валюте», учтён на сервере. Он был учтён в одном месте из четырёх.
    const raw = readFileSync(join(SRC, 'components/domains/BudgetPanel.tsx'), 'utf8');
    assert(
      /ПОПРАВКА, Пункт \[budget-invented-a-currency\]/.test(raw),
      'Утверждение о проверке, записанное внутри проверки, осталось без поправки — ' +
        'а именно оно и мешало увидеть изъян.',
    );
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
console.log(`\nbudget-invented-a-currency: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

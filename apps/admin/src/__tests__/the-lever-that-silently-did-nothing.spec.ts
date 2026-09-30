// Пункт [the-lever-that-silently-did-nothing] 2026-09-30 — потолки
// расходов на экране оператора.
//
// НАХОДКА. Реестр потолков живёт с 2026-09-24 и не читался НИ ОДНИМ
// экраном: оператор не мог узнать, какие потолки действуют на этом
// развёртывании. И хуже: неверное значение переменной падает на
// умолчание МОЛЧА — `AI_CALLS_PER_USER_PER_DAY=abc` давало то же «300»,
// что и невыставленная переменная, то есть рычаг можно было нажать и не
// узнать, что он не сработал.
//
// ЧТО ПРОВЕРЯЕТСЯ. Разметка, нарисованная во всех четырёх состояниях
// источника. Ключевое — что «не прочитано» ОТЛИЧИМО от «не задана»: если
// эти два случая выглядят одинаково, блок не решает задачи, ради которой
// заведён, сколько бы чисел он ни показывал.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SpendCeilingsCard } from '../components/SpendCeilingsCard';
import type { PublicWriteCeilingRow, SpendCeilingRow, SpendCeilingsState } from '../lib/types';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function row(over: Partial<SpendCeilingRow> = {}): SpendCeilingRow {
  return {
    what: 'Текстовые AI-вызовы одного пользователя',
    env: 'AI_CALLS_PER_USER_PER_DAY',
    value: 300,
    unit: 'вызовов в сутки',
    source: 'окружение',
    raw: '300',
    fallback: 300,
    costs: 'токены LLM-провайдера',
    off: false,
    ...over,
  };
}

function state(rows: SpendCeilingRow[], publicWrite: PublicWriteCeilingRow[] = []): SpendCeilingsState {
  const all = [...rows, ...publicWrite];
  return {
    rows,
    // Пункт [the-open-door-had-no-counter] 2026-09-30: у блока появилась
    // вторая таблица; её проверяет своя спека.
    publicWrite,
    publicWriteDoesNotDo: ['Счёта по IP нет.'],
    misconfigured: all.filter((r) => r.source === 'умолчание: значение не прочитано').length,
    off: all.filter((r) => r.off).length,
    doesNotKnow: ['Показано то, что продукт прочитал из окружения ЭТОГО процесса.'],
  };
}

function html(rows: SpendCeilingRow[]): string {
  return renderToStaticMarkup(createElement(SpendCeilingsCard, { state: state(rows) }));
}

const scenarios: Array<[string, () => void | Promise<void>]> = [
  ['проба механизма: блок рисуется и непуст', () => {
    const out = html([row()]);
    assert(out.length > 200, `разметка подозрительно короткая (${out.length}) — дальнейшие проверки ничего не значат`);
    assert(out.includes('Текстовые AI-вызовы'), 'названия потолка нет в разметке');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: «значение не прочитано» отличимо от «переменная не задана»', () => {
    const broken = html([row({ source: 'умолчание: значение не прочитано', raw: 'abc', value: 300 })]);
    const unset = html([row({ source: 'умолчание: переменная не задана', raw: null, value: 300 })]);
    assert(broken !== unset, 'два разных состояния нарисованы одинаково — блок не решает своей задачи');
    assert(broken.includes('НЕ ПРОЧИТАНО'), `состояние «не прочитано» не названо: ${broken.slice(0, 200)}`);
    assert(broken.includes('abc'), 'оператор не видит, ЧТО он написал в переменной');
    assert(!unset.includes('НЕ ПРОЧИТАНО'), 'невыставленная переменная выдана за ошибку настройки');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: об ошибке настройки сказано ДО таблицы, а не только в строке', () => {
    const out = html([row({ source: 'умолчание: значение не прочитано', raw: '-5' })]);
    assert(out.includes('Настроено с ошибкой: 1'), `сводной строки об ошибке нет: ${out.slice(0, 260)}`);
    assert(out.includes('рычаг нажат не был'), 'не сказано, ЧЕМ это отличается от «потолок не выставляли»');
  }],

  ['обратная проба: когда всё настроено верно, тревожных строк нет', () => {
    const out = html([row(), row({ what: 'Озвучка', env: 'TTS_CALLS_PER_USER_PER_DAY', value: 100 })]);
    assert(!out.includes('Настроено с ошибкой'), `тревога показана там, где ошибок нет: ${out.slice(0, 200)}`);
    assert(!out.includes('Снято совсем'), 'сказано о снятых потолках там, где их нет');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: ноль показан как «без потолка», а не как нулевой потолок', () => {
    const out = html([row({ value: 0, off: true })]);
    assert(out.includes('без потолка'), `ноль нарисован числом, а не смыслом: ${out.slice(0, 220)}`);
    assert(out.includes('Снято совсем потолков: 1'), 'снятый потолок не назван в сводке');
    assert(!out.includes('0 вызовов в сутки'), 'ноль показан как «0 вызовов в сутки» — противоположный смысл');
  }],

  ['зашитый потолок назван зашитым, а не умолчанием', () => {
    const out = html([row({ what: 'Поиск по YouTube', env: null, source: 'зашито в коде', raw: null, value: 20 })]);
    assert(out.includes('зашито в коде'), `зашитый потолок не отличён от умолчания: ${out.slice(0, 220)}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: потолки публичной записи показаны ОТДЕЛЬНОЙ таблицей, а не среди расходов', () => {
    const pw: PublicWriteCeilingRow = {
      what: 'Комментариев в одном обсуждении',
      env: 'PUBLIC_COMMENTS_PER_DISCUSSION',
      value: 1000,
      unit: 'в обсуждении',
      source: 'окружение',
      raw: '1000',
      fallback: 1000,
      costs: 'утёкшая ссылка наполняет обсуждение шумом',
      off: false,
      scope: 'обсуждение',
    };
    const out = renderToStaticMarkup(createElement(SpendCeilingsCard, { state: state([row()], [pw]) }));
    assert(out.includes('Потолки публичной записи'), 'второй таблицы нет вовсе');
    assert(out.includes('Комментариев в одном обсуждении'), 'потолок публичной записи не нарисован');
    assert(out.includes('Счёта по IP нет'), 'граница потолков публичной записи не показана оператору');
    // И не выдаётся за расходы: деньги тут ни при чём, и это сказано.
    assert(out.includes('Денег это не стоит'), 'не сказано, что публичная запись денег не стоит');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: ошибка настройки публичного потолка попадает в общую тревогу', () => {
    const broken: PublicWriteCeilingRow = {
      what: 'Участников в обсуждении',
      env: 'PUBLIC_PARTICIPANTS_PER_DISCUSSION',
      value: 200,
      unit: 'в обсуждении',
      source: 'умолчание: значение не прочитано',
      raw: 'много',
      fallback: 200,
      costs: 'шум',
      off: false,
      scope: 'обсуждение',
    };
    const out = renderToStaticMarkup(createElement(SpendCeilingsCard, { state: state([row()], [broken]) }));
    assert(out.includes('Настроено с ошибкой: 1'), `ошибка во второй таблице не попала в сводку: ${out.slice(0, 200)}`);
    assert(out.includes('много'), 'оператор не видит, что написал в публичном потолке');
  }],

  ['чего блок не знает — написано на экране, а не только в комментарии', () => {
    const out = html([row()]);
    assert(out.includes('прочитал из окружения'), 'граница блока не показана оператору');
  }],
];

void (async () => {
  let failed = 0;
  for (const [name, fn] of scenarios) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`✗ ${name}: ${(e as Error).message}`);
    }
  }
  if (failed > 0) process.exit(1);
})();

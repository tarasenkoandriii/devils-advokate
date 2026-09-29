// Пункт [deploy-step-did-nothing] 2026-09-26, экранная половина.
//
// Серверная — в `apps/api/src/__tests__`: там разбирается схема и
// сверяются имена таблиц. Здесь РИСУЕТСЯ карточка, которую читает
// оператор. Первая версия проверок этого не делала, и мутация «убрать
// число пропавших таблиц» прошла насквозь: экран админки не рисовала ни
// одна проверка проекта.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SchemaTablesCard } from '../components/SchemaTablesCard';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const NOT_CHECKED = [
  'колонки и их типы — совпадение имён таблиц не означает совпадения их содержимого',
  'индексы и ограничения: сверить их точно можно только по настоящей истории миграций',
];

function card(section: unknown): string {
  return renderToStaticMarkup(createElement(SchemaTablesCard as never, { section }));
}

const scenarios: Array<[string, () => void]> = [
  ['проба механизма: карточка рисуется и несёт содержимое', () => {
    const html = card({ missingInDatabase: [], unknownInSchema: [], declaredCount: 169, observedCount: 169, notChecked: NOT_CHECKED });
    assert(html.length > 200, `карточка нарисована пустой (${html.length}) — остальные проверки ничего не значат`);
    assert(html.includes('Таблицы схемы'), 'заголовка карточки нет');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: пропавшие таблицы названы ЧИСЛОМ и поимённо', () => {
    const html = card({
      missingInDatabase: [{ model: 'IntakeSession', table: 'intake_sessions' }, { model: 'VoiceEmbedding', table: 'voice_embeddings' }],
      unknownInSchema: [],
      declaredCount: 169,
      observedCount: 167,
      notChecked: NOT_CHECKED,
    });
    // Число: «нет в базе» без числа не отвечает на вопрос «насколько всё
    // плохо», а оператор читает это в момент, когда прод не работает.
    assert(/Нет в базе: 2 из 169/.test(html), `число пропавших не показано: ${html.slice(0, 400)}`);
    assert(html.includes('intake_sessions') && html.includes('IntakeSession'), 'таблица названа не и таблицей, и моделью');
    assert(/не работают целиком/.test(html), 'не сказано, чем это грозит');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: «всё совпало» показано вместе с числами, а не одним словом', () => {
    const html = card({ missingInDatabase: [], unknownInSchema: [], declaredCount: 169, observedCount: 169, notChecked: NOT_CHECKED });
    assert(/Объявлено в схеме: 169/.test(html), 'число объявленных не показано');
    assert(/Найдено в базе: 169/.test(html), 'число найденных не показано');
    assert(/Все объявленные таблицы в базе есть/.test(html), 'о совпадении не сказано словами');
    assert(!/Нет в базе/.test(html), 'при совпадении показана тревога');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: чего сверка не проверяет — на экране, рядом с результатом', () => {
    const html = card({ missingInDatabase: [], unknownInSchema: [], declaredCount: 1, observedCount: 1, notChecked: NOT_CHECKED });
    assert(html.includes('Чего эта сверка не проверяет'), 'границы сверки не показаны');
    for (const line of NOT_CHECKED) {
      assert(html.includes(line.slice(0, 30)), `строка границы не дошла: «${line.slice(0, 30)}…»`);
    }
    // Мутация «поставить hidden на блок» пережила первую версию: текст в
    // разметке оставался, а человек его не видел. Для читающего «скрыто»
    // и «отсутствует» — одно и то же, и проверка обязана мерить видимое.
    assert(!/<details[^>]*\shidden/.test(html), 'блок с границами сверки скрыт от оператора');
    assert(!/<(ul|li|p)[^>]*\shidden/.test(html), 'часть карточки скрыта от оператора');
  }],

  ['лишние таблицы в базе показаны отдельно от пропавших', () => {
    const html = card({ missingInDatabase: [], unknownInSchema: ['leftover_2026'], declaredCount: 1, observedCount: 2, notChecked: NOT_CHECKED });
    assert(html.includes('схема о них не знает'), 'о лишних таблицах не сказано');
    assert(html.includes('leftover_2026'), 'лишняя таблица не названа');
  }],

  ['обратная проба: «не смогли посмотреть» не выдаётся за «расхождений нет»', () => {
    const html = card({ error: 'permission denied for schema information_schema' });
    assert(html.includes('Не удалось сверить'), 'сбой сверки не назван сбоем');
    assert(html.includes('permission denied'), 'текст ошибки базы не показан — он и есть диагноз');
    assert(!/Все объявленные таблицы в базе есть/.test(html), 'сбой сверки выдан за совпадение');
  }],
];

void (async () => {
  let failed = 0;
  for (const [name, fn] of scenarios) {
    try {
      fn();
      console.log(`✓ ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`✗ ${name}: ${(e as Error).message}`);
    }
  }
  if (failed > 0) process.exit(1);
})();

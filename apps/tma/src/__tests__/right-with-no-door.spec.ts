// Пункт [right-with-no-door] 2026-09-25 — экран РИСУЕТСЯ, а не читается
// регулярками.
//
// Утверждение пункта — «человек может прочитать решения о себе, не
// скачивая файл». Это утверждение о том, что видно на экране, и
// проверяться оно обязано разметкой.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TruncatedListNotice } from '../components/TruncatedListNotice';
import {
  DecisionsAboutYouSection,
  DecisionRow,
  decisionMoment,
} from '../components/DecisionsAboutYou';
import type { DecisionsAboutYou, DescribedDecision } from '../lib/features';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const RESTRICTED: DescribedDecision = {
  action: 'user.restricted',
  what: 'Доступ к части возможностей ограничен',
  by: 'оператор продукта',
  resource: 'User',
  resourceId: 'u-1',
  at: '2026-09-20T09:15:00.000Z',
};

const UNKNOWN: DescribedDecision = {
  action: 'something.new',
  what: 'something.new — название действия не расшифровано, спросите поддержку',
  by: null,
  resource: 'User',
  resourceId: 'u-1',
  at: '2026-09-21T10:00:00.000Z',
};

const FROZEN: DescribedDecision = {
  action: 'admin.project.frozen',
  what: 'Проект заморожен',
  by: 'оператор продукта',
  resource: 'Project',
  resourceId: 'p-1',
  at: '2026-09-22T12:00:00.000Z',
};

function payload(over: Partial<DecisionsAboutYou> = {}): DecisionsAboutYou {
  return {
    accountDecisions: { items: [RESTRICTED], hasMore: false, limit: 200 },
    projectDecisions: { items: [FROZEN], hasMore: false, limit: 200 },
    // Пункт [door-opened-onto-a-corner] 2026-09-25: третья группа.
    belongingsDecisions: { items: [], hasMore: false, limit: 200 },
    outOfScope: [],
    ...over,
  };
}

function sectionHtml(decisions: DecisionsAboutYou | null): string {
  return renderToStaticMarkup(createElement(DecisionsAboutYouSection, { decisions }));
}

const scenarios: Array<[string, () => void]> = [
  ['проба механизма: раздел вообще рисуется и несёт содержимое', () => {
    const html = sectionHtml(payload());
    assert(html.length > 200, `раздел нарисован пустым (${html.length} знаков) — остальные проверки ничего не значат`);
    assert(html.includes('Что о вас решали'), 'заголовка раздела нет');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: решение о человеке читается на экране словами', () => {
    const html = sectionHtml(payload());
    assert(html.includes('Доступ к части возможностей ограничен'), 'решение об аккаунте не показано словами');
    assert(html.includes('оператор продукта'), 'не сказано, КЕМ решение принято');
    assert(html.includes('user.restricted'), 'машинное имя не показано — по нему человек говорит с поддержкой');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: решения о ПРОЕКТАХ показаны отдельно от решений об аккаунте', () => {
    const html = sectionHtml(payload());
    assert(html.includes('Проект заморожен'), 'решение о проекте не показано');
    const accountAt = html.indexOf('Об аккаунте');
    const projectAt = html.indexOf('О ваших проектах');
    assert(accountAt >= 0 && projectAt > accountAt, 'две группы решений не разделены');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: нерасшифрованное действие не переводится наугад', () => {
    // Рисуется ИМЕННО эта строка, а не весь раздел: первая версия
    // смотрела на разметку целиком и падала на соседней группе, где
    // автор решения известен и назван законно. Проверка обязана
    // касаться того же выражения, о котором утверждает.
    const html = renderToStaticMarkup(createElement(DecisionRow, { decision: UNKNOWN }));
    assert(html.includes('название действия не расшифровано'), 'оговорка о нерасшифрованном действии пропала');
    assert(html.includes('something.new'), 'машинное имя незнакомого действия не показано');
    // Кем принято — не выдумывается: у незнакомого действия этого никто
    // не знает, и «оператор продукта» здесь было бы утверждением.
    assert(!html.includes('оператор продукта'), 'у нерасшифрованного действия выдуман автор решения');
    // Обратная сторона: у знакомого действия автор назван.
    const known = renderToStaticMarkup(createElement(DecisionRow, { decision: RESTRICTED }));
    assert(known.includes('оператор продукта'), 'у знакомого действия автор решения не назван');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: обрезанный список говорит, что он обрезан', () => {
    const html = sectionHtml(payload({ accountDecisions: { items: [RESTRICTED], hasMore: true, limit: 200 } }));
    assert(/Показаны 200 самых новых решений/.test(html), 'обрезанный список выглядит полным');
    assert(/в журнале их больше/.test(html), 'подпись называет не то место, где решений больше');
  }],

  ['обратная проба: полный список о потолке молчит', () => {
    const html = sectionHtml(payload({ accountDecisions: { items: [RESTRICTED], hasMore: false, limit: 200 } }));
    assert(!/Показаны 200/.test(html) && !/список неполный/.test(html), 'подпись о потолке стоит там, где обрезки не было');
  }],

  ['общая подпись об обрезке осталась прежней там, где её не просили менять', () => {
    // Этот пункт добавил подписи необязательный параметр «где их
    // больше». Мутация «сменить ЗНАЧЕНИЕ ПО УМОЛЧАНИЮ» первую версию
    // проверок пережила: экраны, пользующиеся умолчанием, не проверял
    // никто, и текст на них молча поменялся бы вслед за моей правкой.
    const byDefault = renderToStaticMarkup(
      createElement(TruncatedListNotice, { hasMore: true, limit: 200, what: 'комментариев' }),
    );
    assert(byDefault.includes('в проекте их больше'), `умолчание подписи изменилось: ${byDefault}`);
    const explicit = renderToStaticMarkup(
      createElement(TruncatedListNotice, { hasMore: true, limit: 200, what: 'решений', where: 'в журнале' }),
    );
    assert(explicit.includes('в журнале их больше'), 'переданное место не попало в подпись');
    assert(renderToStaticMarkup(createElement(TruncatedListNotice, { hasMore: false, limit: 200, what: 'решений' })) === '',
      'подпись нарисована там, где обрезки не было');
  }],

  ['пустая группа говорит «не принималось», а не молчит', () => {
    const html = sectionHtml(payload({ accountDecisions: { items: [], hasMore: false, limit: 200 } }));
    assert(html.includes('Решений о вашем аккаунте не принималось'), 'пустая группа промолчала');
  }],

  ['заметка оператора на экран не попадает — её и не приходит', () => {
    const withNote = { ...RESTRICTED, note: 'рабочая заметка модератора' } as DescribedDecision & { note: string };
    const html = renderToStaticMarkup(createElement(DecisionRow, { decision: withNote }));
    assert(!html.includes('рабочая заметка'), 'заметка оператора просочилась на экран');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: календарный день называет клиент, а не строка сервера', () => {
    // Пункт [server-said-which-day]: сервер отдаёт момент, день называет
    // тот, у кого есть часовой пояс человека.
    const shown = decisionMoment('2026-09-20T09:15:00.000Z');
    assert(!shown.includes('T') && !shown.includes('Z'), `на экран ушёл ISO как есть: ${shown}`);
    assert(/\d/.test(shown), `момент не разобран вовсе: ${shown}`);
    const html = sectionHtml(payload());
    assert(!html.includes('2026-09-20T09:15:00.000Z'), 'ISO-строка показана человеку');
  }],

  ['обратная проба: неразбираемый момент показывается как есть, а не выдумывается', () => {
    assert(decisionMoment('не дата') === 'не дата', 'из мусора сделана дата');
  }],

  ['раздела нет, пока решения не загружены — вместо пустого «решений нет»', () => {
    // Пустой раздел до ответа сервера утверждал бы «решений не
    // принималось», не спросив об этом никого.
    assert(sectionHtml(null) === '', 'до загрузки раздел уже что-то утверждает');
  }],
  ['КЛЮЧЕВОЙ ТЕСТ [door-opened-onto-a-corner]: решения о записях человека — на экране', () => {
    // Пункт [door-opened-onto-a-corner] 2026-09-25: без этой группы
    // экран дотягивался до девяти расшифрованных действий из тридцати
    // четырёх — и пустой раздел при этом УТВЕРЖДАЛ, что решений не
    // принималось.
    const moderated: DescribedDecision = {
      action: 'library_entry.moderated',
      what: 'Заявка в библиотеку разборов рассмотрена',
      by: 'оператор продукта',
      resource: 'LibraryEntry',
      resourceId: 'lib-1',
      at: '2026-09-23T08:00:00.000Z',
    };
    const html = sectionHtml(payload({ belongingsDecisions: { items: [moderated], hasMore: false, limit: 200 } }));
    assert(html.includes('Заявка в библиотеку разборов рассмотрена'), 'решение о записи человека не показано');
    assert(html.includes('library_entry.moderated'), 'машинное имя решения о записи не показано');
    const idx = html.indexOf('О ваших записях');
    assert(idx > html.indexOf('О ваших проектах'), 'третья группа не выведена отдельно');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: граница области названа рядом с решениями, а не умолчана', () => {
    const html = sectionHtml(
      payload({ outOfScope: [{ resource: 'PromptVersion', why: 'внутреннее изменение продукта, а не решение о человеке' }] }),
    );
    assert(html.includes('Что сюда не входит'), 'о границе области не сказано');
    assert(html.includes('PromptVersion'), 'вид записи, который не входит, не назван');
    assert(html.includes('внутреннее изменение продукта'), 'причина невключения не показана');
  }],

  ['обратная проба: пустой список невходящего не рисует заголовок о границе', () => {
    const html = sectionHtml(payload({ outOfScope: [] }));
    assert(!html.includes('Что сюда не входит'), 'заголовок о границе стоит над пустотой');
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

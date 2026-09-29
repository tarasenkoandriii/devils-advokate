// Пункт [screen-said-what-server-unsaid] 2026-09-25 — проверка РИСУЕТ
// экран и читает разметку, а не ищет строки в исходнике.
//
// Дефект этого пункта именно такой формы: текст на экране РАСХОДИЛСЯ с
// текстом сервера. Проверка, читающая исходник экрана, расхождение и не
// заметила бы — она смотрела бы туда же, где лежит неправда.
//
// Единственное место, где этот файл читает исходники, — сверка списка
// ключей отчёта с серверным реестром: у двух приложений нет общего
// модуля, а требование «у каждого ключа есть подпись» осмысленно только
// против настоящего серверного списка, а не против выдуманного.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AccountDeletionReport,
  AccountDeletionSection,
  TakesFromOthers,
  WhatRemainsAfterDeletion,
  removedLines,
} from '../components/AccountDeletion';
import { DELETION_REPORT_LABEL, deletionReportLabel } from '../lib/field-labels';
import type { AccountDeletionResult } from '../lib/features';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const API_DELETION_REPORT = join(__dirname, '../../../api/src/privacy-center/deletion-report.ts');
const PRIVACY_PAGE = join(__dirname, '../app/privacy/page.tsx');

/** Серверный реестр ключей — как он записан в API. */
function serverRemovedKeys(): string[] {
  const src = readFileSync(API_DELETION_REPORT, 'utf8');
  // `indexOf('[')` здесь ловил бы скобки ТИПА (`readonly string[]`), а не
  // начало списка — первая версия так и сделала, вернула пустоту, и
  // проверка «ни один ключ не показывается латиницей» прошла впустую.
  // Поймано пробой механизма, которая для этого и стоит.
  const block = src.slice(src.indexOf('ACCOUNT_REMOVED_KEYS'));
  const body = block.slice(block.indexOf('= ['), block.indexOf('\n];'));
  return Array.from(body.matchAll(/'([^']+)'/g)).map((m) => m[1]);
}

/** Серверный список «что остаётся» — как он записан в API. */
function serverNotRemovedHere(): string[] {
  const src = readFileSync(API_DELETION_REPORT, 'utf8');
  const block = src.slice(src.indexOf('ACCOUNT_NOT_REMOVED_HERE'));
  const body = block.slice(block.indexOf('= ['), block.indexOf('\n];'));
  return Array.from(body.matchAll(/^\s*'(.+)',$/gm)).map((m) => m[1]);
}

/** Текст файла без комментариев — правило смотрит на то, что нарисуется,
 * а не на то, чем это объяснено в исходнике. */
function withoutComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/\s\/\/.*$/gm, ' ');
}

const FULL_RESULT: AccountDeletionResult = {
  deleted: true,
  removed: { projects: 4, conversations: 11, people: 3, consents: 6, intakeSessions: 0, mediaQueues: 0, aiInferences: 12, aiJobsCancelled: 2, aiJobsAnonymised: 2, auditEntriesScrubbed: 5 },
  externalArtifacts: { evidenceBlobs: 2, deleted: 2, failed: 1, conversationAudioBlobs: 7, sttJobsDiscarded: 3 },
  notRemovedHere: serverNotRemovedHere(),
  // Пункт [cascade-took-a-stranger] 2026-09-26: по умолчанию пусто —
  // числа последствий для других проверяются своей спекой.
  tookFromOthers: [],
  tookFromOthersNote: '',
};

function reportHtml(result: AccountDeletionResult = FULL_RESULT): string {
  return renderToStaticMarkup(createElement(AccountDeletionReport, { result }));
}

const scenarios: Array<[string, () => void | Promise<void>]> = [
  ['проба механизма: серверный файл вообще читается и непуст', () => {
    // Числа точные: молча усохший разбор прошёл бы проверку «> 0»,
    // оставив ключевые тесты почти пустыми.
    const keys = serverRemovedKeys();
    const lines = serverNotRemovedHere();
    assert(keys.length === 10, `реестр ключей с сервера разобран как ${keys.length} штук — дальнейшие проверки ничего не значат`);
    assert(lines.length === 6, `список «что остаётся» разобран как ${lines.length} строк`);
    assert(lines.every((l) => l.length > 60), 'строки списка разобраны обрывками');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: ни один ключ отчёта не доходит до человека машинным именем', () => {
    const keys = serverRemovedKeys();
    const naked = keys.filter((k) => deletionReportLabel(k) === k);
    assert(naked.length === 0, `ключи отчёта показываются латиницей: ${naked.join(', ')}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: экран показывает, что удаление НЕ затрагивает', () => {
    const html = reportHtml();
    for (const line of serverNotRemovedHere()) {
      const head = line.slice(0, 40);
      assert(html.includes(head), `строка сервера не дошла до экрана: «${head}…»`);
    }
  }],

  ['обратная проба: пустой список «что остаётся» не рисует заголовок над пустотой', () => {
    const html = renderToStaticMarkup(createElement(WhatRemainsAfterDeletion, { lines: [], title: 'Что остаётся:' }));
    assert(html === '', `над пустым списком нарисован заголовок: ${html}`);
    const filled = renderToStaticMarkup(createElement(WhatRemainsAfterDeletion, { lines: ['одна строка'], title: 'Что остаётся:' }));
    assert(filled.includes('Что остаётся:') && filled.includes('одна строка'), 'непустой список не нарисован');
  }],

  ['подпись вместо ключа — на нарисованной разметке, а не в словаре', () => {
    const html = reportHtml();
    assert(html.includes('сохранённых ответов AI'), 'подпись не применена к разметке');
    assert(!/aiInferences|aiJobsCancelled|auditEntriesScrubbed|mediaQueues/.test(html), 'машинный ключ дошёл до разметки');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: незнакомый ключ показывается КАК ЕСТЬ, а не подписью наугад', () => {
    // Честная граница пункта [machine-text]: придуманная подпись хуже
    // латиницы — она уверенно называет то, чего никто не проверял.
    // Мутация «подставить общее слово вместо неизвестного ключа»
    // пережила первую версию проверок: словарь проверялся по своим
    // ключам, а поведение на ЧУЖОМ — ничем.
    assert(deletionReportLabel('sttJobsDiscarded') === 'sttJobsDiscarded', 'незнакомому ключу придумана подпись');
    const html = reportHtml({ ...FULL_RESULT, removed: { чегоТоНовое: 3 } });
    assert(html.includes('чегоТоНовое'), 'незнакомый ключ не показан как есть');
    assert(!html.includes('не числилось'), 'незнакомый ключ выброшен вместе с отчётом');
  }],

  ['нули в отчёт не идут: «проектов: 0» об удалении не сообщает ничего', () => {
    const lines = removedLines({ projects: 4, intakeSessions: 0, mediaQueues: 0 });
    assert(lines.length === 1 && lines[0].key === 'projects', `нули просочились: ${lines.map((l) => l.key).join(', ')}`);
    // Обратная сторона: когда удалять было нечего, молчания не будет.
    const empty = reportHtml({ ...FULL_RESULT, removed: { projects: 0, people: 0 } });
    assert(empty.includes('не числилось'), 'пустой отчёт промолчал вместо того, чтобы сказать словами');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: следы у внешних сторон названы числами, а не потеряны типом', () => {
    const html = reportHtml();
    assert(/Транзитных аудиофайлов[^<]*7/.test(html), 'число транзитных аудиофайлов не показано');
    assert(/Задач распознавания[^<]*3/.test(html), 'число отозванных задач распознавания не показано');
    assert(/внешнем хранилище[^<]*1/.test(html), 'число неудалённых файлов не показано');
  }],

  ['обратная проба: нулевые следы у внешних сторон не выдумываются', () => {
    const html = reportHtml({
      ...FULL_RESULT,
      externalArtifacts: { evidenceBlobs: 0, deleted: 0, failed: 0, conversationAudioBlobs: 0, sttJobsDiscarded: 0 },
    });
    assert(!html.includes('Транзитных аудиофайлов'), 'отчёт сообщил о транзитных аудиофайлах, которых не было');
    assert(!html.includes('Задач распознавания'), 'отчёт сообщил об отозванных задачах, которых не было');
    assert(!html.includes('внешнем хранилище'), 'отчёт пожаловался на сбой, которого не было');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: экран не держит своей копии списка «что остаётся»', () => {
    // Дефект пункта — вторая копия текста, разошедшаяся с первой.
    // Проверяется не отсутствие слов, а отсутствие ВТОРОГО ИСТОЧНИКА:
    // у страницы не должно быть собственных предложений про журнал
    // аудита и провайдеров — она рисует то, что пришло с сервера.
    // Комментарии выброшены: правило — о том, что ЧИТАЕТ ЧЕЛОВЕК. Первый
    // прогон сработал на моём же объяснении в комментарии, то есть
    // измерял исходник, а не экран.
    const page = withoutComments(readFileSync(PRIVACY_PAGE, 'utf8'));
    // Запрещены не любые слова о провайдерах, а УТВЕРЖДЕНИЯ О ТОМ, ЧТО
    // ОСТАЁТСЯ: разошлась именно эта половина текста. Фраза о том, что
    // УДАЛЯЕТСЯ, остаётся на экране законно — иначе правило кричало бы
    // на всякое упоминание внешней стороны.
    const remainsClaims = [/остаются/i, /останутся/i, /оста[её]тся/i, /без персональных данных/i];
    const found = remainsClaims.filter((re) => re.test(page)).map((re) => re.source);
    assert(found.length === 0, `экран снова сам утверждает, что что-то остаётся: ${found.join(', ')}`);
    assert(/<AccountDeletionSection/.test(page), 'экран перестал рисовать раздел удаления');
  }],

  ['словарь подписей не разросся мимо серверного реестра', () => {
    const keys = new Set(serverRemovedKeys());
    const extra = Object.keys(DELETION_REPORT_LABEL).filter((k) => !keys.has(k));
    assert(extra.length === 0, `подписи заведены для ключей, которых сервер не отдаёт: ${extra.join(', ')}`);
  }],
  ['КЛЮЧЕВОЙ ТЕСТ: список «что остаётся» человек читает ДО решения, а не только после', () => {
    // Мутация «убрать список из состояния ДО удаления» пережила первую
    // версию этого правила: та требовала, чтобы ИМЯ компонента
    // встречалось в файле страницы, а импорт после удаления вызова
    // остаётся на месте. Теперь состояние РИСУЕТСЯ.
    const html = renderToStaticMarkup(
      createElement(AccountDeletionSection, {
        remains: serverNotRemovedHere(),
        result: null,
        intro: createElement('p', null, 'что удаляется'),
        form: createElement('button', null, 'Удалить аккаунт'),
      }),
    );
    assert(html.includes('Удалить аккаунт'), 'форма удаления пропала из раздела');
    for (const line of serverNotRemovedHere()) {
      assert(html.includes(line.slice(0, 40)), `до решения не сказано: «${line.slice(0, 40)}…»`);
    }
  }],

  ['обратная проба: после удаления раздел показывает отчёт, а не форму', () => {
    const html = renderToStaticMarkup(
      createElement(AccountDeletionSection, {
        remains: serverNotRemovedHere(),
        result: FULL_RESULT,
        intro: createElement('p', null, 'что удаляется'),
        form: createElement('button', null, 'Удалить аккаунт'),
      }),
    );
    assert(!html.includes('Удалить аккаунт'), 'форма удаления осталась после удаления аккаунта');
    assert(html.includes('Аккаунт удалён'), 'отчёт не показан');
  }],
  ['КЛЮЧЕВОЙ ТЕСТ [cascade-took-a-stranger]: последствия для ДРУГИХ показаны ДО решения', () => {
    // Пункт [cascade-took-a-stranger] 2026-09-26: удаление аккаунта
    // каскадом уносит рассказы других людей, отметки о бронировании и
    // комментарии приглашённых. Экран говорил только о том, что
    // ОСТАЁТСЯ, — человек решал, не зная последствий для тех, кого
    // продукт сам попросил написать.
    const losses = [
      { key: 'library-experiences', count: 2, text: '2 рассказов, написанных ДРУГИМИ людьми', why: 'привязаны к разбору' },
    ];
    const html = renderToStaticMarkup(
      createElement(AccountDeletionSection, {
        remains: serverNotRemovedHere(),
        takesFromOthers: losses,
        takesFromOthersNote: 'Это не ваши данные.',
        result: null,
        intro: createElement('p', null, 'что удаляется'),
        form: createElement('button', null, 'Удалить аккаунт'),
      }),
    );
    assert(html.includes('заберёт и то, что принадлежит другим'), 'о последствиях для других не сказано до решения');
    assert(html.includes('2 рассказов'), 'число чужого не показано');
    assert(html.includes('привязаны к разбору'), 'причина — почему это уносится — не показана');
    assert(html.includes('Это не ваши данные.'), 'приписка не показана');
    // И выше формы, а не под ней: ниже кнопки это была бы приписка
    // после решения.
    assert(html.indexOf('заберёт и то') < html.indexOf('Удалить аккаунт'), 'предупреждение стоит ниже кнопки');
  }],

  ['обратная проба: когда чужого нет — заголовка о чужом нет вовсе', () => {
    const html = renderToStaticMarkup(
      createElement(AccountDeletionSection, {
        remains: serverNotRemovedHere(),
        takesFromOthers: [],
        takesFromOthersNote: 'Это не ваши данные.',
        result: null,
        intro: createElement('p', null, 'что удаляется'),
        form: createElement('button', null, 'Удалить аккаунт'),
      }),
    );
    assert(!html.includes('заберёт и то'), 'заголовок о чужом нарисован над пустотой');
    assert(!html.includes('Это не ваши данные.'), 'приписка нарисована без списка');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ [cascade-took-a-stranger]: отчёт после удаления называет, что забрало у других', () => {
    const html = reportHtml({
      ...FULL_RESULT,
      tookFromOthers: [{ key: 'venue-bookings', count: 4, text: '4 отметок о бронировании ДРУГИХ людей', why: 'привязаны к карточке заведения' }],
      tookFromOthersNote: 'Вернуть их нельзя.',
    });
    assert(html.includes('удалено то, что принадлежит другим'), 'отчёт молчит о чужом');
    assert(html.includes('4 отметок'), 'число в отчёте не показано');
    assert(html.includes('Вернуть их нельзя.'), 'приписка отчёта не показана');
  }],

  ['подпись у пустого списка последствий не рисуется и сама по себе', () => {
    assert(renderToStaticMarkup(createElement(TakesFromOthers, { losses: [], note: 'п', title: 'т' })) === '',
      'пустой список последствий что-то нарисовал');
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

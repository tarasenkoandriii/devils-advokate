// Пункт [computed-for-the-person-never-shown] 2026-09-30 — продукт
// составлял текст для человека и не показывал его.
//
// Три места, и все три завели ПРЕДЫДУЩИЕ сверки — каждая ради того,
// чтобы продукт не молчал там, где молчание читается как «всё в
// порядке»:
//
//   [one-of-several-spoke-for-all] — `companyChoice`: «компаний
//     несколько, выбрать за вас продукт не станет». Экран показывал
//     прочерк в поле «Компания» и ни слова о причине.
//   [job-domain-v2] — `historyDisclaimer`: «эти данные с собеседования
//     на другую вакансию». Ответ добавления кандидата выбрасывался в
//     клиенте ЦЕЛИКОМ, вместе с предупреждением.
//   [revocation-not-one-rule] — строка кандидата, отозвавшего согласие:
//     сервер оставлял её НАМЕРЕННО и клал рядом объяснение, «чтобы
//     исчезнувший без следа человек не выглядел как сбой». Экран рисовал
//     строку из одних прочерков и объяснения не показывал.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Разметка, нарисованная с данными и без них: с
// текстом он виден, без текста заголовка над пустотой нет. Это то, что
// собственный раннер умеет — он рисует статически, клика не делает.
//
// ЧЕГО НЕ ПРОВЕРЕНО. Шов «обработчик положил ответ в состояние» не
// нажимается: клика нет. Проверено то, что можно, — что ОБА пути
// добавления кандидата ответ читают; что прочитанное попадает именно в
// ту переменную, держит только сборка. Это тот же непокрытый шов, что
// назван в пункте 11 списка владельца, и закрывается он тем же
// DOM-рендерером, а не припиской здесь.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HistoryDisclaimer } from '../components/domains/InterviewPoolWorkspace';
import { CandidateCell, RevokedRowsNote } from '../components/domains/hiring/TeamPanels';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const DISCLAIMER = 'Эти данные — с собеседования на другую вакансию («Бариста»).';

function disclaimerHtml(text: string | null): string {
  return renderToStaticMarkup(createElement(HistoryDisclaimer, { text, onClose: () => undefined }));
}

const scenarios: Array<[string, () => void | Promise<void>]> = [
  ['проба механизма: разметка вообще рисуется и непуста', () => {
    const html = disclaimerHtml(DISCLAIMER);
    assert(html.length > 40, `разметка подозрительно короткая (${html.length}) — дальнейшие проверки ничего не значат`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: предупреждение «история с другой вакансии» доходит до человека дословно', () => {
    const html = disclaimerHtml(DISCLAIMER);
    assert(html.includes(DISCLAIMER), `текста предупреждения нет в разметке: ${html.slice(0, 160)}`);
    assert(html.includes('role="status"'), 'предупреждение не объявлено сообщением для средств доступности');
  }],

  ['обратная проба: без предупреждения пустой плашки не рисуется', () => {
    assert(disclaimerHtml(null) === '', `нарисовано что-то при отсутствии текста: ${disclaimerHtml(null)}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: ответ добавления кандидата больше не выбрасывается', () => {
    // Шов между сетью и состоянием раннер не нажмёт (клика нет), поэтому
    // проверяется то, что проверить можно: обработчик ЧИТАЕТ ответ и
    // кладёт из него именно это поле. Мутация «перестать читать ответ»
    // роняет эту проверку; мутация «положить не туда» — нет, и это
    // названо честно, а не закрашено зелёным.
    const src = readFileSync(join(__dirname, '..', 'components', 'domains', 'InterviewPoolWorkspace.tsx'), 'utf8');
    const handlers = src.split('async function').filter((b) => b.startsWith(' addExisting') || b.startsWith(' createAndAdd'));
    assert(handlers.length === 2, `обработчиков добавления кандидата не два, а ${handlers.length}`);
    const reading = handlers.filter((h) => h.includes('historyDisclaimer')).length;
    assert(reading === 2, `ответ читают ${reading} обработчика из двух — один из путей добавления снова выбрасывает предупреждение`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: «компаний несколько» нарисовано на хабе работодателя', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'domains', 'employer-hiring', 'EmployerHiringWorkspace.tsx'), 'utf8');
    const rendered = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    assert(rendered.includes('{state.companyChoice}'), 'значение companyChoice не попадает в разметку хаба');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: пустая строка матрицы объяснена, а не оставлена прочерками', () => {
    const REASON = 'Кандидат отозвал согласие — покрытие требований по нему не пересобирается.';
    const html = renderToStaticMarkup(
      createElement(CandidateCell, { row: { displayName: 'И. И.', stage: 'SCREENING', consentRevoked: true, note: REASON, openQuestions: [] } }),
    );
    assert(html.includes(REASON), `причины пустой строки нет в разметке: ${html}`);
  }],

  ['обратная проба: у обычной строки объяснения про отзыв нет, а «не обсуждено» есть', () => {
    const html = renderToStaticMarkup(
      createElement(CandidateCell, { row: { displayName: 'П. П.', stage: 'SCREENING', openQuestions: ['зарплата', 'формат'] } }),
    );
    assert(!html.includes('отозвал'), `объяснение про отзыв появилось там, где отзыва нет: ${html}`);
    assert(html.includes('не обсуждено: 2'), `число необсуждённого не нарисовано: ${html}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: число пустующих строк доходит до человека', () => {
    const html = renderToStaticMarkup(createElement(RevokedRowsNote, { count: 3 }));
    assert(html.includes('3'), `числа нет в разметке: ${html}`);
    assert(html.includes('не пробел в данных'), `объяснения, что это не пробел, нет: ${html}`);
  }],

  ['обратная проба: когда пустующих строк нет — плашки нет вовсе', () => {
    assert(renderToStaticMarkup(createElement(RevokedRowsNote, { count: 0 })) === '', 'плашка нарисована при нуле');
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

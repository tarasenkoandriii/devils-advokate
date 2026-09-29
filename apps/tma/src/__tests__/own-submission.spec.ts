// Сверка 2026-09-04 — что экран говорит человеку о судьбе того, что он
// отправил.
//
// НАЙДЕННОЕ.
//
//  1. Экран отправки в библиотеку УТВЕРЖДАЛ: «уже отправлен в публичную
//     библиотеку — ожидает модерации ИЛИ УЖЕ ОПУБЛИКОВАН». Два исхода из
//     трёх; не хватало ровно одного — отклонения, единственного плохого.
//     И проверить было нечем: `submittedByUserId` записывался при
//     создании и не читался НИГДЕ во всём проекте.
//  2. У заявок заведений список «мои заявки» на сервере был С САМОГО
//     НАЧАЛА и не вызывался никем: ни обёртки в клиенте, ни экрана.
//     Готовый бэкенд с нулевым UI — та же форма, что в Пунктах 27 и 28.
//     После отправки человек видел «появится в каталоге после
//     одобрения» и, закрыв страницу, терял и это.
//  3. Правило в продукте УЖЕ есть и работает: публичное обсуждение
//     показывает участнику статус его заявки прямо словами — «на
//     рассмотрении у автора», «принято автором», «отклонено автором».
//     Снова знакомый вид: правило было, просто не везде.
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Причины отклонения продукт не хранит — колонки
// под неё нет ни у записи библиотеки, ни у заявки заведения (записано
// отдельным пунктом в `TODO.md`). Экран говорит об этом прямо: пробел в
// продукте не должен выглядеть как отсутствие причины у решения.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { librarySubmissionOutcome, venueApplicationOutcome, decidedOn } from '../lib/submission-status';
import { MyVenueApplicationsView } from '../components/MyVenueApplications';
import { LibrarySubmissionStatusView } from '../components/LibrarySubmitSection';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/** Комментарии прочь перед разбором КОДА: за эту сессию проверки ловили
 * собственный объяснительный текст пять раз. Здесь это особенно легко —
 * старые формулировки процитированы в комментариях как «было раньше». */
function code(rel: string): string {
  return read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: у отправки ТРИ исхода, и отклонение названо', () => {
    // Прежний текст знал два: «ожидает модерации или уже опубликован».
    const pending = librarySubmissionOutcome('PENDING', null);
    const accepted = librarySubmissionOutcome('ACCEPTED', '2026-08-01T00:00:00Z');
    const rejected = librarySubmissionOutcome('REJECTED', '2026-08-01T00:00:00Z');

    assert(/рассмотрени/i.test(pending.label), 'исход «ждёт» не назван');
    assert(/Опубликовано/.test(accepted.label), 'исход «опубликовано» не назван');
    assert(/Отклонено/.test(rejected.label), 'ОТКЛОНЕНИЕ снова не названо — это был единственный скрытый исход');
    assert(!pending.decided && accepted.decided && rejected.decided, 'решённое и нерешённое перепутаны');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: продукт не придумывает причину, которой у него нет', () => {
    // Причина решения нигде не хранится. Сказать это прямо честнее, чем
    // подставить пустоту или бодрое «свяжитесь с нами»: пробел в
    // продукте не должен выглядеть как отсутствие причины у решения.
    for (const outcome of [librarySubmissionOutcome('REJECTED', null), venueApplicationOutcome('REJECTED', null)]) {
      assert(/не сохраня|не указана/.test(outcome.detail), 'об отсутствии причины не сказано');
      assert(!/свяжитесь|поддержк|напишите нам/i.test(outcome.detail), 'назван способ связи, которого в продукте нет');
    }
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: сказано и то, чего отклонение НЕ делает', () => {
    // Без второй половины «отклонено» читается как «всё пропало»: та же
    // ошибка, что закрыта в Пункте [candidate-rights].
    const lib = librarySubmissionOutcome('REJECTED', null);
    assert(/проект и его аргументы не тронуты/.test(lib.detail), 'не сказано, что сам проект цел');
    const venue = venueApplicationOutcome('REJECTED', null);
    assert(/Заявка сохранена/.test(venue.detail), 'не сказано, что стало с самой заявкой');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: даты, которой нет, не показывается «Invalid Date»', () => {
    assert(decidedOn(null) === '', 'пустая дата превратилась во что-то');
    assert(decidedOn('не дата') === '', '«Invalid Date» попал в текст человеку');
    assert(decidedOn('2026-08-01T00:00:00Z').trim().length > 0, 'настоящая дата решения потерялась');
    for (const o of [librarySubmissionOutcome('REJECTED', 'мусор'), venueApplicationOutcome('APPROVED', 'мусор')]) {
      assert(!/Invalid/.test(o.label), '«Invalid Date» в заголовке исхода');
    }
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: список своих заявок РИСУЕТСЯ вместе с исходом', () => {
    // Урок [render-guards]: проверка на упоминание текста в исходнике
    // проходит и у полностью выключенного экрана. Поэтому экран
    // рисуется по-настоящему, с данными.
    const rows = [{
      id: 'a1', submittedByUserId: 'me', name: 'Кафе Тихое', address: 'ул. Примерная, 1',
      phone: null, openingHours: [], googlePlaceId: null, photoReferences: [],
      status: 'REJECTED' as const, moderatedAt: '2026-08-01T00:00:00Z', createdAt: '2026-07-01T00:00:00Z',
    }];
    const shown = renderToStaticMarkup(createElement(MyVenueApplicationsView, { rows, failed: false }));
    assert(/Кафе Тихое/.test(shown), 'заявка не показана');
    assert(/Отклонено/.test(shown), 'исход заявки не показан — ровно то, чего человек не мог узнать');
    assert(/не сохраня|не указана/.test(shown), 'на экране не сказано, что причины у продукта нет');

    // До ответа сервера экран не утверждает ничего.
    assert(renderToStaticMarkup(createElement(MyVenueApplicationsView, { rows: null, failed: false })) === '',
      'до ответа сервера экран уже утверждает что-то о заявках');
    // Пустой список — это «заявок нет», а сбой связи — другое.
    const broken = renderToStaticMarkup(createElement(MyVenueApplicationsView, { rows: null, failed: true }));
    assert(/сбой связи, а не отсутствие заявок/.test(broken), 'сбой связи снова выдаётся за отсутствие заявок');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: экран отправки РИСУЕТ настоящий исход, а не два из трёх', () => {
    // Мутация: имя функции исхода оставалось в строке импорта, поэтому
    // проверка исходника проходила и у полностью выключенного исхода.
    // Теперь экран рисуется.
    const submission = {
      id: 'e1', title: 'Т', category: 'к',
      status: 'REJECTED' as const, moderatedAt: '2026-08-01T00:00:00Z',
      createdAt: '2026-07-01T00:00:00Z', sourceProjectId: 'p1',
    };
    const shown = renderToStaticMarkup(
      createElement(LibrarySubmissionStatusView, { submission, statusFailed: false }),
    );
    assert(/Отклонено/.test(shown), 'отклонение снова не показано — это был единственный скрытый исход');
    assert(/не сохраня|не указана/.test(shown), 'не сказано, что причины у продукта нет');
    assert(!/ожидает модерации или уже опубликован/.test(shown), 'вернулось утверждение о двух исходах из трёх');

    // «Не знаем» и «нет решения» — разные утверждения.
    const broken = renderToStaticMarkup(
      createElement(LibrarySubmissionStatusView, { submission: null, statusFailed: true }),
    );
    assert(/не удалось|не отвечает сервер/i.test(broken), 'сбой загрузки состояния выдаётся за «ждёт модерации»');

    // А вот ЭТА половина проверяется по исходнику, и честно сказать
    // почему: эффекты при статичной отрисовке не выполняются, поэтому
    // «сходил ли экран на сервер» нарисовать нельзя. Мутация показала
    // цену слабой формулировки: `if (false) loadStatus()` проходил
    // проверку на упоминание имени функции — оно оставалось в импорте.
    // Поэтому проверяется само условие, а не наличие слова.
    const src = code('components/LibrarySubmitSection.tsx');
    assert(/listMyLibrarySubmissions/.test(src), 'экран снова не спрашивает сервер о судьбе отправки');
    assert(/useEffect\(\(\) => \{\s*if \(submitted\) loadStatus\(\);/.test(src),
      'запрос состояния отключён: экран показывает исход, которого не спрашивал');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: список своих заявок заведений подключён к экрану', () => {
    // На сервере он был с самого начала, и его не вызывал никто.
    const client = code('lib/features.ts');
    assert(/venue-applications\/mine/.test(client), 'обёртки для «моих заявок» снова нет');
    const page = code('app/venues/apply/page.tsx');
    assert(/<MyVenueApplications/.test(page), 'экран заявки снова не показывает свои заявки');
    // И на экране «заявка отправлена» тоже: раньше человек, закрыв
    // страницу, терял единственное упоминание о ней.
    assert((page.match(/<MyVenueApplications/g) ?? []).length === 2,
      'после отправки заявку по-прежнему негде найти');
  }],

  ['ИЗМЕРЕНИЕ: правило в продукте есть — публичное обсуждение показывает исход словами', () => {
    // Точка отсчёта для следующей сверки: тут было правильно ДО этого
    // захода, и именно поэтому «просто не везде» — верное описание.
    const src = read('app/public/[token]/page.tsx');
    for (const word of ['PENDING', 'ACCEPTED', 'REJECTED']) {
      assert(new RegExp(`s\\.status === '${word}'`).test(src), `публичное обсуждение перестало показывать ${word}`);
    }
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
console.log(`\nown-submission: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

// Пункт [zero-was-a-failure] 2026-09-30 — ноль, который был сбоем.
//
// НАЙДЕННОЕ, два места, оба в блоках, которые человек читает как ФАКТЫ
// о своём деле.
//
//  1. Вкладка «Обзор» карточки ДТП. Три загрузки стояли с
//     `.catch(() => [])` и `?? 0` поверх них, и сбой любой из трёх
//     печатался жирными цифрами: «Участников 0 · Доказательств 0 ·
//     Консультантов 0». Ни пометки, ни `role="alert"`. Остальные
//     вкладки того же воркспейса построены честно — `useDtpList` отдаёт
//     `error`, и панели его показывают; не показывала ровно та вкладка,
//     которая открывается первой и на которую человек смотрит, решая,
//     собрал ли он доказательства для страховой.
//
//  2. Блок «Что ещё стоит рассказать» в онбординге домена (и его
//     двойник в онбординге работодателя). `.catch(() => null)` — и блок
//     просто НЕ ПОЯВЛЯЛСЯ. Онбординг выглядел законченным, потому что
//     исчез ровно тот блок, который сказал бы, чего не хватает.
//
// ПОЧЕМУ ЭТО ЗДЕСЬ, А НЕ В `silent-failure-conventions`. То правило —
// о форме записи: оно требует, чтобы молчание было объяснено, и
// расширено этим же заходом на формы `.catch(() => [] | null | ...)`.
// Оно НЕ МОЖЕТ проверить, что на экране вместо нуля появился прочерк, —
// это свойство РАЗМЕТКИ, и проверяется оно рендером. Обе мутации
// («вернуть `?? 0`», «вернуть `.catch(() => null)`») правило по форме
// переживали: причина-то написана.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DtpOverview } from '../components/domains/dtp/DtpPanels';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const CONFIG: any = {
  id: 'c1',
  occurredAt: new Date('2026-09-01T10:00:00Z').toISOString(),
  targetBudget: 1000,
  currency: 'UAH',
  goalDescription: 'Договориться со страховой',
  criteria: [],
};

function overviewHtml(counts: { participants: number | null; evidence: number | null; advisors: number | null }): string {
  return renderToStaticMarkup(createElement(DtpOverview, { config: CONFIG, counts }));
}

const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

const scenarios: Array<[string, () => void]> = [
  ['проба механизма: обзор вообще рисуется и несёт числа', () => {
    const html = overviewHtml({ participants: 2, evidence: 5, advisors: 1 });
    assert(html.includes('Участников'), `разметка не нарисована: ${html.slice(0, 200)}`);
    assert(html.includes('>2<') && html.includes('>5<') && html.includes('>1<'), `числа не показаны: ${html}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: не загруженное число показано прочерком, а не нулём', () => {
    const html = overviewHtml({ participants: null, evidence: null, advisors: null });
    assert(!/>0</.test(html), `сбой загрузки напечатан нулём: ${html}`);
    assert((html.match(/—/g) ?? []).length >= 3, `прочерков меньше трёх: ${html}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: и сказано словами, что прочерк — это не ноль', () => {
    const html = overviewHtml({ participants: null, evidence: 2, advisors: 1 });
    assert(html.includes('role="alert"'), `о сбое не объявлено: ${html}`);
    assert(html.includes('Это не ноль'), `не сказано, что прочерк — не ноль: ${html}`);
    // И частичный сбой не прячет то, что загрузилось.
    assert(html.includes('>2<'), 'загруженное число потеряно вместе с незагруженным');
  }],

  ['обратная проба: когда всё загрузилось — ни прочерка, ни плашки', () => {
    const html = overviewHtml({ participants: 0, evidence: 0, advisors: 0 });
    assert(!html.includes('role="alert"'), `плашка о сбое нарисована без сбоя: ${html}`);
    assert(!html.includes('Это не ноль'), 'человека напугали без причины');
    // Настоящий ноль — это ответ, и он обязан быть виден как ноль.
    assert((html.match(/>0</g) ?? []).length >= 3, `настоящий ноль не показан: ${html}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: сбой чек-листа онбординга доходит до человека обоими путями', () => {
    // Рендер здесь не поставить: оба компонента — страницы со своими
    // загрузками, и собственный раннер клика не делает. Проверяется то,
    // что проверить можно: ОБА пути ставят признак сбоя И читают его в
    // разметке рядом с подписью. Мутация «вернуть `.catch(() => null)`»
    // роняет первую половину, мутация «убрать плашку» — вторую.
    for (const rel of [
      'components/domains/DomainOnboarding.tsx',
      'components/domains/employer-hiring/EmployerOnboardingPanel.tsx',
    ]) {
      const code = src(rel);
      // Именно ЭТА форма, а не наличие имени флага: мутация «вернуть
      // `.catch(() => null)`» оставляет `setChecklistFailed(clFailed)`
      // на месте, только `clFailed` больше никогда не становится
      // `true` — слово есть, поведения нет. Первая версия этой
      // проверки мутацию пережила.
      assert(
        /\.catch\(\(\)\s*=>\s*\{[^}]*clFailed\s*=\s*true/.test(code),
        `${rel}: обработчик сбоя чек-листа не выставляет признак — слово есть, поведения нет`,
      );
      assert(code.includes('setChecklistFailed(clFailed)'), `${rel}: признак не доходит до состояния`);
      assert(code.includes('{checklistFailed && ('), `${rel}: признак сбоя чек-листа никто не читает`);
      assert(
        code.includes('список «что ещё стоит рассказать»'),
        `${rel}: человеку не сказано, ЧТО не загрузилось`,
      );
      assert(
        code.includes('Онбординг может выглядеть законченным'),
        `${rel}: не сказано главное — что законченный вид ничего не значит`,
      );
    }
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

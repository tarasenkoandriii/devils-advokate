// Пункт [project-deletion-took-a-stranger] 2026-09-30 — чужие потери на
// экране удаления проекта.
//
// НАХОДКА. Шапка этого экрана сама ставит правило: «Что именно исчезнет
// — сказано ДО нажатия, а не после. Человек решает по этому тексту». А
// текст перечислял только СВОЁ. Вместе с проектом исчезают слова
// приглашённых в обсуждение, отчёты, переданные заказчику, и запись о
// договорённости у агентства.
//
// ЧТО ПРОВЕРЯЕТСЯ. Разметка списка потерь, нарисованная с данными и без.
// Пустой список не должен рисовать заголовок: «удаление заберёт у
// других:» над пустотой — само по себе утверждение, и неверное.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DeletionConfirmNotice, DeletionReport, ThirdPartyLosses } from '../components/ProjectDeletionSection';
import type { ProjectDeletionResult, ProjectLoss } from '../lib/features';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const LOSS: ProjectLoss = {
  key: 'discussion-comments',
  count: 3,
  text: '3 комментариев, написанных людьми, которых вы пригласили в обсуждение по ссылке',
  why: 'обсуждение живёт внутри проекта и удаляется вместе с ним',
};

const NOTE = 'Это не ваши данные, и вернуть их будет нельзя.';

function html(losses: ProjectLoss[]): string {
  return renderToStaticMarkup(
    createElement(ThirdPartyLosses, { losses, note: NOTE, title: 'Удаление заберёт и у других людей:' }),
  );
}

const SECTION = join(__dirname, '..', 'components', 'ProjectDeletionSection.tsx');

const scenarios: Array<[string, () => void | Promise<void>]> = [
  ['проба механизма: разметка рисуется и непуста', () => {
    const out = html([LOSS]);
    assert(out.length > 120, `разметка подозрительно короткая (${out.length}) — дальнейшие проверки ничего не значат`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: чужая потеря названа числом, словами и причиной', () => {
    const out = html([LOSS]);
    assert(out.includes(LOSS.text), `текста потери нет в разметке: ${out.slice(0, 200)}`);
    assert(out.includes(LOSS.why), 'причина потери не показана — человек не узнает, ПОЧЕМУ это уносится');
    assert(out.includes(NOTE), 'приписки «вернуть нельзя» нет');
  }],

  ['обратная проба: пустой список не рисует заголовка над пустотой', () => {
    assert(html([]) === '', `нарисовано что-то при отсутствии потерь: ${html([])}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: перед подтверждением чужие потери НАРИСОВАНЫ, а не только запрошены', () => {
    const withLosses = renderToStaticMarkup(
      createElement(DeletionConfirmNotice, {
        takes: { losses: [LOSS], note: NOTE },
        previewFailed: false,
      }),
    );
    assert(withLosses.includes(LOSS.text), `перед подтверждением чужих потерь не видно: ${withLosses.slice(0, 260)}`);
    assert(withLosses.includes('Отменить это нельзя'), 'исчез основной текст подтверждения');
  }],

  ['обратная проба: пока потери не посчитаны — в подтверждении их нет, но и лишнего нет', () => {
    const plain = renderToStaticMarkup(createElement(DeletionConfirmNotice, { takes: null, previewFailed: false }));
    assert(plain.includes('Отменить это нельзя'), 'основной текст подтверждения пропал');
    assert(!plain.includes('заберёт и у других'), 'заголовок о чужом показан до того, как что-то посчитано');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: отчёт ПОСЛЕ удаления называет, что забрало у других', () => {
    const result: ProjectDeletionResult = {
      deleted: true,
      notRemovedHere: ['Записи о согласиях остаются.'],
      tookFromOthers: [LOSS],
      tookFromOthersNote: NOTE,
    };
    const out = renderToStaticMarkup(createElement(DeletionReport, { result }));
    assert(out.includes(LOSS.text), `в отчёте нет того, что удаление забрало: ${out.slice(0, 260)}`);
    assert(out.includes('Записи о согласиях остаются.'), 'список «что переживает удаление» пропал из отчёта');
  }],

  ['обратная проба: когда чужого не забрали — в отчёте об этом ни слова', () => {
    const result: ProjectDeletionResult = {
      deleted: true,
      notRemovedHere: ['Записи о согласиях остаются.'],
      tookFromOthers: [],
      tookFromOthersNote: NOTE,
    };
    const out = renderToStaticMarkup(createElement(DeletionReport, { result }));
    assert(!out.includes('забрало у других'), `заголовок о чужом показан там, где чужого нет: ${out.slice(0, 200)}`);
    assert(out.includes('Записи о согласиях остаются.'), 'остальной отчёт пропал вместе с ним');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: неудача подсчёта не выдаётся за «чужого нет»', () => {
    const failed = renderToStaticMarkup(createElement(DeletionConfirmNotice, { takes: null, previewFailed: true }));
    assert(failed.includes('Не удалось посчитать'), 'молчание при ошибке предпросмотра читается как «ничего не заберёт»');
    assert(failed.includes('Это не значит «ничего»'), 'разница между «ничего» и «не посчитали» не названа человеку');

    const src = readFileSync(SECTION, 'utf8');
    assert(src.includes('projectDeletionPreview'), 'предпросмотр у сервера не спрашивается вовсе');
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

// Сверка [the-refusal-was-swallowed-midway] 2026-10-26, половина
// панели — оператор узнаёт, ПОЧЕМУ рейтинга в снимке нет.
//
// НАЙДЕНО НА СЕРВЕРЕ (серверная сверка —
// `apps/api/src/__tests__/audit-2026-10-26-the-refusal-was-swallowed-
// midway.spec.ts`): одобрение заявки делало снимок рейтинга Google, а
// один `try … catch { rating = null }` накрывал три совершенно разные
// причины — ключ не настроен, провайдер не ответил и ОТКАЗ СУТОЧНОГО
// ПОТОЛКА на обращения к картам. Первые две оператор исправить не
// может. Третья — решение продукта с текстом и сроком, и расход
// считается НА ОПЕРАТОРА: достаточно было подождать и одобрить позже.
//
// ПОЧЕМУ ЭТО ДОРОГО ИМЕННО ЗДЕСЬ. Снимок делается ОДИН РАЗ: заявка
// уходит в APPROVED, повторной модерации не будет, и публичная карточка
// остаётся без рейтинга навсегда. Молчание стоило не «неудобства», а
// данных, которых больше не получить этим путём.
//
// ЧТО ПРОВЕРЯЕТСЯ ЗДЕСЬ. Что причина, пришедшая с сервера, доходит до
// экрана и не выдаётся за ошибку действия: одобрение УДАЛОСЬ, и
// `ErrorBanner` тут был бы неправдой. Рантайма у страниц панели в этом
// процессе нет, поэтому — по тексту экрана; поведение самой причины
// проверено на сервере (`venue-application.service.spec.ts`, два
// сценария: сбой провайдера и исчерпанный потолок).

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

/** Комментарии прочь перед разбором КОДА: за эту сессию собственный
 *  объяснительный текст ловили двенадцать раз. */
function code(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: причина из ответа сервера доходит до экрана модерации', () => {
    const page = code('app/moderation/venues/page.tsx');
    assert(/setRatingNotice\(outcome\.ratingNotice\)/.test(page), 'причина с сервера не берётся из ответа — экран молчит');
    assert(/\{ratingNotice &&/.test(page), 'причина не рисуется');
    assert(/role="status"/.test(page), 'появление строки не объявлено — оператор смотрит на очередь, а не сюда');
  }],

  ['причина НЕ выдаётся за ошибку действия: одобрение-то удалось', () => {
    const page = code('app/moderation/venues/page.tsx');
    // `setActionError(outcome.ratingNotice)` показал бы оператору
    // «не удалось одобрить заявку» там, где заявка одобрена.
    assert(!/setActionError\(outcome\./.test(page), 'успешное одобрение показано как ошибка действия');
    assert(/const \[ratingNotice, setRatingNotice\]/.test(page), 'причина не имеет своего состояния, отдельного от ошибок');
  }],

  ['отклонение заявки сбрасывает прежнюю причину: она была про другую заявку', () => {
    const page = code('app/moderation/venues/page.tsx');
    assert(/setRatingNotice\(null\)/.test(page), 'строка о прошлом одобрении остаётся висеть над очередью');
  }],

  ['тип ответа модерации называет обе части, а не только заявку', () => {
    const types = code('lib/types.ts');
    assert(/interface VenueModerationResult/.test(types), 'тип ответа модерации не описан');
    assert(/ratingNotice: string \| null/.test(types), 'причина не названа в типе — экран не узнает о ней');
    const endpoints = code('lib/endpoints.ts');
    assert(/apiPatch<VenueModerationResult>/.test(endpoints), 'клиент ждёт прежнюю форму ответа');
  }],
];

const results: { name: string; error?: string }[] = [];
for (const [name, fn] of scenarios) {
  try {
    fn();
    results.push({ name });
  } catch (err: any) {
    results.push({ name, error: err.message });
  }
}

const failed = results.filter((r) => r.error);
console.log(`\nthe-refusal-was-swallowed-midway (admin): ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

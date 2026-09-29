// Пункт [right-lived-in-the-tab] 2026-09-25 — срок права забрать
// написанное назван на экране, а не только в комментарии к коду.
//
// Удостоверение участника намеренно не кладётся на устройство
// ([badge-was-the-key]): аккаунта человек не заводил, и оставлять его
// ключ на возможно чужом компьютере продукт не вправе. Решение верное,
// а сказано о нём не было ничего: кнопка «Забрать свою заявку» стояла
// без единого слова о том, что она живёт ровно до закрытия вкладки.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ParticipantRightsNote, WithdrawUnavailableNote } from '../components/ParticipantRights';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const note = (hasBadge: boolean) => renderToStaticMarkup(createElement(ParticipantRightsNote, { hasBadge }));
const gone = (status: 'ACCEPTED' | 'REJECTED') => renderToStaticMarkup(createElement(WithdrawUnavailableNote, { status }));

const PAGE = join(__dirname, '..', 'app', 'public', '[token]', 'page.tsx');
/** Без комментариев: упоминание компонента в пояснении — не его
 * применение, и принять одно за другое здесь было бы ровно тем же
 * дефектом, что разбирает этот пункт. */
function pageCode(): string {
  return readFileSync(PAGE, 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: строки стоят НА СТРАНИЦЕ, а не лежат отдельным компонентом', () => {
    // Компонент, который никуда не подключён, — это «механизм есть,
    // доступа к нему нет»: ровно та форма дефекта, которую чинит этот
    // пункт, только этажом выше.
    const src = pageCode();
    assert(/<ParticipantRightsNote\b/.test(src), 'строка о сроке права не выведена на публичную страницу');
    assert(/<WithdrawUnavailableNote\b/.test(src), 'объяснение вместо исчезнувшей кнопки не выведено');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: участнику сказано, что право живёт до закрытия вкладки', () => {
    const out = note(true);
    assert(/пока открыта эта вкладка/.test(out), `срок права не назван: ${out}`);
    assert(/не сохраняется|не сохраняем/.test(out), `не сказано, почему так: ${out}`);
    // Молчание человек достраивает в свою пользу — поэтому сказано и
    // что делать, когда вкладка уже закрыта.
    assert(/тому, кто дал ссылку/.test(out), `не сказано, куда идти дальше: ${out}`);
  }],

  ['ОБРАТНАЯ ПРОБА: без удостоверения текст другой — он объясняет, почему кнопок нет', () => {
    // Иначе одна и та же строка стояла бы всегда и перестала бы
    // отвечать на вопрос, который человек задаёт в этот момент.
    const withBadge = note(true);
    const without = note(false);
    assert(withBadge !== without, 'текст одинаков в обоих состояниях');
    assert(/Если вкладка закрылась/.test(without), `не объяснено, почему забрать нельзя: ${without}`);
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: принятая заявка объясняется словами, а не исчезнувшей кнопкой', () => {
    const out = gone('ACCEPTED');
    assert(/стала аргументом проекта/.test(out), `не сказано, что с ней стало: ${out}`);
    assert(/Напишите автору/.test(out), `не сказано, что делать: ${out}`);
  }],

  ['отклонённая заявка — отдельная новость, а не та же самая', () => {
    const rejected = gone('REJECTED');
    assert(/в проект она не попала/.test(rejected), `отклонение не объяснено: ${rejected}`);
    assert(rejected !== gone('ACCEPTED'), 'принятая и отклонённая объясняются одинаково');
  }],
];

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

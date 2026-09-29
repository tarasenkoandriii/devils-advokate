// Сверка 2026-09-05, экранная половина — обещано, что придёт.
//
// НАЙДЕННОЕ. Под встречей с напоминанием экран писал «напоминание о
// спарринге ЗАПЛАНИРОВАНО» — и писал это даже тогда, когда момент
// давно прошёл, а напоминание не ушло. Доставка держится на pg_cron,
// который владелец настраивает вручную вне приложения; не настроен —
// не приходит ничего, а экран обещает до самого разговора и после.
//
// ПРОВЕРЯЕТСЯ РАЗМЕТКА, А НЕ ИСХОДНИК. Урок [render-guards]: «слово
// есть в файле» и «человек это видит» — разные утверждения, и мутация
// «обернуть в {false && …}» проходит первую проверку насквозь.

import { createElement, ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ReminderNote } from '../components/ReminderNote';
import { ScheduledConversation } from '../lib/types';

const SRC = join(__dirname, '..');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function render<P extends object>(Component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(createElement(Component, props));
}

function code(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const NOW = Date.parse('2026-09-05T12:00:00Z');

function scheduled(over: Partial<ScheduledConversation>): ScheduledConversation {
  return {
    id: 's1', projectId: 'p1', personId: null, person: null,
    scheduledAt: '2026-09-05T13:00:00Z',
    sparringReminderMinutesBefore: 60,
    sparringReminderSentAt: null, postMortemReminderSentAt: null,
    linkedConversationId: null, linkedConversation: null,
    createdAt: '2026-09-01T00:00:00Z',
    ...over,
  } as ScheduledConversation;
}

const scenarios: Array<[string, () => void]> = [
  ['КЛЮЧЕВОЙ ТЕСТ: просроченное напоминание названо неушедшим — на экране', () => {
    const html = render(ReminderNote, {
      scheduled: scheduled({ reminderState: 'overdue', reminderDueAt: '2026-09-05T11:30:00Z' }),
      now: NOW,
    });
    assert(/напоминание не ушло/.test(html), 'экран снова обещает несостоявшееся напоминание');
    assert(/30 мин\. назад/.test(html), 'не сказано, когда оно должно было уйти');
    assert(/не рассчитывайте/.test(html), 'не сказано, чего от него не ждать');
    // Строка появляется сама, человек на неё не смотрел.
    assert(/role="status"/.test(html), 'сообщение не объявляется вслух');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: будущее напоминание не помечено сбойным', () => {
    // Пометка «не ушло» на том, чей момент ещё не наступил, — тот же
    // обман в другую сторону.
    const html = render(ReminderNote, { scheduled: scheduled({ reminderState: 'scheduled' }), now: NOW });
    assert(/запланировано/.test(html), 'запланированное напоминание не названо');
    assert(!/не ушло/.test(html), 'будущее напоминание помечено неушедшим');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: отправленное и непрошеное', () => {
    const sent = render(ReminderNote, { scheduled: scheduled({ reminderState: 'sent', sparringReminderSentAt: '2026-09-05T11:30:00Z' }), now: NOW });
    assert(/отправлено/.test(sent), 'отправленное напоминание не названо');
    const none = render(ReminderNote, { scheduled: scheduled({ reminderState: 'not-requested', sparringReminderMinutesBefore: null }), now: NOW });
    assert(none === '', 'о непрошеном напоминании что-то сказано');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: ответ старого сервера без состояния не рождает обещания «не ушло»', () => {
    // Поле может не прийти вовсе. Выдумывать сбой на пустом месте
    // нельзя: это была бы паника вместо честности.
    const html = render(ReminderNote, { scheduled: scheduled({}), now: NOW });
    assert(!/не ушло/.test(html), 'сбой выдуман там, где о нём ничего не известно');
    assert(/запланировано/.test(html), 'запасной разбор потерял состояние вовсе');
  }],

  ['КЛЮЧЕВОЙ ТЕСТ: показ при входе больше не назван ежедневным напоминанием', () => {
    const settings = code('app/settings/page.tsx');
    assert(!/Ежедневное напоминание/.test(settings), 'показ при входе снова назван напоминанием');
    assert(/если не зайти, ничего не придёт/.test(settings), 'не сказано, что без входа ничего не будет');
    assert(/Не чаще раза в день/.test(settings), '«раз в день» снова читается как расписание доставки');
  }],

  ['ИЗМЕРЕНИЕ: экран планировщика выводит подпись, а не решает сам', () => {
    // Не «импорт есть»: мутация «убрать вызов, оставить импорт»
    // проходит проверку на упоминание.
    const section = code('components/SchedulerSection.tsx');
    assert(/<ReminderNote\b/.test(section), 'подпись не выводится на экран');
    assert(!/напоминание о спарринге запланировано/.test(section), 'прежнее безусловное обещание осталось в разметке экрана');
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
console.log(`\npromised-arrival: ${results.length - failed.length}/${results.length} passed\n`);
for (const r of results) {
  console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
  if (r.error) console.log(`  ${r.error}`);
}
if (failed.length > 0) process.exit(1);

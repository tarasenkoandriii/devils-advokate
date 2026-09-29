'use client';

// Пункт [promised-arrival] 2026-09-05 — обещано, что придёт.
//
// НАЙДЕНО. Под каждой встречей с напоминанием экран писал «напоминание
// о спарринге ЗАПЛАНИРОВАНО». Утверждение о будущем, а доставка
// напоминаний держится на pg_cron + pg_net, которые владелец
// настраивает в Supabase вручную (файл миграции честно говорит, что
// настройка за ним), плюс на секрете диспетчеризации и токене бота. Не
// настроено что-нибудь одно — не приходит ничего, а экран продолжает
// обещать: и до разговора, и после.
//
// ЧТО СЧИТАЕТСЯ. Момент напоминания вычисляется из уже сохранённых
// полей. Прошёл, а отметки об отправке нет — напоминание НЕ УШЛО. Это
// факт об этой встрече, а не догадка о чужих настройках, и говорится
// он именно так.
//
// ЧЕГО ЗДЕСЬ НЕТ. Обещания «сейчас починим»: причина живёт вне
// приложения, и делать вид, что человек может что-то нажать, — второе
// враньё поверх первого. Сказано то, что ему полезно: напоминания не
// придут, рассчитывайте на себя.

import { ScheduledConversation } from '../lib/types';

function minutesAgo(dueAt: string | null | undefined, now: number): number | null {
  if (!dueAt) return null;
  const due = new Date(dueAt).getTime();
  if (!Number.isFinite(due)) return null;
  return Math.max(0, Math.round((now - due) / 60_000));
}

export function ReminderNote({ scheduled, now = Date.now() }: { scheduled: ScheduledConversation; now?: number }) {
  const state = scheduled.reminderState
    // Запасной разбор для ответа старого сервера: без него экран
    // вернулся бы к прежнему безусловному «запланировано».
    ?? (scheduled.sparringReminderSentAt ? 'sent' : 'scheduled');

  if (state === 'not-requested') return null;

  if (state === 'sent') {
    return <span className="scheduler-list__note">✓ напоминание о спарринге отправлено</span>;
  }

  if (state === 'overdue') {
    const late = minutesAgo(scheduled.reminderDueAt, now);
    return (
      <span className="scheduler-list__note" role="status">
        ⚠ напоминание не ушло{late != null ? ` — момент прошёл ${late} мин. назад` : ''}. Доставка напоминаний
        настраивается вне приложения; на это напоминание не рассчитывайте.
      </span>
    );
  }

  return <span className="scheduler-list__note">напоминание о спарринге запланировано</span>;
}

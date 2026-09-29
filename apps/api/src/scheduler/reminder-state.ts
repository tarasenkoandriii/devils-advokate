// Пункт [promised-arrival] 2026-09-05 — обещано, что придёт.
//
// НАЙДЕНО. Экран планировщика писал под каждой встречей с
// напоминанием: «напоминание о спарринге ЗАПЛАНИРОВАНО». Это
// утверждение о будущем, а доставка напоминаний в продукте держится на
// том, чего в самом продукте нет:
//
//   • pg_cron + pg_net, настроенные владельцем вручную в Supabase
//     (`prisma/manual-migrations/pg_cron_reminders.sql` — файл честно
//     говорит, что настройка за владельцем);
//   • секрет диспетчеризации;
//   • токен бота.
//
// Не настроено что-нибудь одно — не приходит НИЧЕГО, и экран
// продолжает писать «запланировано» до самого разговора и после него.
// Человек строит подготовку вокруг напоминания, которого не будет.
//
// ЧТО МОЖНО ЗНАТЬ БЕЗ НОВОЙ КОЛОНКИ. Ничего нового записывать не надо:
// момент напоминания вычисляется из уже сохранённых полей. Если он
// прошёл, а отметки об отправке нет — напоминание не ушло. Это факт о
// конкретной встрече, а не догадка о настройках сервера, и говорится
// он ровно так.
//
// ПОЧЕМУ НЕ «ПРОВЕРИТЬ, ЖИВ ЛИ КРОН». Такая проверка требует места,
// куда писать отметку последнего тика, то есть ПЯТОЙ ручной миграции —
// их и так четыре ждут применения. Решение о пятой за владельцем; здесь
// оно не принимается молча, и вычисляемого признака достаточно, чтобы
// человек перестал ждать несуществующего сообщения.

export type ReminderState =
  /** Напоминание не просили. */
  | 'not-requested'
  /** Момент ещё не наступил. */
  | 'scheduled'
  /** Ушло. */
  | 'sent'
  /** Момент прошёл, отметки об отправке нет — не ушло. */
  | 'overdue';

export interface ReminderStateInput {
  scheduledAt: Date;
  sparringReminderMinutesBefore: number | null;
  sparringReminderSentAt: Date | null;
}

export function reminderState(s: ReminderStateInput, now: Date): ReminderState {
  if (s.sparringReminderSentAt) return 'sent';
  if (s.sparringReminderMinutesBefore == null) return 'not-requested';
  const due = new Date(s.scheduledAt.getTime() - s.sparringReminderMinutesBefore * 60_000);
  return due <= now ? 'overdue' : 'scheduled';
}

/** Когда напоминание должно было уйти. Возвращается наружу вместе с
 * состоянием: «просрочено» без времени — утверждение, которое человеку
 * нечем проверить. */
export function reminderDueAt(s: ReminderStateInput): Date | null {
  if (s.sparringReminderMinutesBefore == null) return null;
  return new Date(s.scheduledAt.getTime() - s.sparringReminderMinutesBefore * 60_000);
}

-- ТЗ devils-advocate-domain-ui-and-voice-intake-tz.md §2.2 п.7 — сессии
-- intake-квиза без dispatch дольше 24 ч переводятся в ABANDONED.
--
-- Как и pg_cron_reminders.sql: этот файл НЕ применяется автоматически —
-- ни prisma migrate, ни деплой. Выполнить один раз вручную через SQL Editor
-- Supabase после деплоя backend. Расширения pg_cron и pg_net уже должны
-- быть включены (см. шаги 1–2 в pg_cron_reminders.sql).
--
-- Секрет — тот же SCHEDULER_DISPATCH_SECRET, что у reminders/dispatch
-- (см. intake.controller.ts): отдельный ради одного суточного задания
-- не заводится.

SELECT cron.schedule(
  'abandon-stale-intake-sessions',
  '15 3 * * *',  -- раз в сутки, 03:15 UTC — окно низкой нагрузки
  $$
  SELECT net.http_post(
    url := 'https://YOUR-PRODUCTION-DOMAIN.example/intake/abandon-stale',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', 'YOUR-SCHEDULER-DISPATCH-SECRET'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Проверка: SELECT * FROM cron.job WHERE jobname = 'abandon-stale-intake-sessions';
-- Откат:    SELECT cron.unschedule('abandon-stale-intake-sessions');

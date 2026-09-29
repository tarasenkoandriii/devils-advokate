-- Пункт [job-domain-v2] К-16 — повторная загрузка вакансий, за которыми
-- пользователь САМ включил слежение (JobVacancy.watchEnabled), не чаще раза
-- в сутки на вакансию, порцией 20 за тик (остальное — следующим тиком).
--
-- Это не мониторинг площадок: тик обходит только ссылки, которые человек
-- принёс и попросил следить (§3.6 ТЗ job-domain-v2). Как и остальные
-- pg_cron_*.sql, файл НЕ применяется автоматически — выполнить один раз
-- вручную через SQL Editor Supabase после деплоя backend. Расширения
-- pg_cron и pg_net должны быть включены (см. pg_cron_reminders.sql).
--
-- Секрет — тот же SCHEDULER_DISPATCH_SECRET, что у reminders/intake.

SELECT cron.schedule(
  'job-search-refetch-watched',
  '40 3 * * *',  -- раз в сутки, 03:40 UTC
  $$
  SELECT net.http_post(
    url := 'https://YOUR-PRODUCTION-DOMAIN.example/internal/job-search/refetch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', 'YOUR-SCHEDULER-DISPATCH-SECRET'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Проверка: SELECT * FROM cron.job WHERE jobname = 'job-search-refetch-watched';
-- Откат:    SELECT cron.unschedule('job-search-refetch-watched');

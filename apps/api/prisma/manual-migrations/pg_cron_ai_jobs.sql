-- Пункт [multimodal] §4.5 — три pg_cron-джобы асинхронной полосы
-- AIRouter: постановка задач провайдеру, опрос статусов, сторожевая.
--
-- ═══════════════════════════════════════════════════════════════════
-- ЧЕСТНО, ПРЯМО ЗДЕСЬ (тот же блок, что в pg_cron_reminders.sql):
-- файл НЕ применяется автоматически — ни prisma migrate, ни деплой.
-- Выполняется ВРУЧНУЮ, один раз, через SQL Editor в Supabase, ПОСЛЕ
-- деплоя backend. Работа против живого инстанса Supabase (расширения
-- pg_cron/pg_net, права, синтаксис) в среде разработки не
-- верифицирована — контракт восстановлен по документации.
-- ═══════════════════════════════════════════════════════════════════
--
-- Зачем три джобы и почему все '* * * * *':
--   submit — берёт QUEUED-джобы (SKIP LOCKED в коде), ставит задачу
--            провайдеру (background: true) и переводит в RUNNING;
--            батч 3 — постановка ~1 с, укладывается в maxDuration.
--   poll   — берёт RUNNING с externalInteractionId, спрашивает статус;
--            батч 10 — опрос ~1 с.
--   reap   — сторожевая: протухшие lease джоб (QUEUED — воркер не
--            поставил; RUNNING — провайдер молчит дольше потолка
--            ожидания) → FAILED с внятной причиной, ПЛЮС принудительная
--            чистка blob-файлов с зависшими потребителями (§7.2 —
--            утечка файла хуже потерянного анализа).
-- Наша функция никогда не ждёт модель: ожидание — на стороне Google.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule(jobname)
FROM cron.job
WHERE jobname IN ('ai-jobs-submit', 'ai-jobs-poll', 'ai-jobs-reap');

-- !!! ЗАМЕНИТЕ ДВА МЕСТА ПЕРЕД ВЫПОЛНЕНИЕМ:
--   1. https://YOUR-PRODUCTION-DOMAIN.example — домен API-проекта
--   2. YOUR-AI-JOB-DISPATCH-SECRET — значение переменной
--      AI_JOB_DISPATCH_SECRET из окружения API (openssl rand -base64 32);
--      должно совпадать буквально, иначе 401 на каждый вызов.

SELECT cron.schedule(
  'ai-jobs-submit',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR-PRODUCTION-DOMAIN.example/internal/ai-jobs/submit',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', 'YOUR-AI-JOB-DISPATCH-SECRET'
    ),
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'ai-jobs-poll',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR-PRODUCTION-DOMAIN.example/internal/ai-jobs/poll',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', 'YOUR-AI-JOB-DISPATCH-SECRET'
    ),
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'ai-jobs-reap',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR-PRODUCTION-DOMAIN.example/internal/ai-jobs/reap',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', 'YOUR-AI-JOB-DISPATCH-SECRET'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Проверка после настройки:
--   SELECT * FROM cron.job WHERE jobname LIKE 'ai-jobs-%';
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

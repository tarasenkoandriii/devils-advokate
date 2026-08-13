-- Пункт 50 (§3.20 ТЗ) — настройка pg_cron + pg_net для диспетчеризации
-- push-напоминаний планировщика разговоров.
--
-- ═══════════════════════════════════════════════════════════════════
-- ЧЕСТНО, ПРЯМО ЗДЕСЬ, НЕ ТОЛЬКО В КОММЕНТАРИИ КОДА: этот файл НЕ
-- применяется автоматически ни через `prisma migrate`, ни при
-- деплое. Prisma не умеет управлять расширениями Postgres и
-- cron.schedule() — это не таблицы/модели, а конфигурация самого
-- инстанса Supabase. Этот SQL нужно выполнить ВРУЧНУЮ, один раз,
-- через SQL Editor в дашборде Supabase (или через `psql`, если у вас
-- есть прямой доступ), ПОСЛЕ того как backend задеплоен и у вас есть
-- реальный URL продакшена.
--
-- Я не могу проверить, что этот SQL реально работает на вашем
-- конкретном инстансе Supabase — ни расширения pg_cron/pg_net,
-- ни синтаксис, ни права доступа не верифицированы вызовом против
-- живой базы (нет сети/доступа к вашему Supabase в этой среде
-- разработки). Контракт восстановлен по официальной документации
-- Supabase/pg_cron/pg_net, та же оговорка, что у остальных внешних
-- интеграций этого прохода.
-- ═══════════════════════════════════════════════════════════════════

-- Шаг 1: включить расширения (если ещё не включены — в Supabase это
-- обычно можно сделать через Dashboard → Database → Extensions, но
-- SQL-вариант тоже работает, если у роли есть права).
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Шаг 2: удалить предыдущую версию джобы с тем же именем, если
-- перезапускаете настройку (cron.schedule с уже занятым именем
-- бросает ошибку, не молча перезаписывает).
SELECT cron.unschedule('dispatch-scheduled-conversation-reminders')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'dispatch-scheduled-conversation-reminders'
);

-- Шаг 3: сама джоба. Периодичность — раз в минуту ('* * * * *'),
-- реальная частота напоминаний ("за час", "за день") при этом не
-- ограничена частотой самого cron — dispatchDueReminders() на
-- backend сам решает, какие конкретные напоминания уже просрочены
-- (см. scheduler.service.ts), джоба просто должна быть достаточно
-- частой, чтобы не пропускать окна.
--
-- !!! ЗАМЕНИТЕ ДВА МЕСТА НИЖЕ ПЕРЕД ВЫПОЛНЕНИЕМ:
--   1. https://YOUR-PRODUCTION-DOMAIN.example — реальный домен вашего
--      задеплоенного backend (Vercel production URL)
--   2. YOUR-SCHEDULER-DISPATCH-SECRET — то же значение, что вы
--      зададите в SecretsService/переменных окружения под ключом
--      SCHEDULER_DISPATCH_SECRET (см. scheduler.controller.ts) —
--      должно совпадать буквально, иначе каждый вызов будет получать
--      401 Unauthorized.
SELECT cron.schedule(
  'dispatch-scheduled-conversation-reminders',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR-PRODUCTION-DOMAIN.example/internal/reminders/dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', 'YOUR-SCHEDULER-DISPATCH-SECRET'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Шаг 4 (проверка после настройки): убедиться, что джоба
-- зарегистрирована и реально срабатывает.
--   SELECT * FROM cron.job WHERE jobname = 'dispatch-scheduled-conversation-reminders';
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
--
-- Если job_run_details показывает return_message с ошибкой (403/401
-- от вашего backend, DNS-ошибку и т.д.) — проверьте домен и секрет
-- в Шаге 3 ещё раз, это самая частая причина сбоя настройки такого рода.

-- Отключить джобу полностью (если нужно временно/навсегда
-- остановить напоминания):
--   SELECT cron.unschedule('dispatch-scheduled-conversation-reminders');

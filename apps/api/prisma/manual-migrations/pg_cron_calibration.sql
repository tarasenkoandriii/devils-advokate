-- Пункт [prompt-framework] (devils-advocate-prompt-framework-tz.md
-- §4.3) — настройка pg_cron + pg_net для плановой пересборки
-- калибровочной статистики сценариев (Brier score + эмпирическая
-- точность по корзинам confidence).
--
-- ═══════════════════════════════════════════════════════════════════
-- ЧЕСТНО, ПРЯМО ЗДЕСЬ, НЕ ТОЛЬКО В КОММЕНТАРИИ КОДА: этот файл НЕ
-- применяется автоматически, тот же принцип, что pg_cron_reminders.sql
-- (Пункт 50) — нужно выполнить ВРУЧНУЮ, один раз, через SQL Editor
-- в дашборде Supabase, ПОСЛЕ деплоя backend, когда есть реальный URL
-- продакшена. Не верифицировано против живой базы — нет сети/доступа
-- к вашему Supabase в этой среде разработки.
-- ═══════════════════════════════════════════════════════════════════

-- Шаг 1: расширения — пропустить, если уже включены Пунктом 50.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Шаг 2: удалить предыдущую версию джобы с тем же именем, если
-- перезапускаете настройку.
SELECT cron.unschedule('recompute-scenario-calibration')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'recompute-scenario-calibration');

-- Шаг 3: сама джоба. РАЗ В СУТКИ (не раз в минуту, как у напоминаний,
-- Пункт 50) — калибровка не срочная, пересчитывать чаще, чем
-- накапливаются новые подтверждённые исходы (OutcomeScenario.
-- outcomeConfirmed), бессмысленно; выберите удобное для вас время
-- (пример — 04:00 UTC, малонагруженное время).
--
-- ЗАМЕНИТЕ:
--   1) YOUR-PRODUCTION-DOMAIN.example на реальный домен вашего backend
--   2) YOUR-SCHEDULER-DISPATCH-SECRET на реальное значение переменной
--      SCHEDULER_DISPATCH_SECRET — ПЕРЕИСПОЛЬЗУЕТСЯ тот же секрет, что
--      уже настроен для Пункта 50 (см. calibration.controller.ts —
--      сознательное решение не заводить отдельный секрет ради одного
--      дополнительного планового задания), должно совпадать буквально.
SELECT cron.schedule(
  'recompute-scenario-calibration',
  '0 4 * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR-PRODUCTION-DOMAIN.example/internal/calibration/recompute',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', 'YOUR-SCHEDULER-DISPATCH-SECRET'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Шаг 4 (проверка после настройки):
--   SELECT * FROM cron.job WHERE jobname = 'recompute-scenario-calibration';
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
--
-- Отключить джобу полностью:
--   SELECT cron.unschedule('recompute-scenario-calibration');

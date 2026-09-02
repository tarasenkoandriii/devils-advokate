-- Пункт [router-simplify] 2026-09-01 — эквивалент миграции для
-- schema.prisma. Как и остальное в manual-migrations: для сверки с
-- `prisma migrate dev` или ручного применения.
--
-- ЧТО ПРОИСХОДИТ. Таблица ai_model_capabilities держала строку на
-- КАЖДУЮ пару (модель × taskType) — 192 строки на пять моделей. Это
-- измерение не отвечало ни на один вопрос (все текстовые модели умеют
-- все текстовые задачи), а отсутствие строки под новую задачу молча
-- убивало фичу при живых ключах. Теперь строка ОДНА НА МОДЕЛЬ, а кого
-- звать, решает наличие ключа провайдера.
--
-- ВНИМАНИЕ: шаг 1 УДАЛЯЕТ строки (схлопывает дубликаты по модели).
-- Данных пользователей в этой таблице нет — это конфигурация, которую
-- полностью восстанавливает `npm run prisma:seed`. История AI-вызовов
-- (ai_jobs / ai_inferences) ссылается на ai_model_versions, не сюда, и
-- не затрагивается.
--
-- ПОРЯДОК: применить SQL, затем прогнать сид.

BEGIN;

-- 1. Схлопываем строки до одной на модель. Оставляем САМУЮ РАННЮЮ:
--    роутер и раньше брал первую по createdAt, поведение сохраняется.
--    vision/audio агрегируем через bool_or — если хоть одна строка
--    модели разрешала медиа, разрешает и итоговая.
CREATE TEMP TABLE _caps_keep AS
SELECT DISTINCT ON ("modelVersionId")
  id,
  "modelVersionId",
  availability,
  "latencyClass",
  "costClass"
FROM ai_model_capabilities
ORDER BY "modelVersionId", "createdAt" ASC, id ASC;

UPDATE ai_model_capabilities c
SET vision = agg.vision, audio = agg.audio
FROM (
  SELECT "modelVersionId", bool_or(vision) AS vision, bool_or(audio) AS audio
  FROM ai_model_capabilities
  GROUP BY "modelVersionId"
) agg
WHERE c."modelVersionId" = agg."modelVersionId"
  AND c.id IN (SELECT id FROM _caps_keep);

DELETE FROM ai_model_capabilities
WHERE id NOT IN (SELECT id FROM _caps_keep);

-- 2. Удаляем колонки, которые не читал никто.
--    taskType         — измерение, ради которого всё и городилось;
--    structuredOutput,
--    streaming,
--    maxContext,
--    privacyClass     — ни одного чтения в коде.
DROP INDEX IF EXISTS "ai_model_capabilities_modelVersionId_taskType_idx";
ALTER TABLE ai_model_capabilities DROP COLUMN IF EXISTS "taskType";
ALTER TABLE ai_model_capabilities DROP COLUMN IF EXISTS "structuredOutput";
ALTER TABLE ai_model_capabilities DROP COLUMN IF EXISTS "streaming";
ALTER TABLE ai_model_capabilities DROP COLUMN IF EXISTS "maxContext";
ALTER TABLE ai_model_capabilities DROP COLUMN IF EXISTS "privacyClass";

-- 3. Одна строка на модель — теперь это инвариант базы, а не соглашение.
CREATE UNIQUE INDEX IF NOT EXISTS "ai_model_capabilities_modelVersionId_key"
  ON ai_model_capabilities("modelVersionId");

-- 4. authMethod у провайдера: способ авторизации знает клиент
--    (selectProviderClient по имени провайдера), колонку не читал никто.
ALTER TABLE ai_providers DROP COLUMN IF EXISTS "authMethod";

COMMIT;

-- 5. После применения: npm run prisma:seed --workspace=apps/api
--    Сид приведёт строки к текущему набору моделей и деактивирует те,
--    которых в нём больше нет.

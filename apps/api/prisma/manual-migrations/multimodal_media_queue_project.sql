-- Пункт [multimodal] §6.1.1 — бэкфилл MediaReviewQueue.projectId для
-- БАЗ, ГДЕ УЖЕ ЕСТЬ ОЧЕРЕДИ. Выполнить ВРУЧНУЮ через SQL Editor
-- Supabase ДО `prisma db push`: push не может добавить обязательную
-- колонку в таблицу с данными без default, а осмысленного default у
-- FK нет — каждой существующей очереди нужен СВОЙ проект.
--
-- На пустой таблице (свежая база, make reset) этот файл не нужен:
-- db push добавит колонку сам.
--
-- Что делает: для каждой очереди без проекта создаёт
-- проект-контейнер (question = название очереди, владелец = владелец
-- очереди), проставляет projectId, затем закрепляет NOT NULL + FK +
-- индекс — ровно ту форму, которую ждёт schema.prisma.

BEGIN;

ALTER TABLE media_review_queues ADD COLUMN IF NOT EXISTS "projectId" TEXT;

-- Проект на каждую очередь. id генерируем как cuid-подобный —
-- достаточно уникальности, форма id для Prisma не принципиальна.
WITH created AS (
  INSERT INTO projects (id, "ownerId", question, goal, "createdAt", "updatedAt")
  SELECT
    'proj_mrq_' || q.id,
    q."userId",
    q.title,
    'Проект-контейнер очереди медиа-разбора (бэкфилл multimodal)',
    now(), now()
  FROM media_review_queues q
  WHERE q."projectId" IS NULL
  RETURNING id
)
UPDATE media_review_queues q
SET "projectId" = 'proj_mrq_' || q.id
WHERE q."projectId" IS NULL;

ALTER TABLE media_review_queues ALTER COLUMN "projectId" SET NOT NULL;

ALTER TABLE media_review_queues
  ADD CONSTRAINT "media_review_queues_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "media_review_queues_projectId_idx"
  ON media_review_queues("projectId");

COMMIT;

-- Проверка: не должно остаться очередей без проекта.
--   SELECT count(*) FROM media_review_queues WHERE "projectId" IS NULL;

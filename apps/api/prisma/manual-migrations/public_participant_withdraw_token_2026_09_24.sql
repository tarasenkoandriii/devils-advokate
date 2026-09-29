-- Пункт [badge-was-the-key] 2026-09-24.
--
-- Право участника публичного обсуждения «забрать своё» проверялось по
-- его `id` — а `id` печатался в ответе публичной страницы каждому, кто
-- открыл ссылку. Секрет заводится отдельной колонкой; существующие
-- строки получают значение сразу, иначе уже вошедшие участники
-- потеряли бы право забрать написанное.
--
-- Применить ДО `prisma db push`. Обе операции идемпотентны.

ALTER TABLE "public_participants"
  ADD COLUMN IF NOT EXISTS "withdrawToken" TEXT NOT NULL
  DEFAULT md5(random()::text || clock_timestamp()::text);

CREATE UNIQUE INDEX IF NOT EXISTS "public_participants_withdrawToken_key"
  ON "public_participants" ("withdrawToken");

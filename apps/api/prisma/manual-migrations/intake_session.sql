-- ТЗ devils-advocate-domain-ui-and-voice-intake-tz.md §2.3 — таблица
-- intake-сессий. Эквивалент того, что сгенерирует `prisma migrate dev`
-- для добавленных в schema.prisma IntakeStatus/IntakeSession; приложен
-- на случай, если миграцию нужно применить руками (VERCEL.md §миграции)
-- или сверить. Таблица — intake_sessions (@@map, как у всех моделей проекта), enum — IntakeStatus.
--
-- Пункт [the-file-could-not-be-run-twice] 2026-10-02 — ФАЙЛ ПЕРЕПИСАН НА
-- БЕЗОПАСНЫЙ ПОВТОР. Делает он ровно то же, что и раньше; изменилось
-- только поведение при ВТОРОМ применении.
--
-- Нашла это джоба CI с настоящим Postgres: `CREATE TYPE` падал с
-- «type "IntakeStatus" already exists». Из 18 применимых файлов
-- соглашению `IF NOT EXISTS` следовали семнадцать, а этот — ни в одном
-- операторе. И падал он на ПЕРВОМ, то есть повторный прогон не
-- применял НИЧЕГО: ни таблицу, ни индексы, ни три колонки заморозки
-- проекта в самом низу файла. Оператор, которому сказано «файлы
-- идемпотентны», видел сообщение «тип уже есть», читал его как «значит,
-- всё уже на месте» — и колонок заморозки могло не быть вовсе. Пробел
-- выглядел как полнота.
--
-- У `CREATE TYPE` в Postgres нет `IF NOT EXISTS` — ни в 16, ни в 17.
-- Поэтому единственная честная защита — перехват `duplicate_object`;
-- это не хитрость, а штатный приём, и других способов нет.

DO $$
BEGIN
  CREATE TYPE "IntakeStatus" AS ENUM ('IN_PROGRESS', 'DISPATCHED', 'ABANDONED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS "intake_sessions" (
  "id"                  TEXT NOT NULL,
  "userId"              TEXT NOT NULL,
  "status"              "IntakeStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "answers"             JSONB NOT NULL DEFAULT '[]',
  "suggestedScenario"   TEXT,
  "confidence"          DOUBLE PRECISION,
  "followUpQuestion"    TEXT,
  "extracted"           JSONB,
  "chosenScenario"      TEXT,
  "dispatchedProjectId" TEXT,
  "dispatchedAt"        TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "intake_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "intake_sessions_userId_status_idx" ON "intake_sessions"("userId", "status");
CREATE INDEX IF NOT EXISTS "intake_sessions_status_updatedAt_idx" ON "intake_sessions"("status", "updatedAt");

-- У ограничений `IF NOT EXISTS` тоже нет, поэтому принятый в проекте
-- приём — снять и поставить заново (так же сделано в
-- person_fact_cascade_2026_09_04.sql). Снятие безопасно: имя и форма
-- ограничения заданы здесь же, строкой ниже.
ALTER TABLE "intake_sessions" DROP CONSTRAINT IF EXISTS "intake_sessions_userId_fkey";
ALTER TABLE "intake_sessions"
  ADD CONSTRAINT "intake_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Заморозка проекта оператором (ТЗ §1.4, фаза F+):
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "frozenAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "frozenNote" TEXT,
  ADD COLUMN IF NOT EXISTS "frozenById" TEXT;

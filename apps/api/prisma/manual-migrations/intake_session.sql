-- ТЗ devils-advocate-domain-ui-and-voice-intake-tz.md §2.3 — таблица
-- intake-сессий. Эквивалент того, что сгенерирует `prisma migrate dev`
-- для добавленных в schema.prisma IntakeStatus/IntakeSession; приложен
-- на случай, если миграцию нужно применить руками (VERCEL.md §миграции)
-- или сверить. Таблица — intake_sessions (@@map, как у всех моделей проекта), enum — IntakeStatus.

CREATE TYPE "IntakeStatus" AS ENUM ('IN_PROGRESS', 'DISPATCHED', 'ABANDONED');

CREATE TABLE "intake_sessions" (
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

CREATE INDEX "intake_sessions_userId_status_idx" ON "intake_sessions"("userId", "status");
CREATE INDEX "intake_sessions_status_updatedAt_idx" ON "intake_sessions"("status", "updatedAt");

ALTER TABLE "intake_sessions"
  ADD CONSTRAINT "intake_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Заморозка проекта оператором (ТЗ §1.4, фаза F+):
ALTER TABLE "projects"
  ADD COLUMN "frozenAt"   TIMESTAMP(3),
  ADD COLUMN "frozenNote" TEXT,
  ADD COLUMN "frozenById" TEXT;

-- Пункт [project-log-v2] 2026-09-03 — §3.39 ТЗ, три источника событий лога
-- вместо двух и снятие флагов.
--
-- 1. Кто собеседник. Событие накала (§3.33) и тема прощупывания (§3.37)
--    существовали без привязки к человеку, а лог обязан называть человека
--    ("конфликт с [Имя] обострился"), поэтому оба источника в лог не
--    попадали вовсе. Собеседника выбирает пользователь при старте экрана
--    сопровождения — поля nullable: старые строки и сессии без выбора
--    остаются как есть и в лог не идут, а не получают выдуманное имя.
-- 2. Момент снятия флага. disputed существовал в схеме с давних пор, но
--    не выставлялся ни одним сервисом; disputedAt даёт логу честную дату
--    события (updatedAt меняется от любой правки строки).
--
-- Идемпотентно: IF NOT EXISTS на всём. Индексы — обязательная конвенция
-- проекта на каждую FK-колонку (Postgres не создаёт их сам), проверяется
-- тестом schema-conventions.spec.ts.

ALTER TABLE "escalation_category_events" ADD COLUMN IF NOT EXISTS "personId" TEXT;
ALTER TABLE "probing_topics" ADD COLUMN IF NOT EXISTS "personId" TEXT;
ALTER TABLE "conversation_signals" ADD COLUMN IF NOT EXISTS "disputedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "escalation_category_events_personId_idx" ON "escalation_category_events" ("personId");
CREATE INDEX IF NOT EXISTS "probing_topics_personId_idx" ON "probing_topics" ("personId");

-- ON DELETE SET NULL: удаление человека не должно уносить историю накала
-- разговора — событие было, просто перестаёт быть именованным (и, по
-- правилу выше, исчезает из лога, а не остаётся висеть с мёртвой ссылкой).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'escalation_category_events_personId_fkey') THEN
    ALTER TABLE "escalation_category_events"
      ADD CONSTRAINT "escalation_category_events_personId_fkey"
      FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'probing_topics_personId_fkey') THEN
    ALTER TABLE "probing_topics"
      ADD CONSTRAINT "probing_topics_personId_fkey"
      FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

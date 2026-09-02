-- Пункт [job-landing-attribution] 2026-09-02 — эквивалент миграции для
-- schema.prisma.
--
-- ЗАЧЕМ. ТЗ job-landing §4 требует, чтобы кнопки лендинга вели в бота с
-- параметром (jobs_landing / recruiting_landing) и чтобы UTM-метки
-- доезжали. Аудит 2026-09-01 зафиксировал этот пункт как невыполненный
-- пререквизит: IntakeSession не имела полей под источник, то есть класть
-- параметр было НЕКУДА. Вопрос «какая посадочная привела человека»
-- оставался бы без ответа сразу после запуска рекламы.
--
-- source   — сырой параметр запуска Telegram (start / startapp).
-- campaign — метка источника рекламы (utm_source лендинга).
--
-- Оба nullable: прямой вход в бота параметров не несёт, и это нормальное
-- состояние, а не пробел данных.
--
-- Аддитивно и безопасно: существующие строки получают NULL. Индекс
-- нужен под отчёт «сколько сессий с /jobs и чем закончились» — без него
-- это seq scan по всей таблице.
--
-- Применять по DIRECT_URL (порт 5432): DDL не проходит через pgbouncer.

ALTER TABLE "intake_sessions" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "intake_sessions" ADD COLUMN IF NOT EXISTS "campaign" TEXT;

CREATE INDEX IF NOT EXISTS "intake_sessions_source_createdAt_idx"
  ON "intake_sessions"("source", "createdAt");

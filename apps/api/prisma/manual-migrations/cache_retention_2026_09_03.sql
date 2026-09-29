-- Аудит удаления 2026-09-03 — кэши, адресуемые содержимым.
--
-- Два кэша хранят текст пользователя и не привязаны к нему ключом: их не
-- касается ни каскад при удалении аккаунта, ни удаление проекта, ни отзыв
-- согласий. У tts_cache вдобавок не было срока жизни вообще.
--
-- 1. claimText в fact_check_api_cache — дословная фраза из частного
--    разговора, лежала «для аудита/дебага». Больше не пишется; колонка
--    становится nullable, старые значения вычищаются сторожевой вместе с
--    протухшими строками (см. DELETE ниже — он же выполняется тиком
--    POST /internal/ai-jobs/reap).
-- 2. Индекс по created_at у tts_cache — сторожевая удаляет по нему, без
--    индекса это полный скан на каждом тике.
--
-- Идемпотентно. Разовая чистка внизу — не обязательна, но честнее
-- применить её сразу: до этой миграции протухшие строки не удалялись
-- никогда.

ALTER TABLE "fact_check_api_cache" ALTER COLUMN "claimText" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "tts_cache_createdAt_idx" ON "tts_cache" ("createdAt");

-- Разовая чистка накопленного: протухшие ответы фактчека (их не удалял
-- никто) и озвучки старше 30 суток — того же срока, что применяет
-- сторожевая (TTS_CACHE_TTL_MS в cache-retention.service.ts).
DELETE FROM "fact_check_api_cache" WHERE "expiresAt" < NOW();
UPDATE "fact_check_api_cache" SET "claimText" = NULL WHERE "claimText" IS NOT NULL;
DELETE FROM "tts_cache" WHERE "createdAt" < NOW() - INTERVAL '30 days';

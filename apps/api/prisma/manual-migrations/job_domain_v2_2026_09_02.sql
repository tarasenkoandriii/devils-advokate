-- Пункт [job-domain-v2] 2026-09-02 — ручная часть миграции под
-- docs/devils-advocate-job-domain-v2-tz.md §5.4 / §15.
--
-- Новые таблицы и nullable-колонки создаёт `prisma db push` (аддитивно).
-- Здесь — то, что db push либо делает НЕ безопасно для работающего кода,
-- либо требует отдельного порядка:
--
-- 1. Новые значения перечислений — ОТДЕЛЬНЫМ вызовом ДО выката кода
--    (тот же порядок, что voice_reply_processing_2026_09_02.sql):
--    `ALTER TYPE … ADD VALUE` нельзя выполнять в одной транзакции с
--    использованием значения, а код обязан переживать отставание
--    миграции (common/enum-migration-lag.ts).
-- 2. Три НЕ аддитивных изменения — снятие NOT NULL:
--      commitments.personId          (контрагент может быть CandidateProfile)
--      candidate_shares.sourceCandidateId (самошеринг соискателя — источник CvVariant)
--      job_vacancies.sourceUrl / siteHost (вставленный текст, пересылка, копия от работодателя)
--    `db push` сделает это сам, но именно эти три строки названы явно,
--    потому что откат назад (SET NOT NULL) станет невозможен, как только
--    появится первая строка с NULL — это осознанное решение ТЗ, а не
--    побочный эффект.
--
-- Применять по DIRECT_URL (порт 5432): DDL не проходит через pgbouncer.
-- Порядок: этот файл → `prisma db push` → выкат API.

-- ── 1. Перечисления ──
ALTER TYPE "ProjectMode" ADD VALUE IF NOT EXISTS 'EMPLOYER_HIRING';
ALTER TYPE "ConsentType" ADD VALUE IF NOT EXISTS 'CANDIDATE_DATA_TRANSFER';

-- Новые перечисления целиком создаст db push (CREATE TYPE идёт транзакционно).

-- ── 2. Не аддитивные изменения ──
ALTER TABLE "commitments"       ALTER COLUMN "personId"          DROP NOT NULL;
ALTER TABLE "candidate_shares"  ALTER COLUMN "sourceCandidateId" DROP NOT NULL;
ALTER TABLE "job_vacancies"     ALTER COLUMN "sourceUrl"         DROP NOT NULL;
ALTER TABLE "job_vacancies"     ALTER COLUMN "siteHost"          DROP NOT NULL;

-- ── 3. Дефолты для пустого конфига работодателя (§5.4) ──
ALTER TABLE "interview_pool_configs" ALTER COLUMN "jobTitle"            SET DEFAULT '';
ALTER TABLE "interview_pool_configs" ALTER COLUMN "extendedDescription" SET DEFAULT '';

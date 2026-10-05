-- Пункт [the-first-row-was-whichever] 2026-10-05.
--
-- Три инварианта «такая строка в группе ровно одна» держались проверкой
-- перед записью, то есть ничем:
--
--   * prompt_versions  — «ровно одна ACTIVE на promptId». Её читают 41
--     место продукта; при двух активных откат оператора не доходил до
--     потребителей, а он аварийный тормоз;
--   * dtp_participants — «не більше одного SELF на конфіг». Шапка кода
--     и ТЗ §3.1 ссылались на частичный уникальный индекс, которого в
--     репозитории не было: `catch (P2002)` ловил исключение, которое
--     никто не бросает;
--   * family_law_parties — то же самое, «той самий захист, що ДТП v2».
--
-- В коде проверка и запись теперь одно событие под advisory-замком
-- (`common/ceiling-lock.ts`). Замок держит единственность у тех, кто
-- его берёт; строку, заведённую мимо — ручным SQL, сидом, будущим новым
-- путём, — остановит только ограничение базы. Поэтому нужны оба.
--
-- ВНИМАНИЕ: ЭТОТ ФАЙЛ МОЖЕТ НЕ ПРИМЕНИТЬСЯ, И ЭТО НЕ ОШИБКА ФАЙЛА.
-- Если дубли уже лежат в базе (у prompt_versions это вероятно: до
-- появления PromptRegistryService версии активировали ручным SQL),
-- индекс не построится. Поэтому ниже сначала стоит проверка, которая
-- НАЗЫВАЕТ конкретные группы-нарушители, а не оставляет оператора с
-- сообщением «could not create unique index». Разобрать дубли —
-- решение человека: какую версию промпта оставить активной, знает он,
-- а не миграция.
--
-- Prisma фильтрованный уникальный индекс в schema.prisma не выражает,
-- поэтому он живёт здесь, а в схеме над каждой моделью стоит ссылка на
-- этот файл — иначе ограничение было бы невидимо читающему схему.
--
-- Без CONCURRENTLY намеренно: таблицы маленькие (версии промптов,
-- участники одного дела), а CONCURRENTLY нельзя внутри блока DO и
-- нельзя в транзакции, то есть пришлось бы разнести проверку и
-- создание. Все операции идемпотентны, файл выдерживает повторное
-- применение.

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(src || ': ' || grp || ' (' || n || ')', '; ')
    INTO bad
    FROM (
      SELECT 'prompt_versions.promptId' AS src, "promptId" AS grp, count(*) AS n
        FROM "prompt_versions" WHERE "status" = 'ACTIVE'
        GROUP BY "promptId" HAVING count(*) > 1
      UNION ALL
      SELECT 'dtp_participants.configId', "configId", count(*)
        FROM "dtp_participants" WHERE "role" = 'SELF'
        GROUP BY "configId" HAVING count(*) > 1
      UNION ALL
      SELECT 'family_law_parties.configId', "configId", count(*)
        FROM "family_law_parties" WHERE "role" = 'SELF'
        GROUP BY "configId" HAVING count(*) > 1
    ) AS dupes;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'Единственность не включена: дубли уже в базе — %. Оставьте по одной строке в каждой названной группе и примените файл заново. Какую оставить, решает человек, а не миграция.', bad;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "prompt_versions_promptId_active_key"
  ON "prompt_versions" ("promptId")
  WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS "dtp_participants_configId_self_key"
  ON "dtp_participants" ("configId")
  WHERE "role" = 'SELF';

CREATE UNIQUE INDEX IF NOT EXISTS "family_law_parties_configId_self_key"
  ON "family_law_parties" ("configId")
  WHERE "role" = 'SELF';

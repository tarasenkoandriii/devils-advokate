-- Сверка удаления проекта 2026-09-04 — факты, пережившие удаление.
--
-- Было: PersonFact.projectId с ON DELETE SET NULL. Удаление проекта
-- превращало факт со scope='PROJECT' в строку с projectId=NULL — то есть
-- в состояние, которое сервис запрещает создавать («projectId обязателен
-- при scope=PROJECT»). Читают такие факты как {scope:'PROJECT', projectId},
-- поэтому осиротевшая строка не находится никогда — но существует. Человек
-- нажал «удалить проект», а собранные там сведения о другом человеке
-- остались в базе, недоступные ни для просмотра, ни для удаления.
--
-- Стало: ON DELETE CASCADE. Факты других scope хранят projectId=NULL по
-- определению, поэтому каскад их не касается — уходят ровно те, что
-- принадлежали удалённому проекту.
--
-- Применять по DIRECT_URL (не через пулер).

ALTER TABLE "person_facts" DROP CONSTRAINT IF EXISTS "person_facts_projectId_fkey";

ALTER TABLE "person_facts"
  ADD CONSTRAINT "person_facts_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Уборка уже осиротевших строк. Это НЕ побочный эффект: ровно эти факты
-- человек и просил удалить, нажимая «удалить проект»; они пережили
-- удаление по ошибке и с тех пор невидимы. Пересчитайте перед
-- применением, если хотите знать объём:
--   SELECT count(*) FROM "person_facts" WHERE "scope" = 'PROJECT' AND "projectId" IS NULL;
DELETE FROM "person_facts" WHERE "scope" = 'PROJECT' AND "projectId" IS NULL;

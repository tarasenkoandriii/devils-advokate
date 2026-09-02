# «AI-провайдер недоступен» при настроенных ключах — 2026-09-01

> **Дополнено в тот же день (Пункт [router-simplify]).** Разбор причины
> ниже верен и остаётся полезным как история дефекта, но САМА
> КОНСТРУКЦИЯ, которая его порождала, упразднена: capability больше не
> заводится на пару (модель × задача), подбор идёт по наличию ключа.
> Инструкции ниже про «добавить taskType в сид» и SQL деактивации
> openai/anthropic относятся к прежней схеме — актуальный порядок см. в
> `AUDIT-RERUN-2026-09-01.md`, раздел [router-simplify].

По живому прогону песочницы: Шаг 3 (intake-квиз) отвечает «Не удалось
оценить ситуацию — AI-провайдер недоступен», при том что в Vercel
заданы GEMINI_API_KEY, XAI_API_KEY, ASSEMBLYAI_API_KEY и остальные, а
чек-лист готовности зелёный.

## Причина: ключи тут ни при чём

`AIRouterService.execute()` НЕ ищет провайдера по env. Порядок такой:

1. `resolveModelVersion(taskType)` → `AIModelCapability.findFirst({
   where: { taskType, availability: 'active' } })` в БД;
2. если строки нет — `AIRouterNoCapableModelError`, **до** любого
   обращения к провайдеру и до чтения ключа;
3. вызывающий сервис ловит любую ошибку роутера и отдаёт
   `BadGateway` с текстом «AI-провайдер недоступен».

То есть сообщение говорит «провайдер», а сломана конфигурация БД.
`intake-classify` — ровно этот случай: capability для него не
создавалась никогда.

## Масштаб: 25 taskType из 65

Сверка кода с сидом: продовый код использует 65 taskType, сид создавал
capability для 40. Не работали (при любых ключах) **все семь доменных
сценариев целиком**, intake-квиз, AI-фоллбек факт-чека и подсказки на
собеседовании:

```
intake-classify
dtp-onboarding-extract, dtp-consultation-breakdown, dtp-cross-consultation-check
family-law-onboarding-extract, family-law-consultation-breakdown,
family-law-cross-consultation-check
health-onboarding-extract, health-consultation-breakdown
major-purchase-onboarding-extract, major-purchase-onboarding-checklist,
major-purchase-meeting-conclusion, major-purchase-price-extraction
investment-onboarding-extract, investment-meeting-breakdown
interview-pool-onboarding-extract, interview-pool-questionnaire-draft,
interview-pool-relevance, interview-pool-agenda-reuse-detection,
interview-pool-client-report-conclusion, live-hint-interview
job-search-onboarding-extract, job-search-cv-draft, job-search-vacancy-match
fact-check-ai-fallback
```

Класс ошибки — «список в сиде отстаёт от кода»: каждая новая фича
добавляла taskType в сервис и не добавляла в сид, а отказ выглядел как
проблема провайдера, поэтому искали его в ключах.

## Что сделано

1. **Сид дополнен** — все 25 taskType добавлены в `prisma/seed.ts`,
   список разбит по доменам с комментариями. Сид идемпотентен
   (`findFirst` → `create`), повторный прогон ничего не дублирует.
2. **Тест `ai-capabilities-coverage.spec.ts`** — сверяет два источника
   напрямую: taskType из кода против taskType из сида, в обе стороны
   (нет непокрытых; нет мёртвых). Падает на CI в момент расхождения,
   называя конкретные taskType. Проверено от противного: удаление
   `intake-classify` из сида роняет тест с его именем в сообщении.
3. **Чек-лист песочницы** получил отдельный пункт «Модели под задачи
   (AIModelCapability)». Старый пункт «Сид БД» зелёный при одном лишь
   наличии AIProvider — и был зелёным всё это время. Новый пункт
   проверяет две вещи подряд и краснеет на каждой:
   - нет capability → «нет активной модели для: intake-classify, … —
     выполните npm run prisma:seed (ключи тут ни при чём)»;
   - capability есть, но у **выигравшей** модели провайдер без ключа →
     «модели настроены, но у выигравшего провайдера нет ключа:
     intake-classify → openai (OPENAI_API_KEY) …». Пункт берёт ровно ту
     строку, что возьмёт роутер (`findFirst` + `orderBy createdAt asc`).
   Три теста: красный по capability, красный по ключу выигравшего
   провайдера, зелёный при полном покрытии.

## Что сделать на проде

Одна команда против продовой БД — новых миграций не требуется, только
строки в существующей таблице:

```bash
DATABASE_URL='<прод>' npm run prisma:seed --workspace=apps/api
```

После этого перепроверить Шаг 1 песочницы: пункт «Модели под задачи»
должен стать зелёным, и Шаг 3 (intake-квиз) начнёт отвечать.

Если после сида останется «AI-провайдер недоступен» — это уже другой
слой (ключ/квота/сеть провайдера), и он виден в Runtime Logs Vercel по
записи `Job … exhausted, last error: …` с телом ответа провайдера.

## Второй слой: сида может не хватить — проверьте ключ выигравшей модели

На скриншоте окружения есть `GEMINI_API_KEY` и `XAI_API_KEY`, но нет
`OPENAI_API_KEY` и `ANTHROPIC_API_KEY`. Сид создаёт capability на все
три текстовые модели в порядке openai → anthropic → xai, а роутер берёт
**самую раннюю созданную** — то есть openai. И автоматического перехода
на другого провайдера у него НЕТ: fallback срабатывает только при
заранее проставленном на job `fallbackModelVersionId`, чего вызывающие
сервисы не делают.

То есть после сида текстовые фичи пойдут в openai и упадут на
отсутствующем ключе — на этот раз честно, ошибкой провайдера
(`Job … exhausted, last error: … 401`), но результат для пользователя
тот же. Поэтому одно из двух:

- добавить `OPENAI_API_KEY` в окружение, либо
- деактивировать openai/anthropic-capability, оставив активной xai:

```sql
-- Имена таблиц из @@map — snake_case; имена КОЛОНОК Prisma не мапит,
-- они остались camelCase и требуют двойных кавычек.
UPDATE ai_model_capabilities SET availability = 'deprecated'
WHERE "modelVersionId" IN (
  SELECT mv.id FROM ai_model_versions mv
  JOIN ai_models m    ON m.id = mv."modelId"
  JOIN ai_providers p ON p.id = m."providerId"
  WHERE p.name IN ('openai', 'anthropic')
);
```

(роутер выбирает строки строго по `availability = 'active'`, поэтому
подойдёт любое другое значение; в схеме документированы
`active | beta | deprecated`).

**Два побочных эффекта, названных повторным аудитом** — знать до
выполнения:
1. `GET /ai-engines` фильтрует по тому же `availability: 'active'`, то
   есть openai/anthropic пропадут и из пользовательского селектора
   движков, не только из авто-подбора.
2. Деактивация — не жёсткая блокировка: ветка `preferredModelVersionId`
   в `resolveModelVersion` не проверяет `availability` вообще, и
   клиент, приславший id деактивированной версии, всё равно уйдёт в
   openai и получит 401.

Это штатный способ смены приоритета, заложенный в роутер: «первая настроенная выигрывает, смена приоритета —
деактивацией старой записи, явным действием». Новый пункт чек-листа
после этого показывает, чей ключ реально нужен.

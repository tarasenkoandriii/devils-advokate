# Внешние API и ключи

Два независимых списка:

1. **[Полный реестр](#1-полный-реестр-внешних-api)** — все внешние сервисы, которые вызывает `apps/api`, с точными именами переменных и последствиями отсутствия ключа.
2. **[Минимальный набор для разбора YouTube-видео](#2-минимальный-набор-для-разбора-youtube-видео)** — только то, без чего эта конкретная цепочка не работает, с пошаговой инструкцией, где взять каждый ключ.

Составлено повторным аудитом 2026-08-30 обходом всех 31 внешнего HTTP-вызова в `apps/api/src`, не по документации и не по памяти.

---

## 0. Как ключи вообще попадают в код

Три разных пути — это важно понимать, потому что «переменная задана, а сервис её не видит» почти всегда объясняется именно здесь:

| Путь | Где | Пример |
| --- | --- | --- |
| `SecretsService.resolve('ИМЯ')` | большинство сервисов | `YOUTUBE_API_KEY`, `ELEVENLABS_API_KEY` |
| `AIProvider.credentialRef` из БД → `SecretsService.resolve(...)` | LLM-провайдеры и AssemblyAI | в таблице `ai_providers` лежит **имя переменной**, не ключ |
| `process.env` / `ConfigService` напрямую | инфраструктурные | `DATABASE_URL`, `API_PUBLIC_BASE_URL`, `TELEGRAM_BOT_TOKEN` |

Второй путь означает, что сначала должен быть выполнен `prisma/seed.ts` — без записей `AIProvider` резолвить будет нечего, и ошибка будет выглядеть как «provider not found», а не «нет ключа».

Валидации переменных при старте нет (`ConfigModule.forRoot({ isGlobal: true })` без `validationSchema`) — **приложение поднимается с любым набором ключей**, и каждый отсутствующий проявляется только при первом обращении к своей фиче. Для дев-стенда это удобно; для прода это значит, что «задеплоилось» не равно «работает».

---

## 1. Полный реестр внешних API

### 1.1 LLM-провайдеры

| Сервис | Переменная | Вызовы | От чего зависит | Без ключа |
| --- | --- | --- | --- | --- |
| **OpenAI** | `OPENAI_API_KEY` | `POST /v1/chat/completions` | все ~38 AI-задач: генерация аргументов, steelman, спарринг, детектор манипуляций, анализ расхождений, протокол, live-подсказки | 502 на конкретной фиче после 2 попыток |
| **Anthropic** | `ANTHROPIC_API_KEY` | `POST /v1/messages` | то же | то же |
| **xAI (Grok)** | `XAI_API_KEY` | `POST /v1/chat/completions` | то же | то же |

Нужен **как минимум один** из трёх. Какой именно будет вызван — определяется записью `AIModelCapability` в БД (`ai-router.service.ts` берёт первую активную для нужного `taskType`), а не переменной окружения. Автоматического перебора провайдеров при отказе нет: fallback срабатывает, только если на задаче заранее проставлена `fallbackModelVersionId`.

### 1.2 Речь

| Сервис | Переменная | Вызовы | От чего зависит | Без ключа |
| --- | --- | --- | --- | --- |
| **AssemblyAI** (STT + диаризация) | `ASSEMBLYAI_API_KEY` | `POST /v2/upload`, `POST /v2/transcript`, `GET /v2/transcript/{id}`, `GET /v3/token` (live) | расшифровка разговоров, голосовые реплики спарринга и чата по материалам, live-режимы | 500 на загрузке и расшифровке |
| **AssemblyAI webhook** | `ASSEMBLYAI_WEBHOOK_SECRET` | входящий `POST` от провайдера | возврат результата расшифровки | **fail closed**: задача вообще не отправляется, вебхук отвечает 503 |
| **AssemblyAI webhook** | `API_PUBLIC_BASE_URL` | адрес, который передаётся провайдеру | то же | ошибка до отправки задачи |
| **ElevenLabs** (TTS) | `ELEVENLABS_API_KEY` | `POST /v1/text-to-speech/{voiceId}` | озвучка реплик AI-собеседника | 500 на `POST /tts` |

### 1.3 Google

| Сервис | Переменная | Вызовы | От чего зависит | Без ключа |
| --- | --- | --- | --- | --- |
| **YouTube Data API v3** | `YOUTUBE_API_KEY` | `search.list`, `videos.list` | поиск ролика для очереди медиа-разбора (**только метаданные**, никакого видео/аудио) | 500 на `GET /media-review/youtube-search` |
| **Fact Check Tools API** | `FACT_CHECK_TOOLS_API_KEY` | `claims:search` | сверка реплики с уже проведёнными фактчеками | 500 только на этом эндпоинте; три других источника сверки работают |
| **Places API (legacy)** | `GOOGLE_PLACES_API_KEY` | `nearbysearch`, `textsearch`, `details` | рекомендация заведения для встречи, заявка владельца, локация крупной покупки | 500 на этих трёх фичах |
| **Cloud Vision** | `GOOGLE_VISION_API_KEY` | `images:annotate` (`TEXT_DETECTION`) | OCR лабораторных документов | 500 на загрузке документа |

⚠️ Places API — **legacy-версия**, заморожена Google с марта 2025: работает, но новых возможностей не получает. Миграция на Places API (New) — не косметическая правка (GET→POST, другая форма ответа, обязательный field mask).

### 1.4 Прочее

| Сервис | Переменная | Вызовы | От чего зависит | Без ключа |
| --- | --- | --- | --- | --- |
| **SerpApi** (Google Lens) | `SERPAPI_KEY` | `GET /search?engine=google_lens` | реверс-поиск фото | 500 на проверке фото |
| **Vercel Blob** | `VERCEL_BLOB_READ_WRITE_TOKEN` | `PUT /{pathname}`, `POST /delete` | доказательства ДТП; временная публикация фото на время реверс-поиска | 500 на этих фичах; удаление аккаунта деградирует мягко |
| **Telegram Bot API** | `TELEGRAM_BOT_TOKEN` | `POST /bot{token}/sendMessage` | push-напоминания планировщика | см. ниже — **особый случай** |
| **Windy Point Forecast** | `WINDY_API_KEY` | `POST /api/point-forecast/v2` | прогноз погоды к дате встречи (первичный источник) | ✅ тихий откат на Open-Meteo — единственная по-настоящему опциональная интеграция |
| **Open-Meteo** | — | `geocoding`, `forecast` | тот же прогноз (fallback) | ключ не нужен вовсе |
| **Nominatim (OSM)** | — | `GET /reverse` | подсказка страны/города при онбординге | ключ не нужен; при ошибке — честный пустой результат |
| **Произвольный URL пользователя** | — | `GET` через `safe-url-fetch` | «проверь эту реплику по моей ссылке» | — |

**`TELEGRAM_BOT_TOKEN` — единственная переменная, отсутствие которой ломает API целиком, а не одну фичу.** `TelegramAuthGuard` резолвит её через `getOrThrow` при валидации каждого запроса: без неё 500 отдают **все** эндпоинты под этим guard'ом, то есть весь продукт. Исключение — дев-режим: при `ALLOW_DEV_AUTH=true` запрос с заголовком `X-Dev-User-Id` до этой строки не доходит, поэтому локальный стенд работает без бота.

### 1.5 Служебные переменные (не ключи внешних сервисов)

| Переменная | Назначение | Обязательность |
| --- | --- | --- |
| `DATABASE_URL` | Postgres; на Vercel — **пулированное** соединение (порт 6543, `?pgbouncer=true`) | обязательна |
| `DIRECT_URL` | прямое соединение для DDL (`migrate`/`db push`) | обязательна |
| `CORS_ORIGIN` | список доменов через запятую (TMA + админка + лендинг) | **обязательна в проде** — там fail closed, без неё блокируются все cross-origin запросы |
| `ALLOW_DEV_AUTH` | дев-входы | в проде `false`/не задавать |
| `SECRET_PROVIDER_TYPE` | `env` (рабочий) либо `managed` (заглушка, бросает ошибку) | по умолчанию `env` |
| `SCHEDULER_DISPATCH_SECRET` | `x-dispatch-secret` для трёх pg_cron-эндпоинтов | нужна, если используются фоновые задания |
| `API_PUBLIC_BASE_URL` | собственный публичный адрес API для вебхуков | нужна для расшифровки |
| `PORT` | локальный запуск | на Vercel не нужна |

---

## 2. Минимальный набор для разбора YouTube-видео

### 2.1 Как эта цепочка устроена на самом деле

Важное свойство, которое определяет весь список ключей: **проект не скачивает видео с YouTube.** Через YouTube Data API берутся только метаданные (`videoId`, заголовок, канал, превью, длительность) — это сознательное ограничение (ТЗ медиа-разбора §2.2), а не недоделка: скачивание чужого видео и извлечение из него аудио — юридически другая история, чем документированный вызов официального API.

Файл добывает и загружает **сам пользователь**, обычным флоу разговора:

```
1. GET  /media-review/youtube-search?query=…        → метаданные роликов   [YOUTUBE_API_KEY]
2. POST /media-review/queues, .../items             → очередь разбора      [ключи не нужны]
3. пользователь сам получает файл ролика
4. POST /projects/:id/conversations                 → создать разговор
5. POST /conversations/:id/upload                   → байты уходят AssemblyAI  [ASSEMBLYAI_API_KEY]
6. POST /conversations/:id/transcribe               → запуск расшифровки   [+ WEBHOOK_SECRET, API_PUBLIC_BASE_URL]
7. AssemblyAI → POST /conversations/webhook/transcription  → готовый транскрипт
8. POST .../manipulation-patterns/detect            → анализ               [LLM-ключ]
   POST .../discrepancies/detect                    → анализ               [LLM-ключ]
   POST .../turning-points/detect                   → анализ               [LLM-ключ]
9. POST .../discrepancies/check-against-fact-check-api → фактчек  [FACT_CHECK_TOOLS_API_KEY, опционально]
```

**Две ловушки, которые стоит знать заранее:**

- Шаги 8 запускаются **вручную**, автоматической оркестрации после расшифровки нет. Элемент очереди переходит в `DONE` только когда разговор получил статус `ANALYZED`, а этот статус ставит **только** `turning-points/detect`. Пройти манипуляции и расхождения и остаться навсегда в `PROCESSING` — штатное поведение, не баг.
- Шаги 5–7 требуют, чтобы AssemblyAI **достучался до вашего API снаружи**. На `localhost` он этого не может; нужен туннель.

### 2.2 Минимальный список

Семь переменных — без любой из них цепочка не проходит целиком:

| # | Переменная | Что сломается без неё |
| --- | --- | --- |
| 1 | `DATABASE_URL` | всё: очередь, транскрипт, сигналы, реестр провайдеров |
| 2 | `TELEGRAM_BOT_TOKEN` | 500 на **каждом** шаге 1–9 (либо `ALLOW_DEV_AUTH=true` — см. ниже) |
| 3 | `YOUTUBE_API_KEY` | шаг 1: поиск ролика |
| 4 | `ASSEMBLYAI_API_KEY` | шаги 5–6: загрузка и расшифровка |
| 5 | `ASSEMBLYAI_WEBHOOK_SECRET` | шаг 6 отказывает заранее (fail closed), шаг 7 отвечает 503 |
| 6 | `API_PUBLIC_BASE_URL` | шаг 6: адрес вебхука не собрать. Должен быть **достижим извне** |
| 7 | `OPENAI_API_KEY` **или** `ANTHROPIC_API_KEY` **или** `XAI_API_KEY` | шаг 8: анализ |

Восьмая, `FACT_CHECK_TOOLS_API_KEY`, — только для шага 9.

**Кроме переменных нужно состояние БД и согласия:**

- выполненный `prisma/seed.ts` — записи `AIProvider` / `AIModelVersion` / `AIModelCapability`, иначе резолвить `credentialRef` будет нечего;
- активные `ConsentRecord` для `RECORDING`, `EPHEMERAL_SERVER` (расшифровка) и `EXTERNAL_AI` (анализ) — выдаются из TMA, экран согласия появляется перед загрузкой файла;
- `User.privacyProcessingMode` ≠ `MAXIMUM_PRIVACY` — этот режим запрещает облачную расшифровку в принципе, согласием не обходится.

Локально `TELEGRAM_BOT_TOKEN` можно не заводить вовсе: при `ALLOW_DEV_AUTH=true` запрос с заголовком `X-Dev-User-Id: 123` проходит аутентификацию без Telegram (см. `DOCKER.md`). В проде — обязателен.

### 2.3 Где взять каждый ключ

#### `YOUTUBE_API_KEY` — YouTube Data API v3

1. [console.cloud.google.com](https://console.cloud.google.com) → создать проект (или выбрать существующий).
2. **APIs & Services → Library** → найти **YouTube Data API v3** → **Enable**.
3. **APIs & Services → Credentials** → **Create credentials → API key**.
4. Сразу нажать **Restrict key**: **API restrictions → Restrict key → YouTube Data API v3**. Ключ уходит на бэкенд, а не в браузер, поэтому ограничение по HTTP-referrer не подходит — ограничивайте по API, при желании по IP.

**Бесплатно, но квота — реальное ограничение.** 10 000 единиц в сутки **на проект**, и `search.list` стоит **100 единиц** за вызов: около 100 поисков в сутки на весь продукт, не на пользователя. Поэтому в коде стоит собственный лимит 20 поисков в сутки на пользователя — чтобы один активный человек не съел общую квоту. Квота тратится и на неудачные запросы. Поднять её можно только через форму запроса квоты в Google Cloud (рассматривается вручную).

#### `ASSEMBLYAI_API_KEY` — расшифровка и диаризация

1. [assemblyai.com](https://www.assemblyai.com) → регистрация.
2. **Dashboard → API Keys** → скопировать ключ.
3. Для реальной работы привязать карту: бесплатный лимит небольшой, тарификация поминутная.

Диаризация (`speaker_labels`) включается запросом и отдельного ключа не требует.

#### `ASSEMBLYAI_WEBHOOK_SECRET` — не выдаётся, генерируется вами

Это ваш собственный секрет: API передаёт его провайдеру при постановке задачи, а провайдер возвращает в заголовке вместе с результатом — так вебхук отличает настоящий callback от постороннего запроса.

```bash
openssl rand -base64 32
```

Значение попадает в `.env` (и в Vercel env) и больше никуда. Проверка **fail closed**: без секрета задача на расшифровку вообще не отправляется — лучше явный отказ, чем job, результат которого некому принять.

#### `API_PUBLIC_BASE_URL` — адрес, куда AssemblyAI вернёт результат

- **Прод:** URL самого API-проекта, например `https://devils-advocate-api.vercel.app`, без слэша на конце.
- **Локально:** `http://localhost:3000` **не подойдёт** — провайдер не может достучаться до вашей машины. Нужен туннель:

```bash
ngrok http 3000          # или: cloudflared tunnel --url http://localhost:3000
```

Полученный `https://…` адрес и есть значение переменной. При перезапуске ngrok адрес меняется — переменную придётся обновить и перезапустить API.

#### LLM-ключ (нужен один)

| Провайдер | Где | Примечание |
| --- | --- | --- |
| OpenAI | [platform.openai.com](https://platform.openai.com) → **API keys** → Create | нужен пополненный баланс, бесплатного тарифа нет |
| Anthropic | [console.anthropic.com](https://console.anthropic.com) → **API keys** | то же |
| xAI | [console.x.ai](https://console.x.ai) → **API keys** | то же |

Ключ должен соответствовать провайдеру, чья `AIModelCapability` активна в БД для нужной задачи (`manipulation-detection`, `discrepancy-analysis`, `turning-point-detection`). Проще всего на старте задать все три ключа либо оставить в БД capability только одного провайдера — иначе выбор недетерминирован (сервис берёт первую подходящую запись без явной сортировки; отмечено в отчёте аудита).

#### `FACT_CHECK_TOOLS_API_KEY` — опционально

1. Тот же [console.cloud.google.com](https://console.cloud.google.com), можно тот же проект, что и для YouTube.
2. **Library → Fact Check Tools API → Enable**.
3. **Credentials → Create credentials → API key** (годится и тот же ключ, если разрешить оба API).

Используется только `claims:search` — поиск по уже опубликованным фактчекам аккредитованных изданий, не произвольный веб-поиск. OAuth не нужен: он требуется лишь для публикации собственных фактчеков (ClaimReview), чего проект не делает. Ответы кешируются на 24 часа.

### 2.4 Готовый `.env` для этой цепочки

```bash
DATABASE_URL="postgresql://devils_advocate:devils_advocate@localhost:5432/devils_advocate"
DIRECT_URL="postgresql://devils_advocate:devils_advocate@localhost:5432/devils_advocate"

# Локально бота можно не заводить — вместо него дев-вход:
ALLOW_DEV_AUTH="true"
TELEGRAM_BOT_TOKEN=""

YOUTUBE_API_KEY="AIza…"
ASSEMBLYAI_API_KEY="…"
ASSEMBLYAI_WEBHOOK_SECRET="сгенерировать: openssl rand -base64 32"
API_PUBLIC_BASE_URL="https://ваш-туннель.ngrok-free.app"

OPENAI_API_KEY="sk-…"        # достаточно одного из трёх

FACT_CHECK_TOOLS_API_KEY=""  # опционально
```

Для докер-стенда те же значения вписываются в `.env.docker` — `DATABASE_URL` и `ALLOW_DEV_AUTH` там уже проставлены, см. `DOCKER.md`.

### 2.5 Как проверить, что цепочка собралась

```bash
# 1. поиск (проверяет YOUTUBE_API_KEY и квоту)
curl -s "http://localhost:3000/media-review/youtube-search?query=дебаты" \
  -H 'X-Dev-User-Id: 123' | jq '.data[0]'

# 2. очередь
curl -s -X POST http://localhost:3000/media-review/queues \
  -H 'X-Dev-User-Id: 123' -H 'Content-Type: application/json' \
  -d '{"title":"Проверка"}' | jq

# 3. загрузка файла (проверяет ASSEMBLYAI_API_KEY и согласия)
curl -s -X POST "http://localhost:3000/conversations/<id>/upload" \
  -H 'X-Dev-User-Id: 123' --data-binary @audio.m4a | jq
```

Типичные ответы и что они означают:

| Ответ | Причина |
| --- | --- |
| `403 Consent required: RECORDING` | не выданы согласия — пройдите экран согласия в TMA или задайте `SEED_DEV_CONSENTS=true` |
| `403 privacyProcessingMode=MAXIMUM_PRIVACY` | режим приватности запрещает облачную расшифровку; согласием не обходится |
| `502 YouTube Data API вернул ошибку (403)` | исчерпана суточная квота проекта либо ключ не ограничен/не активирован |
| `500 Secret not found for credentialRef="…"` | переменная не задана в окружении процесса API |
| разговор навсегда в `TRANSCRIBING` | вебхук не дошёл: `API_PUBLIC_BASE_URL` недоступен снаружи |
| элемент очереди навсегда в `PROCESSING` | не вызван `turning-points/detect` — только он ставит `ANALYZED` |

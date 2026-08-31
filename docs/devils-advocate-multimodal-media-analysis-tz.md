# ТЗ — Полностью автоматический мультимодальный анализ медиа

**Редакция 2**, 2026-08-31. Учтены все находки `AUDIT-MULTIMODAL-TZ-2026-08-31.md`
(3 блокирующие, 3 существенные, 4 уточнения). Изменения относительно редакции 1 помечены
в тексте как **[R2]**; сводка — §12.1.

Основание: пересмотр §2.2 `devils-advocate-media-review-tz.md` (см. §1) + расширение
аналитического конвейера на паралингвистику (§2).
Компаньон к: `devils-advocate-media-review-tz.md`, `devils-advocate-prompt-framework-tz.md`,
`devils-advocate-telemetry-tz.md`, `devils-advocate-domain-ui-and-voice-intake-tz.md`.

Паттерн проекта сохраняется: этот документ → самоаудит (§12) → реализация → пост-аудит.
Аудит редакции 1 выполнен до реализации и до единой написанной строки кода — ни одна из
блокирующих находок не дошла бы до прода дешевле, чем здесь.

---

## 0. Ключевое архитектурное решение — мы по-прежнему ничего не скачиваем

**Требование владельца:** анализ видео **без ручного скачивания пользователем**, полностью
автоматическая система, от выбора ролика до готового разбора, без единого шага «сходи, скачай,
загрузи обратно».

**Решение:** URI отдаётся провайдеру, содержимое забирает провайдер.

```
media-review:  youtubeVideoId ──→ { type:"video", uri:"https://youtube.com/watch?v=…" }
своя запись:   audioBlobPathname ──→ presign ──→ { type:"video", uri:"<signed blob URL>", mime_type }
                                                    │
                                      POST /v1beta/interactions { background: true }
                                                    │
                                          обе дорожки: видео + аудио
                                                    ↓
                              GET /v1beta/interactions/{id} → status: completed
                                                    ↓
                                  структурированный JSON с таймкодами MM:SS
                                                    ↓
              Transcript + TranscriptSegment[] + ConversationParticipant[]
                                                    ↓
                              AIInference → ConversationSignal[] → TMA
```

**[R2]** Две правки схемы против редакции 1: интерфейс — Interactions API с `background: true`
(§4, §5), и явный шаг персистенса транскрипта/участников перед сигналами (§6.2) — без него
`getSummary()` очереди возвращал бы ноль находок при любом их количестве.

Ни `yt-dlp`, ни любого другого серверного загрузчика в проекте не появляется. Байты стороннего
контента **не проходят через нашу инфраструктуру и не сохраняются в ней ни на секунду**. Принцип
§2.2 media-review ТЗ («система сама нічого не завантажує») **сохраняется дословно** — меняется
только то, что ручной шаг пользователя больше не нужен, потому что нашёлся третий путь, которого
в §2.2 не было.

Это и есть весь смысл документа: **полная автоматизация достигается не ослаблением ограничения,
а тем, что ограничение оказалось совместимо с автоматизацией.**

---

## 1. Пересмотр §2.2 media-review ТЗ — основание, а не отмена

### 1.1 Что говорило §2.2 и почему

§2.2 отвергло автоматизацию приобретения видео, рассмотрев **два** пути:

1. **Серверный `yt-dlp`** — отклонён со ссылкой на федеральный иск от 23.01.2026 (Central
   District of California, дело **2:26-cv-00754**, TED Entertainment / MrShortGame / Golfholics
   против Snap Inc.), где ответчику вменяется массовая загрузка YouTube-видео именно через
   `yt-dlp` с ротацией IP **именно для AI-анализа**. Технический паттерн совпадал буквально.
2. **`captions.download` (YouTube Data API)** — отклонён: требует OAuth как **владелец канала**,
   для чужого контента недоступен.

Вывод §2.2 — «файл получает пользователь сам, вне приложения» — был **правильным при этих двух
вариантах**.

### 1.2 Третий путь, который в §2.2 не рассматривался

Gemini API принимает YouTube-ссылку **нативно**, как часть контента запроса:

```json
{ "type": "video", "uri": "https://www.youtube.com/watch?v=VIDEO_ID" }
```

Проверено по официальной документации (`ai.google.dev/gemini-api/docs/video-understanding`,
сверено 2026-08-31):

| Параметр | Значение |
|---|---|
| Доступ | **только публичные** видео (не private, не unlisted) |
| Видео на запрос | Gemini 2.5 и новее — до **10**; до 2.5 — 1 |
| Free tier | не более **8 часов** YouTube-видео в сутки, **на API-ключ, не на пользователя** (§9.3) |
| Paid tier | ограничения по длине нет |
| Обрабатываемые потоки | **видео и аудио одновременно** |
| Дискретизация | 1 кадр/сек, аудио 1 Kbps моно |
| Токены | ~300/сек видео по полной ставке (~100/сек при пониженном разрешении — параметр в Interactions API не подтверждён, см. §5) |
| Таймкоды | ссылка в промпте в формате **MM:SS** |
| Доп. авторизация | не требуется, обычный API-ключ Gemini |

> **[R2] Версии моделей из этого документа брать нельзя.** Примеры актуальной документации
> используют `gemini-3.7-flash`; строка «2.5 и новее» описывает границу возможности (10 роликов
> на запрос), а не рекомендуемую версию. Конкретное значение для сида `AIModelVersion.version`
> берётся из списка моделей, доступных вашему ключу, **на момент реализации** — иначе сид уедет
> в прод с устаревшей версией. Это же относится к любым числам этой таблицы: они сверены
> 2026-08-31 и требуют перепроверки перед фазой C.

### 1.3 Почему это не обход отклонённого решения

Отличие структурное, не косметическое:

| | `yt-dlp` (отклонено §2.2) | Gemini URI (это ТЗ) |
|---|---|---|
| Кто получает контент | **наш сервер** | **Google** |
| Байты в нашей инфраструктуре | да, весь файл | **нет, никогда** |
| Обход технических мер YouTube | да (извлечение потока) | нет, документированный API |
| Ротация IP, эмуляция клиента | требуется на масштабе | не применимо |
| Совпадение с паттерном иска 2:26-cv-00754 | **буквальное** | отсутствует |
| Хранение стороннего контента | требуется | не требуется |

Технический паттерн, находящийся под судебным рассмотрением, здесь **отсутствует целиком**, а не
смягчён. Юридическая оценка при этом остаётся за юрисконсультом — см. §13, оговорка не снимается.

### 1.4 Формальный статус

`devils-advocate-media-review-tz.md` §2.2 **отменяется и заменяется** настоящим документом
в части способа приобретения контента. Остальные разделы media-review ТЗ (§2.1 поиск, §2.3
очередь и последовательный режим, §2.4 Fact Check Tools, §3 этические границы, §4 схема)
действуют **без изменений**. §2.2a (субтитры) остаётся отклонённым по той же причине.

`MediaReviewItemStatus.AWAITING_UPLOAD` при этом не удаляется — см. §6.3.

---

## 2. Второй потребитель того же канала — паралингвистика собственных записей

Сейчас конвейер разговоров устроен так:

```
Blob → AssemblyAI → TranscriptSegment (текст + SPEAKER_xx)
          ↓
  всё, что ниже, видит ТОЛЬКО ТЕКСТ:
  ManipulationDetector, DiscrepancyAnalysis, MotiveAnalysis,
  ProbingDetector, LiveHints, Steelman, TurningPoints
```

Диаризация даёт «кто говорил», но не даёт **как**: паузу перед ответом, срыв темпа, смену
интонации на конкретной фразе, несовпадение слов и подачи. Для продукта, чьё ядро — детекция
манипуляций, это существенный канал сигнала, и сейчас он теряется на первом же шаге.

Мультимодальный проход **не заменяет AssemblyAI, а надстраивается над ним**: транскрипт остаётся
источником истины по словам, таймкодам и диаризации; мультимодальный вызов добавляет оси, которых
в тексте нет, и привязывается к уже существующим `TranscriptSegment` по таймкодам.

Оба потребителя — публичное видео и своя запись — используют **один и тот же медиа-канал**
(§3–§5) и различаются только источником URI, промптом и уровнем согласий (§8).

---

## 3. Контракт провайдера — расширение, не обход

### 3.1 Почему расширяем `AIProviderClient`, а не строим отдельный сервис

Разобрано отдельно; фиксирую итог как основание:

1. **Схема уже спроектирована под мультимодальность.** `AIModelCapability` содержит
   `vision Boolean`, `audio Boolean`, `privacyClass String?`; в комментарии к `taskType` прямо
   перечислены `"vision_analysis"`, `"audio_transcription"`. Поиск по `apps/api/src` даёт
   **ноль чтений** этих полей. Это ваш же bug class «implemented but never called». Мультимодальный
   вызов — тот самый «первый реальный конфликт между несколькими подходящими моделями», до
   которого `resolveModelVersion()` откладывала учёт `privacyClass`.
2. **Прецедент обхода уже есть и уже стоил дорого.** `common/vision-ocr-client.ts` (Google Vision,
   health lab OCR) вызывается напрямую из `HealthService`, минуя роутер, и потерял: `AIJob`/
   `AIInference` (⇒ невидим в `/admin/telemetry`), retry и fallback, `ContentScanService`,
   версионирование промпта, выбор модели по `privacyClass`; consent и rate-limit пришлось
   переписать вручную. Для OCR — детерминированной задачи без промпта — это терпимо.
   Паралингвистический разбор частного разговора противоположен по каждой оси.
3. **Провенанс.** `ConversationSignalEvidence.aiInferenceId` — сквозной паттерн продукта
   (`Argument.derivedFromInferenceId`, `SteelmanCase`, `ConversationAgenda.generatedByInferenceId`).
   Обход не создаёт `AIInference` ⇒ самые оспариваемые сигналы продукта оказались бы
   единственными **без ссылки на источник**, без `userVerified`/`userDisputed`, без привязки к
   версии промпта. Для продукта, отстраивающегося от «AI-обёртки», это неприемлемо.

### 3.2 Новый контракт

`ai-router/ai-provider-client.ts`:

```ts
/** Ссылка на медиа, ещё НЕ разрешённая в URL. Хранится в таком виде
 * в AIJob.pendingRequest и разрешается в подписанный/публичный URI
 * в момент вызова — см. §4.3 и §10.1. */
export type MediaRef =
  | { source: 'youtube'; videoId: string }
  | { source: 'blob'; pathname: string; mimeType: string };

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'media'; ref: MediaRef; mediaResolution?: 'low' | 'default' };

export interface AIProviderCompletionParams {
  model: string;
  systemPrompt?: string;
  /** Строка остаётся полностью валидной — ни один существующий
   * вызов не меняется. */
  userPrompt: string | ContentBlock[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}
```

`AIRouterRequest.userPrompt` расширяется тем же типом.

**Обратная совместимость — жёсткое требование:** все существующие вызовы (`intake-classify`,
`argument-generation`, доменные `extract`, все 85+ `taskType`) передают строку и не правятся ни
одной строкой кода. Клиенты `OpenAiCompatibleClient` и `AnthropicClient` при получении
`ContentBlock[]` бросают явную ошибку «provider does not support media content blocks», а не
пытаются сериализовать блоки в текст.

### 3.3 Разрешение `MediaRef` → URI

Отдельный интерфейс, чтобы клиент провайдера не знал ни про Blob, ни про YouTube:

```ts
export interface MediaUriResolver {
  resolve(ref: MediaRef): Promise<{ uri: string; mimeType?: string }>;
}
```

Реализация (`MediaUriResolverService`, модуль `ai-router`):
- `youtube` → `https://www.youtube.com/watch?v=${videoId}` (без сетевых вызовов);
- `blob` → `presignUrl(pathname, { expiresIn })` из уже существующего `@vercel/blob`, тот же
  механизм, что `presignForTranscription` для AssemblyAI.

**[R2] Срок жизни подписи считается не от длительности вызова.** В фоновом режиме (§4) Google
забирает файл в неизвестный момент **после постановки задачи в свою очередь**, поэтому подпись
должна перекрывать всё окно ожидания, а не время обработки:

```ts
/** Потолок ожидания внешней задачи. Из него выводятся ОБА срока:
 * жизнь подписи и MEDIA_LEASE_MAX_AGE (§7.2). Назначать их
 * независимо друг от друга нельзя — разъедутся. */
export const EXTERNAL_INTERACTION_MAX_WAIT_MS = 2 * 60 * 60 * 1000; // 2 часа, пересмотреть по факту
export const PRESIGN_TTL_MS = EXTERNAL_INTERACTION_MAX_WAIT_MS + 15 * 60 * 1000; // + запас на забор файла
```

Значение 2 часа — **начальное и подлежит пересмотру по фактическому SLA очереди Google**, которое
в этой среде замерить нельзя (§12.2). Это назначенная константа, не измеренная.

---

## 4. Асинхронная полоса `AIRouterService` — обязательна, не оптимизация

### 4.1 Почему синхронный путь не подходит — и почему воркер тоже не должен ждать

Замеренные значения из реальных ответов Gemini (заголовок `server-timing: gfet4t7`):
**25 710 мс** и **32 405 мс** на ролик ~30 секунд.

В `apps/api/vercel.json`:

```json
"functions": { "api/index.ts": { "maxDuration": 10 } }
```

`AIRouterService.execute()` синхронен насквозь (`await client.complete(...)` внутри HTTP-запроса).
Мультимодальный вызов туда не помещается — тот же класс отказа, что уже ловили с лимитом 4,5 МБ на
тело функции: платформа отказывает выше нашего кода, локально не воспроизводится.

Поднятие `maxDuration` отклонено осознанно: разбор 20-минутного ролика не уложится и в 300 секунд.

**[R2] Редакция 1 предлагала переложить ожидание на pg_cron-воркер — это было половинчатым
решением.** Воркер тоже исполняется как функция и тоже имеет потолок; экстраполяция «30 секунд на
30-секундном ролике» на 20-минутный была помечена как непроверенная и могла оказаться нелинейной.
Интерфейс провайдера снимает вопрос целиком.

### 4.2 Фоновый режим провайдера — ожидание уходит на сторону Google

Interactions API принимает `"background": true` («long-running model interaction in the
background»), возвращает `id`, и результат забирается отдельным запросом:

```
POST https://generativelanguage.googleapis.com/v1beta/interactions   → { id, status }
GET  https://generativelanguage.googleapis.com/v1beta/interactions/{id} → { status, output_text, usage }
```

Статусы: `queued`, `in_progress`, `completed`, `requires_action`, `failed`, `cancelled`,
`incomplete`, `budget_exceeded`.

**Наша функция никогда не ждёт модель.** Постановка задачи ~1 с, опрос ~1 с — оба вызова
комфортно внутри `maxDuration: 10`, независимо от длительности ролика. Риск «непроверенной
экстраполяции латентности» из редакции 1 **исчезает**, а не смягчается.

Машина состояний, которая нам нужна, уже есть:

```prisma
enum AIJobStatus { QUEUED  RUNNING  COMPLETED  FAILED }
```

`QUEUED` сегодня живёт микросекунды, потому что все вызовы синхронные. Асинхронная полоса —
**использование существующей модели по назначению**, а не новая сущность.

```
POST (Vercel, <10 c)          submitQueued (pg_cron)        pollRunning (pg_cron)
────────────────────          ──────────────────────        ─────────────────────
consent → contentScan →       берёт QUEUED (SKIP LOCKED) →  берёт RUNNING с externalId →
resolveModelVersion →         resolve MediaRef → URI →      GET /interactions/{id} →
AIJob(QUEUED,                 POST /interactions            queued|in_progress → ждём
       pendingRequest) →        { background: true } →      completed → validateOutput →
202 { jobId }                 AIJob(RUNNING,                  AIInference → COMPLETED
        │                       externalInteractionId)      failed|cancelled|
        │                                                   budget_exceeded|incomplete → FAILED
        └── клиент поллит GET /ai-jobs/:id ──────────────────────────┘
```

Зачем при этом наша собственная очередь, если у Google уже есть своя: `AIJob` — единица **учёта**,
а не ожидания. Через неё идут провенанс (`AIInference`), телеметрия по `taskType`, ретраи и
fallback на другую модель, `ContentScanResult.aiJobId`, идемпотентность по `inputHash`. Ничего
из этого внешняя очередь не даёт.

### 4.3 Что добавляется в `AIJob`

```prisma
model AIJob {
  // … существующие поля без изменений …

  /** Сериализованный AIRouterRequest для QUEUED-джоб асинхронной
   * полосы. Медиа хранится как MediaRef (videoId/pathname), НЕ как
   * подписанный URL: подпись протухает, а inputHash по подписанному
   * URL был бы бесполезен для дедупликации (§10.1). Обнуляется тем же
   * апдейтом, что переводит джобу в COMPLETED/FAILED — «есть
   * pendingRequest» всегда значит «джоба ещё не исполнена». */
  pendingRequest Json?

  /** Момент, после которого джоба считается зависшей и переводится
   * в FAILED сторожевой джобой (§4.5). Для QUEUED — защита от упавшего
   * воркера; для RUNNING — потолок ожидания внешней задачи
   * (EXTERNAL_INTERACTION_MAX_WAIT_MS, §3.3). */
  leaseExpiresAt DateTime?

  /** [R2] id задачи на стороне провайдера (Interactions API,
   * background: true). Заполняется при переводе QUEUED → RUNNING;
   * по нему pollRunning() забирает результат. Отдельное поле, не
   * часть pendingRequest: pendingRequest — это ЧТО отправить,
   * externalInteractionId — КУДА идти за ответом. */
  externalInteractionId String?

  @@index([status, createdAt])
}
```

Новых моделей не заводится.

### 4.4 API

**[R2]** `drainQueue()` редакции 1 разделён на два метода: воркер больше не исполняет вызов,
а ставит задачу и опрашивает статус.

| Метод | Назначение |
|---|---|
| `AIRouterService.execute(req)` | без изменений, синхронный, для текстовых `taskType` |
| `AIRouterService.enqueue(req)` | consent + scan + resolveModelVersion + `AIJob(QUEUED)` → `{ jobId }` |
| `AIRouterService.submitQueued(limit)` | `QUEUED` → resolve `MediaRef` → `POST /interactions {background:true}` → `RUNNING` + `externalInteractionId` |
| `AIRouterService.pollRunning(limit)` | `RUNNING` с `externalInteractionId` → `GET /interactions/{id}` → терминальный статус или ждём дальше |
| `GET /ai-jobs/:id` | новый, `TelegramAuthGuard`, только свои джобы: `{ status, aiInferenceId?, error? }` |

`enqueue()` переиспользует **ровно тот же** пролог, что `execute()`: `consent.requireConsent`
(+ `assertAudioMayLeaveDevice` при blob-медиа, §10.4), `contentScan.scan`, `resolveModelVersion`,
создание `AIJob` и привязка `ContentScanResult.aiJobId`. Дублирования кода быть не должно —
общий приватный `prepareJob()`.

Маппинг внешнего статуса в терминальный (`pollRunning`):

| Статус провайдера | Действие |
|---|---|
| `queued`, `in_progress` | остаёмся в `RUNNING`, ничего не пишем |
| `completed` | `validateOutput` → `AIInference` → `COMPLETED` |
| `failed`, `cancelled` | `FAILED`, сообщение провайдера в `partialResult` |
| `budget_exceeded` | `FAILED` с отдельным сообщением — это исчерпание квоты (§9.3), а не сбой |
| `incomplete` | `FAILED` с указанием на упор в `max_output_tokens` — чинится промптом, не ретраем |
| `requires_action` | `FAILED` с явной ошибкой: инструментов мы не передаём, значит контракт разошёлся |

Retry и fallback на другую модель переиспользуются из `attemptWithRetryAndFallback()`: **ретрай
означает новую постановку задачи** (новый `externalInteractionId`), а не повторный опрос старой.
`validateOutput` и запись `AIInference` — из `callAndPersist()` без изменений.

### 4.5 Воркер

Контроллер без `TelegramAuthGuard`, аутентификация — сверка заголовка с секретом через
`safeSecretEqual`, **дословно тот же паттерн**, что `SchedulerController` + `SCHEDULER_DISPATCH_SECRET`:

```
POST /ai-jobs/submit    header: x-dispatch-secret: <AI_JOB_DISPATCH_SECRET>
POST /ai-jobs/poll      header: x-dispatch-secret: <AI_JOB_DISPATCH_SECRET>
```

`prisma/manual-migrations/pg_cron_ai_jobs.sql` — по образцу `pg_cron_reminders.sql`, включая
блок честной оговорки о том, что файл применяется вручную и не проверен против живого Supabase.

- Три джобы, все `* * * * *`: `submit`, `poll`, сторожевая.
- За один прогон — не более `AI_JOB_BATCH` (по умолчанию **3** для submit, **10** для poll).
  **[R2]** Батчи выросли против редакции 1 (там было 1), потому что теперь оба вызова короткие:
  постановка и опрос ~1 с, а не 25–40 с ожидания.
- Взятие джобы в работу — атомарный `UPDATE … SET status='RUNNING', leaseExpiresAt=now()+interval
  WHERE id IN (SELECT id FROM ai_jobs WHERE status='QUEUED' ORDER BY created_at LIMIT n FOR UPDATE
  SKIP LOCKED) RETURNING *`. **`SKIP LOCKED` обязателен**: без него два одновременных срабатывания
  cron возьмут одну джобу дважды и **выставят два счёта провайдеру**. `pollRunning` берёт строки
  так же.
- Сторожевая джоба: `leaseExpiresAt < now()` → `FAILED`, отдельными сообщениями для `QUEUED`
  (воркер не поставил задачу) и `RUNNING` (провайдер не ответил за
  `EXTERNAL_INTERACTION_MAX_WAIT_MS`). Иначе джоба висит навсегда — тот самый баг «застрявший
  `PROCESSING`», уже однажды найденный аудитом в media-review.
- **Идемпотентность постановки.** Между `POST /interactions` и записью `externalInteractionId`
  есть окно: упавший здесь воркер оставит задачу у провайдера без ссылки на неё у нас, и
  сторожевая джоба поставит её заново — двойной счёт. Смягчение: `externalInteractionId`
  пишется **тем же апдейтом**, что переводит в `RUNNING`; окно сужается до одного запроса, но
  не закрывается полностью. Принятая граница, названная явно, а не покрытый риск.

---

## 5. `GeminiClient`

`ai-router/ai-provider-client.ts`, рядом с двумя существующими, без SDK — глобальный `fetch`,
по той же причине, что уже зафиксирована в шапке файла.

**[R2] Пишем против Interactions API, не против `generateContent`.** Редакция 1 указывала
`POST /v1beta/models/{model}:generateContent` с телом `contents[].parts[].fileData` — форма
восстановлена верно, но со страницы, которая теперь называется **«Gemini Generate Content API
(Legacy)»**. Текущий основной интерфейс — Interactions API, и у Google уже выпущен гайд по
ломающим изменениям (май 2026). Новый клиент против объявленной устаревшей поверхности — это
переписывание в первом же квартале эксплуатации.

```
POST {apiEndpoint}/v1beta/interactions          — постановка
GET  {apiEndpoint}/v1beta/interactions/{id}     — получение результата
```

Запрос:

```json
{
  "model": "<AIModelVersion.version>",
  "background": true,
  "system_instruction": "<systemPrompt>",
  "input": [
    { "type": "video", "uri": "<разрешённый MediaRef>", "mime_type": "video/mp4" },
    { "type": "text",  "text": "<текстовая часть промпта>" }
  ],
  "generation_config": { "max_output_tokens": 8192, "thinking_level": "medium" }
}
```

- **Порядок блоков значим:** документация рекомендует ставить текстовый промпт **после** медиа.
  `ContentBlock[]` сериализуется с сохранением порядка, а вызывающий код (§8) обязан класть
  медиа первым. Это требование к вызывающему, не к клиенту.
- `mime_type` — только для blob-источника; для YouTube-URI не передаётся.
- `background: true` — всегда для медиа-`taskType`; для текстовых `taskType` этот клиент не
  используется вовсе.
- **`response_mime_type` / structured output не задаём** на этом проходе: валидация остаётся за
  `validateOutput`, чтобы поведение совпадало с двумя существующими провайдерами, а не расходилось.
  Требование JSON живёт в тексте промпта, как у `intake-classify`.
- Ответ (`GET`): текст — в `output_text` (конкатенация последнего `model_output`), полная форма —
  `steps[].content[].text`. Использовать `output_text`, при его отсутствии — падать явной ошибкой
  о неожиданной форме, как в двух существующих клиентах.
- **Терминальный исход определяется полем `status`, а не `finish_reason`** — такого поля в этом
  контракте нет. Маппинг восьми статусов — в таблице §4.4; разные исходы дают разные сообщения
  пользователю, а не общий «unexpected shape».
- `usage`: `total_input_tokens`, `total_output_tokens`, `total_tokens`, а также
  **`input_tokens_by_modality`** — официальная разбивка по `video` / `audio` / `text`.
  Её нужно писать в телеметрию: стоимость медиа-вызова иначе не отделить от текстовых в
  `/admin/telemetry`, а она на два порядка выше.
- `media_resolution` в REST-примерах Interactions API не подтверждён. **Не закладываем**: при
  необходимости снизить стоимость — уменьшать длительность (§6.4), а не полагаться на
  неподтверждённый параметр. `ContentBlock.mediaResolution` остаётся в контракте (§3.2) как
  задел, но клиент его на этом проходе игнорирует, и это записано, а не подразумевается.

Регистрация в `selectProviderClient()`: `case 'google': return new GeminiClient()`.

Сид `AIProvider { name: 'google', region: 'US', apiEndpoint: 'https://generativelanguage.googleapis.com',
authMethod: 'query-key', credentialRef: 'GEMINI_API_KEY' }` + `AIModel` + `AIModelVersion` +
`AIModelCapability { taskType, vision: true, audio: true, structuredOutput: true, privacyClass, availability: 'active' }`.

**Важно:** `OpenAiCompatibleClient` и `AnthropicClient` кладут ключ в заголовок; Gemini —
в query-параметр. `AIProvider.authMethod` в схеме уже есть и **нигде не читается** — этот
проход его оживляет вместе с `vision`/`audio`.

---

## 6. Источник 1 — публичное видео (media-review), полная автоматика

### 6.1 Поток

```
поиск (YouTube Data API v3, §2.1 media-review ТЗ, без изменений)
   → мультивыбор → MediaReviewQueue  ⟵ [R2] создаётся ВМЕСТЕ с Project (§6.1.1)
   → для каждого элемента АВТОМАТИЧЕСКИ:
        Conversation(projectId: queue.projectId,          ⟵ [R2]
                     sourceType: PUBLIC_VIDEO_URI,
                     occurredAt: item.publishedAt ?? item.createdAt,   ⟵ [R2]
                     status: ANALYZING,
                     rawFileRef: youtube-ссылка)
        AIRouter.enqueue({ taskType: 'media-public-review',
                           userPrompt: [ {media, ref:{youtube, videoId}},
                                         {text: <промпт из PromptRegistry>} ] })
        item.status = PROCESSING, item.aiJobId = jobId
   → submitQueued → pollRunning → AIInference
   → ПЕРСИСТЕНС (§6.2): ConversationParticipant[] → Transcript → TranscriptSegment[]   ⟵ [R2]
   → ConversationSignal[] с проставленными participantId и transcriptSegmentId          ⟵ [R2]
   → Conversation.status = ANALYZED → item.status = DONE
```

Ни одного действия пользователя между «выбрал ролики» и «смотрю разбор». Это и есть требование §0.

#### 6.1.1 [R2] `MediaReviewQueue` получает проект

`ConversationsService.create()` требует `projectId`, а `MediaReviewQueue` знала только `userId`:
при ручном флоу `Conversation` создавал сам пользователь внутри своего проекта, при автоматическом
создаём мы — и проекта нет.

**Это третий случай того же chicken-egg**, дважды уже найденного и починенного в проекте
(interview-pool → `Project.recruitingTeamId`; investment → `Project.investmentGroupId`;
family-law → `Project.contractType` — все три с одинаковой формулировкой в комментариях схемы).

```prisma
model MediaReviewQueue {
  // … существующие поля …
  /** [R2] Проект-контейнер для разговоров этой очереди. Обязателен:
   * Conversation без projectId невозможен. Один проект на ОЧЕРЕДЬ,
   * не на ролик — иначе список проектов пользователя засоряется
   * по одному проекту на каждое видео. */
  projectId String
  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId])
}
```

`createQueue(userId, title)` становится транзакцией:
`ProjectsService.create(userId, { question: title })` → `mediaReviewQueue.create({ projectId })`.

`ProjectMode` — **`STANDARD`** (значение по умолчанию, новое не заводится): режим влияет на
доменные конфиги, которых у media-review нет. Решение зафиксировано здесь явно, чтобы не
оставлять его реализующему.

### 6.2 [R2] Персистенс результата — без него сводка очереди вернёт ноль

Редакция 1 описывала, **что** вернёт модель (§8.1), и не описывала, **куда** это ложится. В
реализации это дало бы не ошибку компиляции, а тихо пустую фичу.

**Почему это не косметика.** `MediaReviewService.getSummary()` считает сигналы **через сегменты**:

```ts
const segmentIds = (await this.prisma.transcriptSegment.findMany({
  where: { transcript: { conversationId: { in: conversationIds } } }, select: { id: true },
})).map((s) => s.id);
this.prisma.conversationSignal.count({
  where: { signalType: 'MANIPULATION_PATTERN', transcriptSegmentId: { in: segmentIds } },
});
```

Нет сегментов ⇒ `segmentIds` пуст ⇒ **сводная карточка вернёт 0 при любом количестве находок**.
А это пункт 5 из пяти в потоке §2.3 media-review ТЗ, то есть заявленная функциональность.
Тот же разрыв ударит по всем существующим потребителям, читающим разбор через сегменты.

Порядок строго такой, каждый шаг — предусловие следующего:

1. **`ConversationParticipant[]`** — upsert по `diarizationLabel` из `speakerLabel` ответа модели
   (`@@unique([conversationId, diarizationLabel])` в схеме уже есть). `isSelf: false` для **всех**:
   в публичном видео пользователь — наблюдатель, не участник (прямо подтверждено §1 media-review ТЗ).
   `personId` не проставляется никогда — сопоставление с `Person` остаётся ручным действием
   пользователя, как и в основном конвейере.
2. **`Transcript`** — один на разговор (`conversationId @unique`), `language` из ответа модели
   или `null`.
3. **`TranscriptSegment[]`** — `text`, `startMs`, `endMs` из ответа, `participantId` — на созданных
   в п.1 участников. `confidence` — `null`: модель не даёт пословной уверенности, и выдумывать её
   нельзя (тот же принцип, что `AIInference.confidence = null` в `callAndPersist()`).
4. **`ConversationSignal[]`** — с проставленными `transcriptSegmentId` **и** `participantId`.
   Сигнал без `transcriptSegmentId` не создаётся вовсе: он был бы невидим для `getSummary()` и
   для UI разбора.

Всё четыре шага — **одна транзакция**. Частично записанный разбор (участники есть, сегментов нет)
хуже, чем отсутствующий: он выглядит как успешный.

Тест обязательный и именно такой: «`getSummary()` видит сигналы автоматического разбора» — то есть
проверяющий сквозную цепочку, а не отдельные шаги.

### 6.3 Новый `ConversationSourceType`

```prisma
enum ConversationSourceType {
  LIVE_RECORDING
  UPLOADED_AUDIO
  UPLOADED_VIDEO
  UPLOADED_PHOTO
  TEXT_IMPORT
  /** Публичное видео, разобранное по URI провайдером. Файл никогда
   * не существовал в нашей инфраструктуре — отличается от
   * UPLOADED_VIDEO именно этим, а не происхождением контента. */
  PUBLIC_VIDEO_URI
}
```

`Conversation.rawFileRef` для таких записей = ссылка на YouTube (это и есть «клиентская ссылка на
первоисточник, не сам файл» — ровно то, чем поле было задумано).
`audioBlobPathname` остаётся `null` навсегда.

### 6.4 `AWAITING_UPLOAD` не удаляется — и `getQueue()` обязан его возвращать

Статус сохраняется для случаев, когда автоматический путь **не сработал** и ручной остаётся
единственным: приватное/unlisted видео, региональная блокировка, исчерпание суточной квоты
(`budget_exceeded`), отказ модели. Элемент возвращается в `AWAITING_UPLOAD` **с человекочитаемой
причиной** (`MediaReviewQueueItem.autoAnalysisError String?`), и пользователь может пройти старым
путём §2.2 по собственному решению.

**[R2] Одного отката недостаточно — нужна правка `getQueue()`.**
`mapConversationStatusToItemStatus()` возвращает `DONE` только для `ANALYZED`; **`FAILED` тоже
маппится в `PROCESSING`** — осознанное упрощение, задокументированное в media-review, из-за
которого аудит уже однажды ловил «елемент назавжди застрягав у PROCESSING».

Если воркер упал между `AIJob → FAILED` и откатом элемента, элемент останется в `PROCESSING`, и
следующий же `GET` его там и **оставит**, потому что `Conversation.status = FAILED` маппится в
`PROCESSING`. Тихое зависание вернётся тем же путём, которым его уже чинили.

Правка: `getQueue()` при `conversation.status === FAILED` переводит элемент в `AWAITING_UPLOAD`
с сообщением, а не в `PROCESSING`. Тест на эту ветку обязателен — класс бага в проекте уже
реализовывался.

### 6.5 Ограничение длительности

`MEDIA_REVIEW_MAX_DURATION_SECONDS = 1200` (20 минут) на первом проходе. Обоснование, не круглое
число: ~300 токенов на секунду видео ⇒ ~360 000 токенов на ролик — умещается в контекст с запасом
и предсказуемо по стоимости; 8-часовой суточный лимит free tier даёт **~24 таких ролика в сутки
на весь продукт** (§9.3).

**[R2]** Расчёт пересмотрен: редакция 1 опиралась на `media_resolution: low` (~100 токенов/сек),
но этот параметр в Interactions API не подтверждён (§5), поэтому считаем по полной ставке.
Длительность — единственный доступный нам рычаг стоимости, что и делает этот лимит обязательным,
а не желательным.

Длительность известна **до** вызова из метаданных YouTube Data API (`durationSeconds` уже в
`MediaReviewQueueItem`), поэтому отказ выдаётся сразу при добавлении в очередь, а не после
неудачного вызова.

---

## 7. Источник 2 — своя запись (паралингвистика)

### 7.1 Поток

Встраивается в существующий, не заменяет его:

```
audioBlobPathname (уже есть)
   ├─→ AssemblyAI ──→ TranscriptSegment[]  (без изменений)
   └─→ AIRouter.enqueue({ taskType: 'conversation-paralinguistics',
                          userPrompt: [ {media, ref:{blob, pathname, mimeType}},
                                        {text: промпт + список сегментов с таймкодами} ] })
```

В текстовую часть промпта подставляются уже полученные `TranscriptSegment` с `startMs`/`endMs` —
модель не транскрибирует заново, а **комментирует подачу известных реплик**. Это резко сокращает
выход, устраняет расхождение двух транскриптов и делает привязку сигналов детерминированной.
Следовательно, паралингвистический проход запускается **после** `TRANSCRIBED`, не параллельно.

### 7.2 Критическая находка — порядок удаления blob'а

`handleTranscriptionWebhook()` удаляет blob **сразу** по вебхуку AssemblyAI, и на success, и на
error (`deleteAudioBlob`), обнуляя `audioBlobPathname` тем же апдейтом. Инвариант сформулирован
в схеме прямо: «в БД есть pathname» ⇒ «файл ещё существует».

**Если оставить как есть, паралингвистический проход не получит файла никогда** — вебхук удалит
его раньше, чем воркер возьмёт джобу.

Решение (обязательное, иначе фича не работает вообще):

- `Conversation.pendingMediaConsumers Int @default(0)` — счётчик потребителей файла.
- `requestTranscription()` инкрементирует на 1 (AssemblyAI); при включённой паралингвистике —
  ещё на 1.
- Каждый потребитель по завершении (успех **или** отказ) декрементирует.
- `deleteAudioBlob()` вызывается **только** при достижении нуля, из общего
  `releaseMediaConsumer(conversationId)`, а не из вебхука напрямую.
- Сторожевая pg_cron-джоба: `pendingMediaConsumers > 0` дольше `MEDIA_LEASE_MAX_AGE` →
  принудительное удаление blob'а и обнуление счётчика. **Утечка файла хуже, чем потерянный
  анализ** — приоритет прямо здесь, а не в комментарии.

**[R2] `MEDIA_LEASE_MAX_AGE` не назначается независимо**, а выводится из потолка ожидания внешней
задачи (§3.3) — иначе константы разъедутся, и файл будет удалён, пока Google ещё держит задачу
в очереди:

```ts
export const MEDIA_LEASE_MAX_AGE_MS = EXTERNAL_INTERACTION_MAX_WAIT_MS + 15 * 60 * 1000;
```

Инвариант «есть pathname ⇒ файл существует» сохраняется. Инвариант «файл удаляется сразу по
завершении транскрибации» **ослабляется до** «файл удаляется по завершении всех потребителей, но
не позже `MEDIA_LEASE_MAX_AGE`». Это осознанное расширение окна хранения — и **[R2]** под фоновым
режимом оно шире, чем предполагала редакция 1, потому что включает время в очереди провайдера, а
не только время обработки. Расширение должно быть отражено в тексте согласия `EPHEMERAL_SERVER`,
а не только в коде.

### 7.3 Сигналы

`EMOTIONAL_SHIFT` в `ConversationSignalType` **уже есть** и покрывает смену аффекта — переиспользуется.

Добавляется **ровно один** новый тип:

```prisma
enum ConversationSignalType {
  FACTUAL_DISCREPANCY
  MANIPULATION_PATTERN
  PROBING_PATTERN
  SELF_RISK
  EMOTIONAL_SHIFT
  ARGUMENT_ACCEPTANCE
  /** Слова расходятся с подачей: согласие произнесено неуверенно,
   * отказ — с облегчением, утверждение — с восходящей вопросительной
   * интонацией. Единственный класс сигнала, который принципиально
   * недоступен текстовому конвейеру. */
  DELIVERY_INCONGRUENCE
}
```

Плюс поле по уже принятому в модели паттерну «поля, осмысленные только для одного типа»:

```prisma
model ConversationSignal {
  // ── Поле, осмысленное только для DELIVERY_INCONGRUENCE ──
  /** Канал наблюдения: 'prosody' | 'pace' | 'pause' | 'visual'.
   * Строкой, не enum — тот же принцип, что inferenceType/taskType:
   * не гадаем набор до появления реальных потребителей. */
  paralinguisticChannel String?
}
```

Больше типов на этом проходе не добавляется. Всё, что модель нашла сверх этого, остаётся в
`AIInference.output` и не проецируется в сигналы, пока не появится реальный потребитель.

### 7.4 Жёсткое ограничение — никаких выводов о личности

Промпт (§8.2) **запрещает** любые суждения о правдивости, намерении, характере, психическом
состоянии и «детекции лжи». Разрешено только **описание наблюдаемого**: темп, паузы, интонационный
контур, несовпадение с содержанием реплики. Это прямое продолжение уже принятых решений:
Пункт 40 (отказ от автономного поиска по человеку), §2.1 health ТЗ (никакого скоринга без
исключений), `ConversationSignal.userConfirmedIntentionalFalsehood` — выставляется **только**
пользователем вручную, сервис не проставляет его никогда, независимо от `confidence`.

Паралингвистика — самая соблазнительная фича продукта для превращения в «детектор лжи». Запрет
пишется в промпт, в `validateOutput` и в тест, а не только в этот абзац.

---

## 8. Промпты — в `PromptRegistry`, не константой

Оба `taskType` идут через уже существующий механизм (`promptId = taskType`, `ACTIVE`-версия
перекрывает дефолт, `promptVersionId` уходит в телеметрию) — дословно тот же паттерн, что
`intake-classify` и `argument-generation`.

### 8.1 `media-public-review`

Требуемый выход — строгий JSON, валидируемый `validateOutput`:

```json
{
  "segments": [
    { "startMs": 0, "endMs": 4200, "speakerLabel": "SPEAKER_00",
      "text": "…дословная реплика…",
      "delivery": "…наблюдаемая подача…",
      "signals": [ { "type": "MANIPULATION_PATTERN", "channel": "prosody",
                     "confidence": 0.0, "rationale": "…" } ] }
  ]
}
```

Требования в промпте: таймкоды в **MM:SS** (документированный для Gemini формат), затем
конвертация в `startMs`/`endMs` на нашей стороне; дословность реплик; описание наблюдаемого, а не
интерпретация; отсутствие выводов о личности (§7.4).

### 8.2 `conversation-paralinguistics`

Тот же формат выхода, но `text` и таймкоды **приходят на вход** из `TranscriptSegment` — модель
их не порождает, а только заполняет `delivery` и `signals`. `validateOutput` проверяет, что
множество `segmentId` в ответе — **подмножество** переданных: выдуманный сегмент = провал
валидации = retry, а не тихая запись сигнала в никуда.

---

## 9. Согласия, приватность, квоты

### 9.1 Согласия

| Источник | Требуемые согласия | Основание |
|---|---|---|
| Публичное видео | `EXTERNAL_AI` (из `AIRouterService`, уже есть) | §1 media-review ТЗ: контент уже публичен, нового гейта не нужно — проверено в коде |
| Своя запись | `EXTERNAL_AI` + **`assertAudioMayLeaveDevice()`** = `MAXIMUM_PRIVACY`-запрет, затем `RECORDING` и `EPHEMERAL_SERVER` | ровно тот же набор и порядок, что уже применяется к AssemblyAI в шести точках вызова |

Новых `ConsentType` не заводится: `PUBLIC_VIDEO_URI` не порождает нового класса риска относительно
уже покрытых, а паралингвистика своей записи покрывается существующей тройкой. Единственное, что
меняется в тексте согласия `EPHEMERAL_SERVER` — расширенное окно хранения файла (§7.2).

Паралингвистика **включается отдельным явным выбором** пользователя на разговор, а не по умолчанию
для всех: это дополнительная передача аудио дополнительному провайдеру, и она должна быть видимым
решением. Выключено — конвейер работает ровно как сегодня.

### 9.2 Что где хранится

| Артефакт | Хранение |
|---|---|
| Байты публичного видео | **никогда и нигде** |
| `youtubeVideoId`, метаданные | как сейчас (§4 media-review ТЗ) |
| Байты своей записи | приватный Blob, до нуля потребителей, не дольше `MEDIA_LEASE_MAX_AGE` (§7.2) |
| Подписанный URL | только в теле запроса к провайдеру, в БД не сохраняется |
| Выход модели | `AIInference.output`, как у всех остальных вызовов |

**[R2]** Срок подписи — `PRESIGN_TTL_MS` из §3.3, выведенный из потолка ожидания внешней задачи,
а не из длительности вызова: под `background: true` Google забирает файл в неизвестный момент
после постановки в очередь.

### 9.3 Квоты — реальные ограничения, не сноска

| Ограничение | Значение | Следствие |
|---|---|---|
| YouTube Data API `search.list` | 100 единиц из 10 000/сутки | ~100 поисков в сутки **на проект Google Cloud** (уже зафиксировано в §2.1 media-review ТЗ) |
| Gemini free tier, YouTube | 8 часов видео в сутки | **на API-ключ, а не на пользователя** — см. ниже |
| Gemini, видео на запрос | 10 (2.5+) | батчинг возможен, но **не делается** на первом проходе: один ролик = одна `Conversation` = один `AIJob`, иначе ломается привязка сигналов и частичный отказ |
| Публичность | только public | §6.4 |

**[R2] Формулировка про 8 часов исправлена.** Редакция 1 подавала лимит как «~24 ролика в сутки»,
не называя главного: это **весь продукт целиком**, а не один пользователь. Десять активных
пользователей делят те же 8 часов.

§2.1 media-review ТЗ сформулировало ровно это для квоты YouTube Data API — здесь нужна такая же
прямота: **автоматический разбор, доступный множеству аккаунтов, на free tier невозможен.**
Приемлемо для внутреннего/исследовательского использования; для продукта с многими пользователями
требуется paid tier, где ограничения по длине нет. Формулировка обязана стоять в UI при
исчерпании квоты, а не только здесь.

Суточный расход считается по `AIJob` с медиа-`taskType` за 24 часа — тот же приём, что
`PhotoVerificationService.assertUnderRateLimit()` и media-review §5, не новая инфраструктура.
Исчерпание квоты приходит и снаружи, статусом `budget_exceeded` (§4.4) — обе ветки ведут в
`AWAITING_UPLOAD` с понятным текстом (§6.4), а не в общий отказ.

---

## 10. Правки существующего кода, которые придётся сделать в любом случае

### 10.1 `hashInput()` сломается

Сейчас: `JSON.stringify({ taskType, systemPrompt, userPrompt })`. При `ContentBlock[]` с
подписанным URL хэш менялся бы при каждом presign, и `inputHash` перестал бы дедуплицировать.

Именно поэтому `pendingRequest` и `hashInput` оперируют **`MediaRef`** (`videoId` / `pathname`),
а разрешение в URI происходит в момент вызова (§3.3). Это не обходной путь, а причина, по которой
`MediaRef` вообще введён как отдельный тип.

### 10.2 `ContentScanService` не умеет медиа

`scan({ text })` принимает только текст. Решение фиксируется явно, а не молчанием:

- текстовые блоки сканируются как сегодня;
- медиа-блоки **не сканируются** (регэкспом там сканировать нечего) и записываются в
  `ContentScanResult` как непроверенные, с указанием `MediaRef`;
- prompt injection **внутри** ролика (текст на экране, произнесённая инструкция) — **реальный,
  не гипотетический вектор**, который этим ТЗ не закрывается. Компенсация частичная и названная
  честно: выход всегда проходит `validateOutput` по строгой схеме, поэтому «модель послушалась
  ролика и написала произвольный текст» приводит к провалу валидации и retry, а не к записи в
  `ConversationSignal`. Полноценной защиты нет; это принятая граница, а не покрытый риск.

### 10.3 `resolveModelVersion()` игнорирует `vision`/`audio`

Сейчас `findFirst({ taskType, availability: 'active' })`. С медиа-`taskType` без фильтра роутер
сможет отдать видео-задачу текстовой модели, и отказ будет выглядеть как ошибка провайдера, а не
конфигурации.

```ts
const needsMedia = requiresMedia(request.userPrompt); // есть ли ContentBlock media
const capability = await this.prisma.aIModelCapability.findFirst({
  where: { taskType, availability: 'active', ...(needsMedia ? { OR: [{ vision: true }, { audio: true }] } : {}) },
  …
});
```

Две строки — и мёртвые колонки наконец читаются.

### 10.4 `privacyProcessingMode` не проверяется в роутере

Заголовок `ConversationsService` признаёт это прямо: раздел 4.6 ТЗ требует проверки перед
`EPHEMERAL_SERVER`-обработкой, «но `AIRouterService` эту проверку никогда не делал… поэтому
реализована здесь правильно, а не унаследован тот же пробел».

Пока через роутер шёл только текст, это было терпимо. Как только пойдёт **аудио**, пробел
становится тем же самым.

`enqueue()`/`execute()` при наличии медиа-блока с `source: 'blob'` вызывают
**`consent.assertAudioMayLeaveDevice(userId, projectId)`** — существующий метод, который проверяет
`MAXIMUM_PRIVACY` (жёсткий запрет) **до** согласий `RECORDING` и `EPHEMERAL_SERVER`, в этом
порядке и по названной в его комментарии причине. Метод заведён общим ровно потому, что точек
вызова много и копия проверки в каждой — способ разъехаться; сейчас их шесть
(`conversations` ×2, `audio-blob` ×2, `sparring` ×2, `material-chat` ×2). Роутер становится
**седьмой и последней** — после этого ни один путь аудио наружу не остаётся непокрытым.

Публичное видео (`source: 'youtube'`) этой проверки не требует: своих данных пользователя там нет.

---

## 11. Фазы

Каждая фаза завершается прогоном `npm run typecheck && npm test` из корня и сдаётся самостоятельно.

| Фаза | Объём | Критерий готовности |
|---|---|---|
| **A** | Контракт: `ContentBlock`/`MediaRef`/`MediaUriResolver`, `requiresMedia()`, отказ в двух существующих клиентах, правки §10.1 и §10.3 | все существующие вызовы проходят без изменений; тесты на строку и на блоки |
| **B** | **[R2]** Асинхронная полоса: `AIJob.pendingRequest`/`leaseExpiresAt`/`externalInteractionId`, `enqueue()`, **`submitQueued()` + `pollRunning()`** (вместо `drainQueue()`), `GET /ai-jobs/:id`, контроллер воркера + `pg_cron_ai_jobs.sql`, сторожевая джоба | тест на `SKIP LOCKED`-семантику двойного забора, на истечение lease и на маппинг восьми внешних статусов |
| **C** | **[R2]** `GeminiClient` **против Interactions API** (`POST /v1beta/interactions` + `GET /{id}`, `background: true`) + сид провайдера/модели/capability + `authMethod`; правка §10.4 | юнит-тесты с мокнутым `fetch`, включая все терминальные ветки `status` |
| **D** | **[R2]** media-review автоматика: `MediaReviewQueue.projectId` + транзакция создания проекта (§6.1.1), `PUBLIC_VIDEO_URI`, `occurredAt` из `publishedAt`, авто-enqueue, **персистенс транскрипта/участников (§6.2)**, `autoAnalysisError`, откат в `AWAITING_UPLOAD` + правка `getQueue()` для `FAILED` (§6.4), лимит длительности, промпт в реестре | очередь из 3 роликов проходит от выбора до `DONE` без действий пользователя; **тест «`getSummary()` видит сигналы автоматического разбора»** |
| **E** | Паралингвистика: `pendingMediaConsumers` + `releaseMediaConsumer()` + сторожевая джоба (§7.2), `DELIVERY_INCONGRUENCE`, `paralinguisticChannel`, промпт `conversation-paralinguistics`, явное включение на разговор | тест: blob не удаляется до нуля потребителей и удаляется по истечении lease |
| **F** | TMA: статус авто-анализа в очереди, панель паралингвистики в разборе разговора, переключатель включения | `next build` — 0 ошибок |
| **G** | Пост-аудит: сверка «роуты vs вызовы», телеметрия по новым `taskType` в `/admin/telemetry`, обновление README/TODO и §2.2 media-review ТЗ на ссылку сюда | |

Оценка честная: это не один заход. Фазы A–C не дают пользователю ничего видимого и всё равно
обязательны — без них D и E некуда класть.

**[R2] Перераспределение объёма против редакции 1:** фаза **B упростилась** (воркер не исполняет
вызов — только ставит и опрашивает; ожидание ушло на сторону провайдера), фаза **D существенно
выросла** (проект для очереди + персистенс транскрипта, участников и сегментов — это отдельный
объём с собственными тестами, а не «авто-enqueue»). Суммарно объём не уменьшился; он переехал
туда, где находится реальный риск.

---

## 12. Самоаудит и аудит ТЗ

### 12.1 [R2] Что изменила редакция 2

Аудит редакции 1 (`AUDIT-MULTIMODAL-TZ-2026-08-31.md`) дал 3 блокирующие находки, 3 существенные
и 4 уточнения. Все внесены:

| Находка | Класс | Где исправлено |
|---|---|---|
| B-1 `generateContent` помечен legacy; актуален Interactions API | блок. | §5 переписан целиком |
| B-2 `background: true` — ожидание уходит на сторону Google | блок. | §4.1–§4.5, `externalInteractionId`, `submitQueued`/`pollRunning` |
| B-3.1 `Conversation.projectId` обязателен, а проекта нет | блок. | §6.1.1, `MediaReviewQueue.projectId` |
| B-3.2 `occurredAt` обязателен без дефолта | блок. | §6.1, `publishedAt ?? createdAt` |
| B-3.3 транскрипт не сохраняется ⇒ `getSummary()` вернёт 0 | блок. | §6.2 целиком новый |
| B-3.4 участники не создаются ⇒ теряется «кто говорил» | блок. | §6.2 п.1 |
| S-1 `FAILED` залипает в `PROCESSING` | сущ. | §6.4, правка `getQueue()` |
| S-2 8 ч/сутки — бакет на ключ, не на пользователя | сущ. | §9.3 |
| S-3 сроки подписи и lease считались от синхронной модели | сущ. | §3.3, §7.2, §9.2 — обе выведены из `EXTERNAL_INTERACTION_MAX_WAIT_MS` |
| U-1 `finish_reason` нет, есть `status` | уточн. | §4.4 таблица, §5 |
| U-2 `input_tokens_by_modality` — официальное поле | уточн. | §5, в телеметрию |
| U-3 версии моделей из ТЗ брать нельзя | уточн. | §1.2 врезка |
| U-4 `ProjectMode` под media-review | уточн. | §6.1.1 — `STANDARD`, решено явно |

**Что аудит подтвердил без правок:** §0/§1.3 (основная идея — контент забирает провайдер),
§7.2 (удаление blob'а до паралингвистики), §10.1 (`hashInput`), §10.3 (мёртвые колонки),
§10.4 (`assertAudioMayLeaveDevice`), совместимость схемы для персистенса §6.2.

**Ни одна находка не отменила решения §0** — все они о том, *как* его реализовать.

### 12.2 Самоаудит по коду (выполнен до реализации, 2026-08-31)

Проверено по коду архива `devils-advocate-project-2026-08-31_1.zip`, не по памяти:

- [x] `AIModelCapability.vision` / `.audio` / `.privacyClass`, `AIProvider.region` / `.authMethod`
      — существуют в схеме, **ноль чтений** в `apps/api/src`. §3.1 и §10.3 опираются на факт.
- [x] `AIProviderCompletionParams.userPrompt: string` — контракт действительно текстовый,
      расширение обязательно.
- [x] `AIJob.promptVersionId` — **nullable**. Комментарий в `Conversation` («AIJob жёстко завязан
      на PromptVersion») неточен относительно схемы; вывод того комментария при этом остаётся
      верным для AssemblyAI (там нет промпта). Для медиа-анализа промпт реальный, `AIJob` подходит
      без оговорок.
- [x] `ConversationSignalType.EMOTIONAL_SHIFT` уже существует — новый тип нужен ровно один.
- [x] `Conversation.rawFileRef` документирован как «клиентская ссылка на первоисточник, не сам
      файл» — YouTube-ссылка ложится в него по назначению, поле не переиспользуется не по смыслу.
- [!] `MediaReviewQueueItem.status` по умолчанию `AWAITING_UPLOAD`; `getQueue()` синхронизирует
      `READY`/`PROCESSING` против `Conversation.status`. **Редакция 1 заключила, что существующая
      синхронизация продолжит работать без правок — это было неверно.** `FAILED` маппится в
      `PROCESSING`, поэтому проваленный авто-разбор залипал бы там же, где уже однажды залипал
      баг, найденный аудитом media-review. Исправлено в §6.4 (S-1).
- [x] `SchedulerController` + `safeSecretEqual` + `SCHEDULER_DISPATCH_SECRET` — образец для
      контроллера воркера существует и рабочий; `pg_cron_reminders.sql` — образец SQL-файла.
- [x] **Найдено при аудите, не предполагалось заранее:** `handleTranscriptionWebhook()` удаляет
      blob немедленно, обнуляя `audioBlobPathname`. Без §7.2 паралингвистика не получила бы файл
      **никогда**. Это не гипотетический риск, а гарантированный отказ — §7.2 обязателен, не
      желателен.
- [x] Метод называется **`assertAudioMayLeaveDevice(userId, projectId?)`**, не
      `requireEphemeralServerProcessing` (первая редакция §10.4 угадывала имя — исправлено по коду).
      Он проверяет `MAXIMUM_PRIVACY` **до** согласий и требует `RECORDING` **и**
      `EPHEMERAL_SERVER` — то есть §9.1 в первой редакции недосчитывал `RECORDING`, тоже исправлено.
      Вызывается из шести точек; роутер станет седьмой.
- [x] `AudioBlobService.presignForTranscription(pathname)` существует и уже используется для
      AssemblyAI — §3.3 переиспользует его, не вводит новый механизм подписи.
- [x] `AIProvider.authMethod` — **ноль чтений** в коде, как и `vision`/`audio`/`privacyClass`.
      Gemini кладёт ключ в query, а не в заголовок, поэтому §5 оживляет и это поле.
- [x] `safeSecretEqual` (`common/timing-safe-equal.ts`) существует и уже применяется в
      `AssemblyAiWebhookGuard` — образец аутентификации воркера рабочий, не гипотетический.
- [x] Лимиты Gemini (§1.2) сверены с официальной документацией 2026-08-31, не восстановлены по
      памяти.
- [x] **[R2] Риск «нелинейной латентности» снят конструкцией, а не оценкой.** Редакция 1 несла
      его как непроверяемый: замеры §4.1 сделаны на 30-секундном ролике, экстраполяция на
      20-минутный могла оказаться нелинейной. Под `background: true` наша функция не ждёт модель
      вообще — сколько бы провайдер ни считал, это происходит на его стороне.

- [ ] **[R2] Не проверено и не может быть проверено в этой среде:** живой вызов Interactions API
      с YouTube-URI и с `background: true`; **фактические тайминги очереди провайдера** — из них
      выведены `EXTERNAL_INTERACTION_MAX_WAIT_MS`, `PRESIGN_TTL_MS` и `MEDIA_LEASE_MAX_AGE_MS`
      (§3.3, §7.2), и все три сейчас **назначены, а не измерены**; поведение `pg_cron`/`pg_net`
      на конкретном инстансе Supabase; актуальный список моделей, доступных вашему ключу (§1.2).
      Контракт Interactions API восстановлен по официальной документации, включая страницу
      breaking changes, но **не подтверждён вызовом** — та же честная граница, что у всего
      остального внешнего периметра проекта.

- [ ] **[R2] Окно двойной постановки задачи** между `POST /interactions` и записью
      `externalInteractionId` (§4.5) сужено до одного запроса, но не закрыто. Принятая граница.

---

## 13. Юридическая граница

Раздел §1.3 показывает, что технический паттерн из иска 2:26-cv-00754 здесь отсутствует: сервер
не загружает контент, обхода технических мер нет, хранения стороннего контента нет. **Это
техническое утверждение, не юридическое заключение.**

Не исследовано и требует юрисконсульта до продакшена:

1. Отношения между условиями использования Gemini API и условиями YouTube при передаче ссылки в
   модель — оба сервиса принадлежат Google, но это не эквивалент разрешения.
2. Статус производного анализа публичного видео (наш выход — не копия контента, но производная
   работа) в юрисдикциях пользователей.
3. GDPR: `Recital 18` и вывод §3 `devils-advocate-third-party-recording-research.md` — приложение
   как «надавач засобу обробки» несёт часть ответственности отдельно от пользователя. Для
   публичного видео с узнаваемыми людьми это применимо и **этим ТЗ не закрыто**.
4. Паралингвистический анализ голоса может квалифицироваться как обработка биометрических данных
   в ЕС даже без хранения голосового отпечатка. Продукт уже разделяет `VOICE_PROCESSING` и
   `VOICE_BIOMETRIC` именно по этой линии — **вопрос, на какой стороне линии оказывается §7,
   оставлен открытым намеренно и должен быть закрыт до фазы E**, а не после.

Оговорка §7 research-документа не снимается: тема активно меняется в 2026.

---

## 14. Что осознанно вне этого ТЗ

- Батчинг нескольких роликов в один запрос (Gemini позволяет 10) — ломает привязку сигналов и
  частичный отказ; отдельное решение при появлении реальной потребности.
- Кастомный FPS и клиппинг фрагментов — в документации не подтверждены, не закладываем.
- `responseSchema` вместо `validateOutput` — разошлось бы с двумя существующими провайдерами.
- Замена AssemblyAI на Gemini для транскрибации — отдельный вопрос с собственной ценой ошибки
  (диаризация — опора половины детекторов); здесь Gemini **надстраивается**, не замещает.
- Накопление паралингвистического профиля конкретной `Person` через сессии — тот же класс
  решения, что уже отклонён в Пункте 40 и §3 media-review ТЗ. Каждый сигнал привязан к своему
  разговору, не к человеку глобально.
- Любая форма «детекции лжи», скоринга правдивости или оценки личности — §7.4, запрет
  безусловный.

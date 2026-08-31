# Деплой на Vercel Hobby

Монорепо деплоится как **четыре отдельных Vercel-проекта** из одного GitHub-репозитория — тот же паттерн, что уже использовался в других проектах стека (RoadScout/BTW: `apps/api`, `apps/admin`, `apps/btw`, `apps/landing` как отдельные Vercel-проекты). Не единый деплой корня репозитория — у API (serverless-функция), TMA (Next.js-приложение) и лендинга (статический Next.js) разная природа, совмещать их в одном проекте технически возможно, но усложнило бы конфиг без пользы.

**Честно про степень проверки**: всё ниже написано по документации и установленным паттернам, но ни разу не прогнано против реального Vercel — сеть отключена в среде, где писался этот код. Первый реальный `vercel --prod` (или пуш в GitHub с подключённым автодеплоем) — не формальность, а первая настоящая проверка.

---

## 1. Создание четырёх проектов в Vercel

> **ПОВТОРНЫЙ АУДИТ 2026-08-30:** раздел описывал три проекта — админки
> (`apps/admin`) в нём не было вообще, хотя `apps/admin/vercel.json`
> существует, а сама админка ходит в API с `credentials: 'include'` и
> требует настроенного `CORS_ORIGIN`. Добавлена как проект 4.

1. Запушить этот репозиторий в GitHub.
2. В Vercel: **Add New → Project**, выбрать репозиторий — **четырежды**, для четырёх проектов.
3. **Проект 1 — API**:
   - Root Directory: `apps/api`
   - Framework Preset: **Other** — и это критично, см. врезку ниже
   - Build Command: оставить дефолтным (Vercel возьмёт `buildCommand` из `apps/api/vercel.json` — `npm run vercel-build`, который делает только `prisma generate`, не пытается собрать весь Nest через `nest build`, так как реальная точка входа на Vercel — `api/index.ts`, не `dist/main.js`)
   - Output Directory: оставить пустым
4. **Проект 2 — TMA**:
   - Root Directory: `apps/tma`
   - Framework Preset: **Next.js** (определится автоматически, `apps/tma/vercel.json` подтверждает явно)
   - Build/Output Command — дефолтные, ничего менять не нужно
5. **Проект 3 — Landing**:
   - Root Directory: `apps/landing`
   - Framework Preset: **Next.js** (статическая генерация — все страницы через `generateStaticParams()` по локалям, см. `apps/landing/README.md`)
   - Build/Output Command — дефолтные
6. **Проект 4 — Admin**:
   - Root Directory: `apps/admin`
   - Framework Preset: **Next.js**
   - Build/Output Command — дефолтные
   - Домен этого проекта ОБЯЗАН быть в `CORS_ORIGIN` проекта API: админка ходит в API с `credentials: 'include'`, и без этого cookie `admin_session` браузером не отправится

> ### ⚠️ Ошибка сборки: «No entrypoint found which imports nestjs»
>
> ```
> Error: No entrypoint found which imports nestjs. Found possible entrypoint: src/main.ts
> ```
>
> Появляется, когда Vercel применяет к проекту **нативный Nest-пресет**.
> Утверждение «Vercel не распознаёт NestJS автоматически» (стояло в этой
> инструкции раньше) устарело: пресет теперь есть, и проект под него
> подпадает — в зависимостях `@nestjs/core`, в корне `nest-cli.json`.
>
> Дальше срабатывает наша собственная особенность: Nest-билдер ищет
> файл, который импортирует `@nestjs/*`, а `src/main.ts` импортирует
> только `./create-app` — `NestFactory` вынесен в `create-app.ts`, чтобы
> локальный запуск и serverless создавали приложение одинаково. Файл
> найден, нужного импорта в нём нет — сборка падает.
>
> **Чинить импортами не нужно.** На Vercel точка входа вообще не
> `src/main.ts`, а `api/index.ts` (serverless-обёртка) плюс `rewrites`
> из `vercel.json`; Nest-пресет этой схеме не нужен и только мешает.
>
> В репозитории это зафиксировано — `apps/api/vercel.json` содержит
> `"framework": null` (то же самое, что Framework Preset = **Other**),
> и настройки из `vercel.json` перекрывают дашборд. Если проект уже
> создан со старой конфигурацией: **Settings → Build & Deployment →
> Framework Preset → Other**, затем Redeploy.

> ### ⚠️ Ошибка сборки: «No Output Directory named "public" found»
>
> ```
> Error: No Output Directory named "public" found after the Build completed.
> ```
>
> Следующая по порядку после ошибки про Nest-пресет, и причина
> смежная. Как только framework перестал быть Nest, Vercel обращается с
> проектом как с обычным: выполнил `buildCommand` — теперь ищет
> директорию со статикой, чтобы её раздать. А `apps/api` статику не
> отдаёт вообще: весь трафик уходит в serverless-функцию `api/index.ts`
> через `rewrites`, а `vercel-build` делает только `prisma generate` и
> ничего не собирает в файлы.
>
> Проверка при этом безусловная — «функции есть, статики нет» Vercel
> валидным состоянием не считает. Стандартный ответ на неё — **пустой
> каталог `public/`**, он в репозитории есть (`apps/api/public/.gitkeep`),
> и `vercel.json` указывает на него явно: `"outputDirectory": "public"`.
>
> Пустой он не случайно: маршрутизация Vercel сначала ищет статический
> файл и только потом применяет `rewrites`, поэтому любой файл, который
> сюда попадёт, будет отдаваться по своему пути мимо API — и будет
> публично доступен. Каталог нужен ровно для того, чтобы проверка
> прошла.
>
> Альтернативы, от которых лучше воздержаться: `"outputDirectory": "."`
> раздаст как статику весь каталог проекта, включая исходники; legacy-
> секция `"builds"` уберёт проверку, но заодно отключит zero-config и
> сломает подхват функций из `api/`.

> ### ⚠️ Рантайм-ошибка: `FUNCTION_INVOCATION_FAILED` на любом запросе
>
> Сборка прошла, но каждый запрос отдаёт «This Serverless Function has
> crashed». В Runtime Logs (Vercel → проект → Logs) видно настоящую
> причину. Два реальных случая, оба уже закрыты в коде:
>
> **1. `Nest can't resolve dependencies of the SecretsService … argument
> Object at index [1]`** — приложение не собиралось в DI-контейнере
> вообще, ни в проде, ни локально. Второй параметр конструктора был
> объявлен как `ttlMs = 5 * 60 * 1000` без аннотации типа; tsc эмитит
> для такого параметра `design:paramtypes` = `Object`, Nest читает это
> как зависимость и ищет провайдер с токеном `Object`. Исправлено
> (`@Optional() @Inject(SECRETS_CACHE_TTL_MS) ttlMs?: number`), разбор —
> в комментарии в `src/secrets/secrets.service.ts`, регрессия закрыта
> тестом `src/__tests__/app-bootstrap.spec.ts`.
>
> **2. Ошибка Prisma при старте.** `PrismaService` вызывал `$connect()`
> в `onModuleInit`, то есть подключался к базе на каждом холодном
> старте, до маршрутизации. Любая проблема с базой (неверный
> `DATABASE_URL`, ограничение по IP, исчерпанный пул) роняла функцию
> целиком, включая эндпоинты, которым база не нужна. Теперь подключение
> ленивое — ошибка приходит на том эндпоинте, который реально пошёл в
> базу, и отдаётся нормальным JSON через `ApiExceptionFilter`.
>
> Если крашится что-то ещё — сначала Runtime Logs, а не гадание: там
> будет исходный стек. Локально то же самое воспроизводится за минуту:
> `cd apps/api && npx nest build && node -e "require('./dist/src/create-app').createNestApp()"`.

Root Directory — настройка уровня Vercel dashboard, не выражается в `vercel.json` — если создаёте проект через `vercel` CLI, а не dashboard, укажите её там же при первой инициализации (`vercel link`, вопрос "In which directory is your code located?").

---

## 2. Переменные окружения

### Проект API (`apps/api`)

**Полный аудит документации 2026-08-30** — эта таблица отставала от `apps/api/.env.example`
на 11 переменных (список ниже сверен со `.env.example` автоматически, не по памяти).
Деплой по старой версии таблицы прошёл бы успешно, но тихо сломал бы доказательства ДТП,
OCR анализов, поиск по инвест-источникам, TTS, разбор медиа, вебхуки транскрипции и
cron-задания — каждое падало бы по своему `SecretsService.resolve()` только при первом
реальном обращении, не при старте.

| Переменная | Значение | Комментарий |
|---|---|---|
| `DATABASE_URL` | пулированное соединение Supabase, порт **6543**, `?pgbouncer=true` в конце | Serverless-функции открывают много коротких соединений одновременно — без пулера упрётесь в лимит подключений Postgres на первом же всплеске трафика |
| `DIRECT_URL` | прямое соединение Supabase, порт **5432**, без `pgbouncer` | Нужно ТОЛЬКО для `prisma migrate` — миграции не работают через pgbouncer в transaction-режиме. См. `directUrl` в `schema.prisma` |
| `TELEGRAM_BOT_TOKEN` | токен вашего бота | Валидация `X-Telegram-Init-Data`, см. `telegram-init-data.util.ts` |
| `ALLOW_DEV_AUTH` | `false` | **Обязательно false в проде** — иначе это дыра в аутентификации (см. `telegram-auth.guard.ts`) |
| `SECRET_PROVIDER_TYPE` | `env` | `EnvSecretProvider` — рабочий вариант, Vercel хранит env-переменные шифрованными |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY` | реальные ключи | Резолвятся через `credentialRef` на `AIProvider`, не хранятся в БД |
| `CORS_ORIGIN` | домены TMA, админки и лендинга **через запятую** | **ОБЯЗАТЕЛЬНАЯ переменная, не рекомендация.** Повторный аудит 2026-08-30: здесь было написано, что без неё CORS «откроется всем подряд» — это описание устарело и вводило в заблуждение ровно в опасную сторону. Реальное поведение `create-app.ts` в проде — **fail closed**: без `CORS_ORIGIN` разрешённых origin'ов нет вообще, и все cross-origin запросы блокируются, то есть админка и TMA просто не работают, а в консоли браузера видны CORS-ошибки. Перечислить нужно все три домена, не только TMA |
| `PORT` | не нужен на Vercel | Используется только `main.ts` для локального запуска, serverless-функция порт не слушает |
| `API_PUBLIC_BASE_URL` | `https://<домен-api-проекта>.vercel.app` | Собственный публичный URL API — нужен, чтобы собрать webhook-ссылку, на которую AssemblyAI пришлёт результат озвучки собеседника (`sparring`/`material-chat`). Без него эти два вебхука не соберутся вообще, не просто не аутентифицируются |
| `ASSEMBLYAI_API_KEY` | ключ AssemblyAI | STT + диаризация — транскрипция разговоров, все три вебхука ниже |
| `ASSEMBLYAI_WEBHOOK_SECRET` | случайная строка (`openssl rand -base64 32`) | **Добавлено полным аудитом 2026-08-30** — секрет, который AssemblyAI возвращает в заголовке при доставке результата; проверяется `AssemblyAiWebhookGuard` на всех трёх вебхуках транскрипции. Fail closed в обе стороны: без него `submitJob()` откажет ещё до отправки задачи, а не только вебхук — транскрипция станет недоступна целиком, не просто небезопасной |
| `SCHEDULER_DISPATCH_SECRET` | случайная строка | Секрет для `x-dispatch-secret` — им защищены `internal/reminders/dispatch`, `internal/calibration/recompute` и `intake/abandon-stale` (три pg_cron-задания, один секрет — см. §3 ниже) |
| `ELEVENLABS_API_KEY` | ключ ElevenLabs | Озвучка реплик AI-собеседника (TTS) |
| `GOOGLE_PLACES_API_KEY` | ключ Google Places (Legacy REST — `maps.googleapis.com/maps/api/place/*`) | Рекомендации заведений для встречи, локация вариантов крупной покупки. **Заморожен Google с марта 2025** (аудит 2026-08-30) — работает, новых фич не получает, точной даты отключения нет (минимум 12 мес. уведомления), миграция на Places API (New) не мелкий фикс (GET→POST, другая форма ответа, обязательный field mask) |
| `WINDY_API_KEY` | ключ Windy Point Forecast API (`api.windy.com/keys`, платный/freemium) | **Опциональный.** Первичный источник прогноза погоды (модель `icon`) для рекомендации по дате встречи — при успехе Open-Meteo вообще не вызывается. Пусто ⇒ используется только Open-Meteo (fallback, бесплатный, без ключа) — тот же результат, что был до 2026-08-30, ничего не ломается без ключа |
| `GOOGLE_VISION_API_KEY` | ключ Google Cloud Vision | OCR документов (анализы здоровья, распознавание фото ДТП/крупной покупки) |
| `SERPAPI_KEY` | ключ SerpApi | Реверс-поиск фото (требует `VERCEL_BLOB_READ_WRITE_TOKEN` ниже — изображение должно быть публично доступно на время поиска) |
| `VERCEL_BLOB_READ_WRITE_TOKEN` | токен Vercel Blob | Хранилище доказательств ДТП; временная публикация фото для реверс-поиска (удаляется в `finally` независимо от исхода) |
| `FACT_CHECK_TOOLS_API_KEY` | ключ Google Fact Check Tools | Сверка утверждений с публичными фактчек-базами (`discrepancies/check-against-fact-check-api`, media-review) |
| `YOUTUBE_API_KEY` | ключ YouTube Data API | Поиск видео для очереди media-review (только метаданные, 20 запросов/сутки на пользователя) |

### Проект TMA (`apps/tma`)

| Переменная | Значение |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `https://<домен-api-проекта>.vercel.app` |
| `NEXT_PUBLIC_DEV_USER_ID` | **не устанавливать в проде** — это DEV bypass авторизации, см. `lib/telegram.ts` |

### Как проверить, что API действительно работает

```bash
curl -s https://<домен-api>.vercel.app/healthz
# {"success":true,"data":{"status":"ok","startedAt":"…","uptimeSeconds":3}}
```

`GET /healthz` — единственный публичный эндпоинт без авторизации,
добавлен 2026-08-31 (`src/healthz/`). В базу он не ходит намеренно:
отвечает на вопрос «функция поднялась и маршрутизация работает», а не
«здорова ли вся система».

Чего НЕ стоит использовать для проверки: маршрут `/health` — это
доменный контроллер про медицинские решения под `TelegramAuthGuard`.
Ответ `{"success":false,"error":{"message":"Cannot GET /health"}}` на нём
означает, что **API живой** (это его собственный формат ошибки через
`ApiExceptionFilter`), но выглядит как поломка и сбивает с толку.

### Проект Admin (`apps/admin`)

**Добавлено повторным аудитом 2026-08-30** — этого раздела не было.

| Переменная | Значение |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `https://<домен-api-проекта>.vercel.app` — тот же домен, что перечислен в `CORS_ORIGIN` проекта API |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | username бота без `@` — для Telegram Login Widget. Домен этого проекта должен быть задан боту через `@BotFather → /setdomain`, иначе виджет не отрисуется |
| `NEXT_PUBLIC_ALLOW_DEV_AUTH` | **не устанавливать в проде** (или строго `false`). Включает на `/login` кнопку локального входа без Telegram. Сам вход бэкенд в проде не пустит — `POST /admin/auth/dev-login` отвечает 404, пока не выставлены одновременно `ALLOW_DEV_AUTH=true` и `NODE_ENV!=production`, — но кнопка, отдающая 404, ещё и сообщает сканеру, что механизм в сборке есть. Ровно то, чего избегали выбором 404 вместо 403 |
| `NEXT_PUBLIC_DEV_USER_ID` | **не устанавливать в проде** — то же, что у TMA |

### Проект Landing (`apps/landing`)

| Переменная | Значение |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://<домен-landing-проекта>.vercel.app` (или кастомный домен) — используется в `sitemap.xml`/`robots.txt` |
| `NEXT_PUBLIC_TELEGRAM_BOT_URL` | `https://t.me/<bot_username>/<app_short_name>` — основной CTA |
| `NEXT_PUBLIC_LEGAL_ENTITY` | реквизиты для футера (опционально — без него футер просто не показывает эту строку) |
| `NEXT_PUBLIC_CONTACT_TELEGRAM` | юзернейм без `@` для ссылки "Контакты" в футере (опционально) |

---

### Предупреждение в логах: «CORS_ORIGIN is not set in production»

```
CORS_ORIGIN is not set in production — cross-origin requests (including apps/admin) will be blocked.
```

Это наш собственный `console.error` из `create-app.ts`, не ошибка
платформы. Пока переменная не задана, API отвечает на прямые запросы
(curl, браузерная строка), но **любой запрос из TMA, админки и лендинга
браузер заблокирует** — cookie админки не отправится, `fetch` упадёт с
CORS-ошибкой в консоли.

Значение — production-домены всех трёх фронтендов через запятую, без
слэша на конце:

```
CORS_ORIGIN=https://advokate-admin.vercel.app,https://<tma>.vercel.app,https://<landing>.vercel.app
```

⚠️ **Про preview-домены.** У каждого деплоя Vercel свой адрес вида
`devils-advokate-ahgd5lhuc-<team>.vercel.app`, и он меняется при каждом
пуше. Перечислять их в `CORS_ORIGIN` бессмысленно: в списке должны быть
стабильные production-домены (или кастомные домены, если они настроены).
Как следствие — на preview-деплоях фронтенды к API не достучатся; это
нормальное поведение, а не поломка. Если preview-окружение нужно
рабочим, заводите для него отдельный набор переменных в Vercel
(Environment = Preview) со своими доменами.

## 3. Первый деплой базы данных

Миграции **не запускаются автоматически** при каждом деплое (сознательно — см. `vercel-build` в `package.json`, там только `prisma generate`, не `migrate deploy`). Прогонять миграции на проде — отдельное, осознанное действие, не побочный эффект пуша в main:

> ### ⚠️ ПОВТОРНЫЙ АУДИТ 2026-08-30: команда ниже сейчас НИЧЕГО НЕ ДЕЛАЕТ
>
> Папки `apps/api/prisma/migrations/` в репозитории **нет** — ни одной
> миграции не сгенерировано ни разу. `prisma migrate deploy` при пустой
> истории завершается успешно с сообщением «No migration found» и не
> создаёт ни одной таблицы; следующий за ним `prisma:seed` падает на
> первой же вставке. Схема на проде до сих пор появлялась либо через
> `prisma db push`, либо ручным SQL — и ничто не проверяет, что боевая
> база соответствует `schema.prisma` (в схеме 225 `@@index`, в
> `manual-migrations/` — 122 `CREATE INDEX`; разница существует только
> там, где применяли `db push`).
>
> **Что делать, по-хорошему** — один раз завести baseline и дальше жить
> с нормальной историей миграций:
>
> ```bash
> cd apps/api
> mkdir -p prisma/migrations/0_init
> npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma \
>   --script > prisma/migrations/0_init/migration.sql
> # на УЖЕ существующей проде — пометить как применённую, не выполнять:
> DATABASE_URL="<pooled>" DIRECT_URL="<direct>" npx prisma migrate resolve --applied 0_init
> ```
>
> **Быстрый путь для чистой базы** (без истории — сознательный размен,
> тот же, что в локальном докер-стенде, см. `DOCKER.md` §2):
>
> ```bash
> cd apps/api
> DATABASE_URL="<pooled>" DIRECT_URL="<direct>" npx prisma db push
> ```

```bash
cd apps/api
DATABASE_URL="<pooled-url>" DIRECT_URL="<direct-url>" npx prisma migrate deploy
npm run prisma:seed  # провайдеры/модели/промпты/retention classes, см. prisma/seed.ts
```

Прогонять с локальной машины (или из CI-джобы), не с самого Vercel — serverless-функция не подходящее место для одноразовых миграционных команд.

**После `migrate deploy` — вручную применить `apps/api/prisma/manual-migrations/`.**
`prisma migrate` не покрывает то, что не выражается в `schema.prisma`: расширения
Postgres, `cron.schedule()`, ручные `ALTER COLUMN … TYPE` для уже накопленных данных.
На 2026-08-30 в папке:
- `schema_audit_2026_08_30.sql` — индексы на FK, `updatedAt`/`createdAt`, `Decimal(14,2)`
  для денежных полей, `DROP TABLE` для удалённых моделей (аудит `docs/AUDIT-DB-2026-08-30.md`).
- `intake_session.sql` — таблица `intake_sessions`, эквивалент того, что даст
  `prisma migrate` для `IntakeSession`; держать для сверки, а не вместо миграции.
- `pg_cron_reminders.sql`, `pg_cron_calibration.sql`, `pg_cron_intake_abandon.sql` —
  по одному `cron.schedule()` на каждое из трёх заданий за `SCHEDULER_DISPATCH_SECRET`
  (напоминания планировщика, ежесуточный пересчёт калибровки, обнуление зависших
  intake-сессий). Каждый файл выполняется один раз через SQL Editor Supabase, **после**
  того как у API есть реальный production URL — в файлах плейсхолдер
  `YOUR-PRODUCTION-DOMAIN.example`, который нужно заменить на настоящий.

---

## 4. ⚠️ Известный архитектурный риск — таймаут serverless-функции

**Лимит длительности одного вызова на Vercel Hobby — по разным источникам от 10 до 60 секунд** (расхождение, вероятно, связано с тем, включён ли Fluid Compute — проверить актуальное значение в документации Vercel на момент деплоя, не полагаться на цифру здесь). `apps/api/vercel.json` сейчас выставляет `maxDuration: 10` — консервативно, безопасно для plain Hobby без Fluid Compute.

**Это реальный риск для трёх фич**, не гипотетический: `AIRouterService` делает настоящие HTTP-вызовы к OpenAI/Anthropic/xAI (фичи 1, 7, 10 — генерация аргументов, Steelman, скрипты), с retry до `maxRetries` попыток. Один медленный ответ модели + один retry легко превышает 10 секунд. Если реальные деплои будут упираться в 504:

1. Проверить текущий лимит Hobby в актуальной документации Vercel — возможно, уже 60с по умолчанию.
2. Включить Fluid Compute в настройках проекта (может расширить лимит до 300с даже на Hobby).
3. Снизить `maxRetries` по умолчанию в `AIRouterService.execute()` для интерактивных запросов — сейчас `2`, при коротком лимите разумнее `1`.
4. Более серьёзная переработка (вне объёма этого прохода) — асинхронный паттерн (создать `AIJob`, вернуть `202 Accepted`, TMA поллит статус) вместо синхронного ожидания ответа модели в одном HTTP-запросе. `AIJob`-модель уже спроектирована с этим в виду (статусы `QUEUED`/`RUNNING`/`COMPLETED`), но текущий `AIRouterService.execute()` ждёт результат синхронно.

Пункт 4 — не сделан в этом проходе сознательно: это архитектурная переработка, не настройка деплоя, честнее оставить явным TODO, чем тихо понадеяться, что 10-секундного окна хватит на реальном трафике.

---

## 5. Прочие ограничения Hobby, о которых стоит знать

- **Только личное/некоммерческое использование** по условиям Vercel Hobby — если продукт становится коммерческим, потребуется Pro.
- **Once-daily cron** (если/когда появится реальный enforcement для `RetentionClass` TTL, см. `apps/api/prisma/README.md`, раздел "TTL-настройки") — паттерн, уже использованный в других проектах стека, обходится через Supabase `pg_cron`/`pg_net`, не через встроенный Vercel Cron, который на Hobby ограничен одним запуском в сутки.
- **Cold start** — первый запрос после периода бездействия будет заметно медленнее (создание Nest DI-контейнера с нуля, см. кэширование в `api/index.ts`).

## 6. ⚠️ Hero-композиция лендинга — известное расхождение с брифом

`apps/landing` hero сочетает 3 sticky-иллюстрации (закреплённые за углами вьюпорта на весь скролл — слоган про доверие/проверку, сцена ада, адвокат за столом) и вернувшуюся courtroom-иллюстрацию (справа от текста, с 6 переведёнными callout-карточками ниже) — не по композиции цикла Prepare→Practice→Talk→Review→Learn из `devils-advocate-hero-brief.md`, и раздел 3.5 `devils-advocate-landing-tz.md` формально исключает религиозный контент/детекцию лжи с лендинга. Реализовано по прямому повторному запросу (courtroom-архив с текстом загружался дважды). Два callout'а описывают функциональность, которой в MVP v1 физически нет (live-анализ речи, детекция лжи) — используются как есть, помечено в коде. Подробности — `apps/landing/README.md`.

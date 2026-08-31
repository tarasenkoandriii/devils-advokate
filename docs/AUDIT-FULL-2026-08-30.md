# Полный аудит проекта — 2026-08-30 (вечер)

Повторный полный проход по всем четырём приложениям теми же проверками, что утром,
плюс всё, чему научили промежуточные аудиты: HTTP-метод в сверке роутов,
nested-использование моделей, обход согласий, чтение потребителей вместо grep.

Состояние на входе: `tsc` чист во всех приложениях, 494 jest / 666 standalone / 81 TMA.
Состояние на выходе: **497 jest (62 сьюта) / 667 standalone / 81 TMA, сборки tma и admin —
0 ошибок, api и landing — `tsc` чист.**

## 1. Безопасность — найдено и закрыто

### 1.1 Вебхуки AssemblyAI без аутентификации (критично)
`POST conversations/webhook/transcription`, `sparring-sessions/webhook/voice-reply`,
`material-chat-sessions/webhook/voice-reply` — вне `TelegramAuthGuard` (обоснованно:
AssemblyAI не пройдёт Telegram-авторизацию), но **без какой-либо замены**: payload
с текстом транскрипта (`utterances[].text`) принимался от кого угодно. Зная id задачи
(`externalTranscriptionJobId`), можно подложить пользователю фальшивый транскрипт,
который дальше уходит в детекторы манипуляций, факты о людях, аргументы.
**Исправлено:** AssemblyAI поддерживает `webhook_auth_header_name/value` — единственная
точка отправки задач `TranscriptionService.submitJob()` теперь передаёт секрет, а
`AssemblyAiWebhookGuard` (constant-time сравнение) стоит на всех трёх вебхуках.
Fail closed в обе стороны: без `ASSEMBLYAI_WEBHOOK_SECRET` guard отвечает 503, а
`submitJob()` отказывает ещё до обращения к провайдеру (иначе результат никогда не
пройдёт guard и разговор зависнет в TRANSCRIBING). Новая переменная — в `.env.example`.
5 тестов.

### 1.2 Проверка guard'ов — ложная тревога парсера
Скрипт показал `evaluation.controller.ts` (4 admin-роута) и `venue-application.controller.ts`
как «без guard». Причина — `@UseGuards` стоит **перед** `@Controller`, и сплиттер относил
его к предыдущему блоку. Оба защищены (`AdminSessionGuard` / `TelegramAuthGuard`).
Реально без guard: три вебхука (см. 1.1), три `internal/*` под секретом заголовка,
`candidate-shares/:token/preview` (по токену, намеренно).

## 2. Backend-фичи без потребителя — найдено и закрыто

Сверка роутов с учётом HTTP-метода дала 78 «непокрытых», из них 74 — артефакты парсера
(пути из helper'ов, `URLSearchParams`, FormData-загрузки, вебхуки/internal). Четыре —
настоящие backend-only фичи:

| Роут | Что это | Последствие отсутствия UI | Сделано |
|---|---|---|---|
| `PATCH …/outcome-scenarios/:id/confirm-outcome` | «сбылось / не сбылось» по сценарию исхода | По комментарию контроллера — **единственный источник данных калибровочного gate** (`CalibrationService`, pg_cron `recompute`, `/admin/prompts` gate). Никто никогда не вызывал → калибровка получала ноль точек | Кнопки в `OutcomeScenariosSection`, поля `outcomeConfirmed*` в клиентском типе |
| `GET /admin/calibration/scenario-predictions` | статус gate | Обёртка `getCalibrationStatus()` в admin была, страницы — нет: операторы не видели gate | `/admin/calibration` + пункт в навигации |
| `POST …/discrepancies/check-against-fact-check-api` | Google Fact Check Tools | TODO называл это закрытием «четвёртого источника сверки §3.16 для всего продукта» — из TMA не вызывался | Кнопка «Сверить с фактчек-базами» рядом с «Проверить по ссылке», честное «не найдено ≠ правда» |
| `GET /legal-disclaimer?mode=` | юр. ссылки по домену и юрисдикции | Манифест доменов оставил слот `disclaimerKey`, но никто его не заполнил | `DomainLegalDisclaimer` на странице каждого домена, с датой последней проверки нормы |
| `POST …/live-hints/interview` | live-подсказка следующего вопроса опросника | Режим собеседования был только на backend | `LiveHintsSession mode="interview"`, вкладка «Live на собеседовании» в interview-pool |

Отдельный вывод: калибровочный контур был мёртв с **обеих** сторон (данные не поступали,
статус не показывался) — при этом README описывал его как реализованный. Это ровно
класс «implemented but never called», только на уровне целого механизма.

## 3. Проверено, расхождений нет
- Регистрация модулей: все `*.module.ts` импортированы (напрямую или через домены).
- Env: все `resolve('…')`/`process.env.*` есть в `.env.example` (после добавления
  `ASSEMBLYAI_WEBHOOK_SECRET`).
- `features.ts` / admin `endpoints.ts`: мёртвых экспортов нет (после подключения
  `getCalibrationStatus`).
- Схема: конвенции (`@@map`, индекс на каждом FK, временная метка) — тестом.
- README: цифры тестов обновлены; «93 модели» / «13 моделей» — исторический журнал
  утреннего аудита, оставлен как история.

## 4. Не сделано, требует решения
- ~~`GET /legal-disclaimer` зависит от `User.country` — где он заполняется?~~ **Проверено
  и исправлено (по подсказке владельца про заголовки Vercel):** `User.country` хранил
  *название* («Україна» из Nominatim `address.country` или ручной ввод), а
  `resolveJurisdictionBucket()` ждал ISO-код → **все пользователи всегда попадали в
  `OTHER` с пустым seed** — фича была мёртвой независимо от UI. Теперь три источника по
  приоритету: `User.countryCode` (из Nominatim `country_code` при гео-подсказке или
  распознанный по названию при ручном вводе) → `User.ipCountryCode` (заголовок Vercel
  `x-vercel-ip-country`, `TelegramAuthGuard` обновляет каждый запрос; `XX`/пусто не
  пишется) → название через таблицу соответствий. Явный выбор пользователя приоритетнее
  IP (VPN, поездки). Схема +2 поля, SQL с backfill из сохранённых названий, 3 теста.
- pg_cron-задания (`recompute`, `abandon-stale`, reminders) и миграции из
  `manual-migrations/` — на стороне владельца, как и раньше.
- `ASSEMBLYAI_WEBHOOK_SECRET` нужно завести в Vercel **до** деплоя этой версии —
  иначе транскрипция остановится (fail closed — намеренно).

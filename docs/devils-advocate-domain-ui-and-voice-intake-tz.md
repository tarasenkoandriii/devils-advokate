# ТЗ — UI и админка для доменных модулей + универсальный голосовой квиз на входе

Дата: 2026-08-30. Основание: аудит `AUDIT-2026-08-30.md`, §7.1 — семь backend-модулей
(`dtp`, `family-law`, `health`, `interview-pool`, `investment`, `major-purchase`,
`media-review`, ~170 роутов) не имеют ни одного вызова из TMA/admin. Решение владельца:
**строить UI и админку, не удалять**, плюс **универсальный голосовой квиз на входе**.

Паттерн проекта сохраняется: этот документ → самоаудит → реализация → пост-аудит.

---

## 0. Ключевое архитектурное решение — манифест, а не семь копий UI

Аудит контроллеров показал, что шесть из семи доменов построены по **одному и тому же
конвейеру** (media-review — отдельный, проще):

```
POST  <domain>/projects                                   { question }
POST  <domain>/projects/:projectId/onboarding-conversations
POST  <domain>/onboarding-conversations/:id/answers       { text }
POST  <domain>/onboarding-conversations/:id/extract       → draft конфига
POST  <domain>/projects/:projectId/config                 { ...draft, criteria[] }
GET   <domain>/projects/:projectId/config
POST/GET <domain>/configs/:id/<entities>                  advisors | providers | opportunities | variants | parties | participants | assets | evidence | candidates
POST  <domain>/<entity>/:id/<sessions>                    consultations | meetings
POST  <domain>/<session>/:id/generate-breakdown|generate-conclusion
POST  <domain>/<session>/:id/review|review-conclusion
GET   <domain>/configs/:id/comparison-table
GET   <domain>/configs/:id/budget  +  POST .../budget-line-items
```

Различия между доменами — **данные, не логика**: набор сущностей, поля форм, имена
сессий, дополнительные вкладки (evidence/insurance/fault у ДТП; assets/goal-history у
семейного права; lab-documents/source-references у здоровья; pipeline/relevance у
interview-pool; groups/pledge у инвестиций; location у крупной покупки).

Поэтому: **один набор generic-компонентов `DomainWorkspace`, параметризованный
манифестом `DomainManifest` (по одному объекту на домен).** Семь копий `DtpPage.tsx`,
`FamilyLawPage.tsx`… заведомо разошлись бы при первом же изменении конвейера.

```ts
// apps/tma/src/lib/domains/types.ts
export interface DomainManifest {
  id: DomainId;                       // 'dtp' | 'family-law' | ...
  apiPrefix: string;                  // 'dtp', 'family-law', 'interview-pool', ...
  title: string; icon: string; tagline: string;
  disclaimerKey?: string;             // юр./мед. дисклеймер перед стартом
  onboarding: { checklistRoute?: string };            // GET .../checklist если есть
  config: { fields: FieldSpec[]; criteriaCategories: string[] };
  entities: EntitySpec[];             // вкладки конфига: advisors, evidence, ...
  sessions?: SessionSpec;             // consultations|meetings + generate/review routes
  extras: ExtraTabSpec[];             // comparison-table, budget, cross-check, protocol-draft, ...
}
export interface EntitySpec { key; label; listRoute; createRoute; fields: FieldSpec[]; detailRoute?; children?: EntitySpec[] }
export interface FieldSpec  { name; label; type: 'text'|'textarea'|'number'|'date'|'select'|'bool'|'money'|'file'; required?; options?; hint? }
```

Generic-компоненты (все существующие Telegram-native паттерны переиспользуются —
`useMainButton`, `useBackButton`, `haptic`, `ConsentGate`):

| Компонент | Что делает | Покрывает роутов |
|---|---|---|
| `DomainHub` (`/domains`) | Плитки всех доменов + «Голосовой квиз» | — |
| `DomainProjectsList` (`/domains/[id]`) | Список проектов домена, создание по `question` | `POST projects`, список — см. §3 |
| `DomainOnboarding` | Q&A: `appendAnswer` по одному, кнопка «Извлечь» → `extract` → редактируемый draft → `POST config`. Голосовой ввод ответа — тот же `SpeakButton`/live-транскрипция | 4–5 |
| `DomainConfigView` | Цель/бюджет/валюта/критерии + вкладки из `entities`/`extras` | `GET config` |
| `EntityList` / `EntityForm` | Универсальный список + форма по `FieldSpec[]` | все `configs/:id/<x>` |
| `SessionPanel` | Создать консультацию/встречу → `generate-*` → показать breakdown → `review` | 4 на домен |
| `ComparisonTable` | Уже существующий `CriteriaComparisonService` формат — одна таблица на все | 6 |
| `BudgetPanel` | Строки + сводка по валютам (`byCurrency`, currency-blind bug class учтён) | 6×2 |
| `CrossCheckPanel`, `ProtocolDraftPanel`, `MediationNoticePanel` | Read-only панели | 8 |

Домен-специфичное, что **не ложится в манифест** и пишется руками (осознанно, список закрыт):
- `dtp`: `EvidenceCapture` (камера → base64, гео-согласие через `LocationConsentPrompt`), `AccessLogPanel`.
- `family-law`: `GoalEditor` с историей (`PATCH goal`, `goal-history`).
- `health`: `LabDocumentUpload` + `verify` (Vision OCR), `SourceReferences`.
- `interview-pool`: `QuestionnaireEditor` (`generate-draft` → правка → сохранить), `CandidatePipeline` (stage-progress, follow-up), `RelevanceSnapshot`, `RecruitingTeam` (invite/join), `CandidateShare` (публичный `/candidate-shares/[token]`), `ClientReports`.
- `investment`: `OpportunityMeetings`, `SourceComparisons`, `InvestmentGroup` (invite/join/pledge, `group-progress`).
- `major-purchase`: `VariantLocation` (place-id / geolocation / location-search + `location-consent`), `VariantComparisons`.
- `media-review`: `YoutubeSearch` → очередь → `link-conversation` (переиспользует `ConversationsSection` загрузку) → `summary`. Свой мини-workspace, не конвейер.

**Оценка объёма:** generic-слой ≈ 12 компонентов; ручных ≈ 20. Против ~60 при копировании.

---

## 1. Backend — что нужно добавить (немного, но обязательно)

1. **`GET <domain>/projects`** — списка проектов домена нет ни в одном из шести
   контроллеров (только `POST projects`). Это ваш же bug class «create-only API missing
   read endpoint». Без него `DomainProjectsList` невозможен. Реализация — один общий
   helper `listDomainProjects(userId, domainKind)` поверх `Project` (см. §1.3).
2. **`GET <domain>/onboarding-conversations/:id`** — текущие ответы (для возобновления
   онбординга после перезапуска Mini App). Сейчас `appendAnswer` пишет в
   `TranscriptSegment`, а прочитать их обратно нечем.
3. **Как проект помечен доменом.** Проверить в `*-onboarding.service.ts` `createProject()`:
   если домен хранится только в `<Domain>Config` (создаётся на шаге `config`), то проект
   до конфига неотличим от универсального → добавить `Project.domainKind`
   (`enum ProjectDomainKind { UNIVERSAL DTP FAMILY_LAW HEALTH INTERVIEW_POOL INVESTMENT MAJOR_PURCHASE }`),
   проставлять в `createProject()` каждого домена, миграция backfill по существующим конфигам.
4. **Admin-контроллеры** (`AdminSessionGuard`, `isOperator`), read-only + две операции:
   - `GET /admin/domains/summary` — счётчики проектов/конфигов/сессий по доменам за 7/30 дней,
     доля проектов, дошедших до конфига (воронка онбординга) — это то, что операторам
     реально нужно, чтобы увидеть «мёртвый» домен.
   - `GET /admin/domains/:domain/projects?cursor&status` — список с владельцем (telegramId,
     без ПД сверх уже показываемого в `/admin/users`), стадия конвейера, дата.
   - `GET /admin/domains/:domain/projects/:id` — конфиг + сущности + сессии, read-only.
   - `GET /admin/media-review/queues` — очереди + статусы (в т.ч. чтобы ловить застрявшие
     `PROCESSING`, баг из аудита §2).
   - `POST /admin/domains/:domain/projects/:id/freeze` / `unfreeze` — единственная
     мутация: заморозка проекта оператором (юр. чек-лист §8) — `Project.frozenAt`,
     `NotRestrictedGuard`-подобная проверка в доменных сервисах при мутациях. Пишется в
     `AuditLog`.
   Никаких «редактировать конфиг пользователя за него» — та же дисциплина, что у
   `/admin/users`.
5. **Intake (голосовой квиз)** — новый модуль `intake`, §2.

---

## 2. Универсальный голосовой квиз на входе (`IntakeModule` + `/intake` в TMA)

### 2.1 Цель
Пользователь, открыв приложение, **не обязан знать, какой из восьми сценариев ему нужен**
(универсальный + семь доменов). Квиз голосом (или текстом — fallback всегда) собирает
описание ситуации, AI оценивает её и подбирает сценарий; **всё накопленное передаётся в
выбранный сценарий без повторного ввода**. Если уверенность низкая или домен не
распознан — **универсальный сценарий** (`createProject` + `generateArguments`), не
ошибка и не «уточните».

### 2.2 Ход квиза
1. Экран `/intake`: «Расскажите, что происходит» — кнопка микрофона (live-транскрипция:
   `POST live-session/transcription-token` → `connectLiveTranscription()`, уже есть) и
   текстовое поле рядом. Без согласия `VOICE_PROCESSING`/`EXTERNAL_AI` — `ConsentGate`,
   как везде.
2. Первый ответ → `POST /intake/sessions { text }` → сервер:
   - создаёт `IntakeSession { userId, status: IN_PROGRESS, answers: [{q, a}] }`;
   - AI-вызов `intake-classify` (через `AIRouterService`, `jsonMode`, `PromptRegistry`):
     `{ scenario: DomainId|'UNIVERSAL', confidence: 0..1, followUpQuestion: string|null,
        extracted: { question, goal?, facts: string[] } }`.
   - Ответ клиенту: либо `followUpQuestion` (максимум **3** уточняющих вопроса — жёсткий
     потолок, как у `probing-detector` 0.9), либо `decision`.
3. Каждый следующий ответ → `POST /intake/sessions/:id/answers { text }` → тот же цикл.
4. Решение: `confidence >= 0.6` → сценарий домена; иначе → `UNIVERSAL`. Порог — константа
   в сервисе с тестом на границу (0.59 → универсальный, 0.60 → домен).
5. Экран подтверждения: «Похоже на: ДТП. Перейти?» с кнопками **«Да» / «Выбрать другой»
   (список всех) / «Универсальный»**. AI предлагает — пользователь подтверждает, тот же
   принцип, что у статуса персоны и стейкхолдеров. Ничего не создаётся до подтверждения.
6. `POST /intake/sessions/:id/dispatch { scenario }` — сервер **атомарно**:
   - домен: `<Domain>OnboardingService.createProject(question)` →
     `createOnboardingConversation` → **все накопленные ответы квиза replay-ятся через
     `appendAnswer()` по одному, в исходном порядке** (это и есть «передаём накопленные
     данные»: доменный `extract()` дальше работает на них как на своих) → клиент попадает
     сразу на `DomainOnboarding` с уже заполненной историей и может сразу нажать «Извлечь».
   - универсальный: `ProjectsService.create({ question: extracted.question, goal:
     extracted.goal })` → клиент на страницу проекта; `facts` пишутся в `ProjectLog` как
     заметка «из голосового квиза» (не в `PersonFact` — там нужна персона).
   - `IntakeSession.status = DISPATCHED`, `dispatchedProjectId`, `chosenScenario`,
     `suggestedScenario`, `confidence` — **оба** сценария сохраняются: расхождение
     «предложил/выбрал» — это калибровочный сигнал для `CalibrationService` и телеметрии
     (`/admin/telemetry` по taskType `intake-classify`).
7. Сессия без dispatch 24 ч → `ABANDONED` (pg_cron, как reminders; не BullMQ).

### 2.3 Схема
```prisma
model IntakeSession {
  id                  String   @id @default(cuid())
  userId              String
  status              IntakeStatus  // IN_PROGRESS | DISPATCHED | ABANDONED
  answers             Json      // [{ question: string|null, text: string, at: ISO }]
  suggestedScenario   String?   // DomainId | 'UNIVERSAL'
  confidence          Float?
  chosenScenario      String?
  dispatchedProjectId String?
  createdAt/updatedAt
  @@index([userId, status])
}
```
Аудио не персистится — ни на клиенте, ни на сервере (тот же инвариант, что у всего
проекта). Только текст.

### 2.4 Явные границы
- Квиз **не заменяет** доменный онбординг — он его *предзаполняет*. Доменные вопросы
  (`checklist`) остаются у домена.
- Максимум 3 уточнения, потом обязательное решение. Универсальный сценарий — всегда
  доступен одной кнопкой на любом шаге.
- AI никогда не «переводит» пользователя в домен молча.
- Голос — дополнительный канал ввода, текст равноправен (Telegram WebView без микрофона —
  честно задокументированное ограничение §3.4).

---

## 3. Порядок реализации (фазы, каждая — самостоятельно сдаваемая)

| Фаза | Объём | Выход |
|---|---|---|
| **A** | Backend: `Project.domainKind` + миграция, `GET <domain>/projects` ×6, `GET onboarding-conversations/:id` ×6, тесты | `tsc` + тесты зелёные |
| **B** | TMA generic-слой: манифесты ×6, `DomainHub`, `DomainProjectsList`, `DomainOnboarding`, `DomainConfigView`, `EntityList/Form`, `SessionPanel`, `ComparisonTable`, `BudgetPanel` | все 6 доменов проходимы от создания до comparison-table |
| **C** | Ручные домен-компоненты (список §0) + `media-review` workspace | 100 % роутов семи модулей вызываются из TMA |
| **D** | Backend `IntakeModule` + схема + тесты (классификация, порог, replay в домен, fallback) | |
| **E** | TMA `/intake` + вход с главной + `ReligiousReminderBanner`-style точка входа | |
| **F** | Admin: `/admin/domains` (summary, список, карточка, freeze), `/admin/media-review`; backend admin-контроллеры | |
| **G** | Пост-аудит: та же сверка «роуты vs вызовы», что в аудите; обновить README/TODO | |

Оценка честная: это **не один заход**. Каждая фаза завершается прогоном `npm run
typecheck && npm test` из корня.

## 4. Самоаудит ТЗ (выполнен 2026-08-30, до реализации)
- [x] `createProject()`: `dtp`/`health`/`major-purchase` — только `question`;
  **`family-law` требует `contractType`** (enum `FamilyLawContractType`), **`health` требует
  согласие `HEALTH_DATA`**, `interview-pool`/`investment` — опциональные `teamId`/`groupId`.
  → Intake-dispatch для family-law должен либо извлечь `contractType` из классификации,
  либо спросить его на экране подтверждения (одним селектом); для health — показать
  `ConsentGate(HEALTH_DATA)` до dispatch. Квиз не обходит согласия.
- [x] Маркер домена на `Project` **уже есть** — `Project.mode: ProjectMode`
  (STANDARD | MAJOR_PURCHASE | INTERVIEW_POOL | INVESTMENT | HEALTH | FAMILY_LAW | DTP).
  §1.3 снят, миграция не нужна.
- [x] `appendAnswer()` пишет только текст ответа в `TranscriptSegment` (isSelf), вопросов
  не хранит → replay из intake пишет ответы как есть, `extract()` работает на них
  без изменений.
- [x] `interview-pool` и `investment` — `@Controller()` без префикса, пути полные в
  декораторах → манифест хранит полные пути, не `${prefix}/...`.
- [x] `media-review` — отдельный workspace (§0).

**Фаза A выполнена в тот же день:** `src/common/domain-onboarding-reads.ts`
(`listDomainProjects`, `getOnboardingAnswers`), роуты `GET <domain>/projects` и
`GET <domain>/onboarding-conversations/:id` в шести контроллерах, 4 теста
(`domain-onboarding-reads.spec.ts`). Компиляция и тесты — зелёные.

**Дополнение 2026-09-02 — заполнение голосом по всем доменам (решение
владельца).** До этого микрофон был только у ответа онбординга и у
`/intake`; все многострочные поля форм доменов (`FieldSpec.type =
'textarea'`: цель, описание, опыт, заметки по разбору, итоговый вывод,
«опишите ситуацию одной фразой» при создании проекта, поля ручных панелей)
принимали только текст. Теперь `EntityForm` рендерит каждое такое поле
через `VoiceTextInput` — голос и текст равноправны, без микрофона или
согласия остаётся текст; `FieldSpec.placeholder` добавлен для подсказки в
поле. В админской песочнице тот же принцип: семь полей «Дополнительный
ответ» онбординга доменов (здоровье, покупка, инвестиции, подбор,
семейное право, ДТП, поиск работы) переведены на `VoiceTextInput` админки
(ru/uk — Soniox, en — AssemblyAI, «авто» — запись целиком). Однострочные
поля (имя, цена, URL, пункты списков) остаются текстовыми намеренно —
диктовать одно слово дольше, чем набрать. Запись останавливается сама
после 30 с тишины (`lib/silence-watchdog.ts`: RMS с AnalyserNode +
обновления текста от провайдера как сигналы активности) — забытый
микрофон не стримит комнату провайдеру и не тарифицируется.

**Фаза B выполнена 2026-08-30:** `apps/tma/src/lib/domains/{types,manifests,api}.ts`
(шесть манифестов), `components/domains/{EntityForm,EntityPanel,BudgetPanel,JsonPanel,
DomainOnboarding,DomainConsentGate,VoiceTextInput}.tsx`, страницы `/domains`,
`/domains/[domain]`, `/domains/[domain]/[projectId]`, ссылка с главной. `VoiceTextInput`
переиспользует live-транскрипцию (Пункты 81–82) — голосовой ввод ответа онбординга уже
работает, это же поле пойдёт в `/intake` (фаза E). `next build` — 0 ошибок.
Честные границы B: `interview-pool` — только онбординг + конфиг + compliance-flags
(кандидаты/pipeline/опросник/команды — фаза C); ссылки `/intake` и `/media-review` на
хабе ведут на ещё не существующие страницы (фазы E и C); `checklist` крупной покупки
рендерится generic-JSON, не как чек-лист с галочками.

**Фаза C выполнена 2026-08-30:**
- backend: `GET media-review/queues` (create-only API — списка очередей не было), в
  `getQueue` элементы отдают `conversation.projectId` для ссылки «открыть разбор»; тест.
- `apps/tma`: `/media-review`, `/media-review/[queueId]` (поиск YouTube → очередь →
  привязка записи → polling статусов, пока есть PROCESSING → сводка сигналов);
  `InterviewPoolWorkspace` (опросник AI-черновик→правка→сохранить, кандидаты + этапы +
  follow-up + повестка + share, релевантность latest/regenerate/history, команда
  create/invite/join, отчёты заказчику create/review/send); `DomainExtrasManual`
  (инвест-группа create/invite/join/pledge/progress; локации вариантов — текстовый
  поиск / геолокация устройства с LOCATION-согласием по требованию backend; редактор
  цели семейного права с историей; share-all с поимённым подтверждением согласия);
  `/candidate-shares/[token]` (preview → accept); mediation-notice как подпанель
  консультации; кнопка «подставить координаты устройства» в любой форме с
  latitude/longitude (доказательства ДТП). `next build` — 0 ошибок.
- Сверка «доменные роуты vs вызовы из TMA»: из 168 роутов семи модулей не вызываются
  только `GET dtp/evidence/:id` (деталь — список отдаёт то же), `GET
  <domain>/criteria/:id/cross-consultation-check` (по-критериальный — используется
  config-level вариант) и `PATCH client-reports/:id` (правка содержимого отчёта до
  отправки — отложено, review/send есть). Остальные 165 — вызываются.

**Фазы D+E выполнены 2026-08-30:**
- backend `IntakeModule`: `IntakeSession` + `IntakeStatus` в схеме (только текст,
  `suggestedScenario`/`confidence`/`chosenScenario` хранятся раздельно), `IntakeService`
  (classify через `AIRouter` с `validateOutput`, порог `0.6` включительно, потолок 3
  уточнения — после него `decision` обязателен, `dispatch` = createProject → onboarding →
  replay всех ответов через `appendAnswer()` домена в исходном порядке; UNIVERSAL →
  `ProjectsService.create`, факты в `goal`, т.к. `ProjectLog` derived-only; family-law
  без `contractType` — BadRequest; `abandonStale()` 24 ч). Контроллер: `POST
  intake/sessions`, `GET|POST sessions/:id[/answers|/dispatch]`, `POST abandon-stale`
  (тот же `SCHEDULER_DISPATCH_SECRET`, что у scheduler/dispatch). 13 тестов.
  Модуль импортирует шесть доменных модулей; домены о квизе не знают.
- `apps/tma` `/intake`: `ConsentGate(EXTERNAL_AI)` → `VoiceTextInput` → уточнения (со
  счётчиком оставшихся) → экран «Похоже на…» с уверенностью, извлечёнными
  ситуацией/целью/фактами, «Да» / «Выбрать другой» (все 7) / «Универсальный»;
  `HEALTH_DATA` через `DomainConsentGate` до dispatch; селект `contractType` для
  семейного права; после dispatch — сразу в `DomainOnboarding` с заполненной историей
  или на страницу проекта. Ссылка «Не знаете, с чего начать?» на главной и плитка
  на хабе. `next build` — 0 ошибок.
- Не сделано: миграция БД (в репозитории нет `prisma/migrations` — схема-first, как и
  раньше: `prisma migrate dev` у владельца); pg_cron-задание для `abandon-stale` —
  SQL по образцу reminders добавить в Supabase вручную; телеметрия `intake-classify`
  в `/admin/telemetry` появится автоматически по `taskType`, но отдельного отчёта
  «предложил ≠ выбрал» ещё нет (фаза F).

**Фаза F выполнена 2026-08-30 (read-only):** `AdminDomainsModule` — `GET admin/domains/summary`
(воронка: всего / 7 дн / 30 дн / с конфигом / доля), `GET admin/domains/:domain/projects`
(фильтр `withConfig` — «застрявшие в онбординге»), `GET .../projects/:id` (проект + конфиг
как есть, без вложенных доказательств/документов), `GET admin/intake/summary` (статусы,
ср. уверенность, ср. уточнений, матрица «предложил × выбрал», mismatchRate),
`GET admin/media-review/queues` (статусы элементов, «застрявшие» PROCESSING > суток).
`apps/admin`: `/domains`, `/domains/[domain]`, `/intake`, `/media-review`, пункты в
`AdminNav` (isOperator). 5 тестов. `next build` — 0 ошибок.
**Самоаудит F — freeze был отложен (см. ниже — реализован в добивке):** единственная планировавшаяся мутация
(`POST .../freeze`) требует проверки «проект заморожен» в *каждом* мутирующем методе
шести доменных сервисов (у них нет общего chokepoint'а: `assertOwned*` свои у каждого).
Флаг без принуждения — хуже, чем его отсутствие (оператор считает, что заморозил, а
пользователь продолжает). Блокировка пользователя (`/admin/users` → block) покрывает
срочный случай. Сделать позже как отдельный пункт с общим `assertProjectWritable()`.

**Фаза G — пост-аудит 2026-08-30:** `tsc` чист в api/tma/admin/landing; api — 57 jest /
471 + 63 standalone / 664; tma — 81; сборки tma и admin — 0 ошибок. Все 17 новых
роутов (intake, admin/domains, admin/intake, admin/media-review, media-review/queues)
вызываются из TMA/admin, кроме `POST intake/abandon-stale` — он для pg_cron. Сверка
семи доменов — см. фазу C (165/168).

**Добивка 2026-08-30 (после G):**
- `intake-classify` теперь берёт ACTIVE-версию из `PromptRegistry` (promptId =
  taskType) поверх дефолтной константы `INTAKE_DEFAULT_SYSTEM_PROMPT`, `promptVersionId`
  уходит в телеметрию — матрица в `/admin/intake` сопоставима с версией промпта. 2 теста.
- `IntakeSession` получил `@@map("intake_sessions")` — как у всех моделей проекта
  (упущение самоаудита D: остальные модели snake_case).
- `prisma/manual-migrations/intake_session.sql` (эквивалент миграции, для сверки/ручного
  применения) и `pg_cron_intake_abandon.sql` (суточное задание, по образцу reminders).
- `PATCH client-reports/:id` — правка текста отчёта заказчику до review/send в TMA;
  из сверки фазы C непокрытыми остаются только `GET dtp/evidence/:id` и по-критериальный
  cross-check (оба дублируют покрытые эндпоинты).
- **Freeze реализован** — не через правку ~30 `assertOwned*`-хелперов, а одним
  `ProjectFrozenGuard` (`src/project-freeze/`) на классах шести доменных контроллеров:
  метод ≠ GET → по таблице «сегмент маршрута → как достать projectId» (projects/:id,
  configs/:id, advisors|providers|opportunities|variants|participants|evidence|lab-documents
  /:id → через config, consultations|meetings/:id → через родителя, onboarding-conversations
  → conversation.projectId, pipeline-statuses и client-reports → projectId) → `423 Locked`
  с заметкой оператора. Сущности без проекта (candidate-profiles, recruiting-teams,
  investment-groups, location-consent) под guard не попадают. Чтения открыты всегда.
  `Project.frozenAt/frozenNote/frozenById` в схеме (+ SQL в `intake_session.sql`),
  `PATCH admin/domains/:domain/projects/:id/freeze` с `AuditLog` (`project.frozen|unfrozen`),
  кнопка с полем причины в `/admin/domains/[domain]`. 6 тестов guard + чистой
  функции `parseDomainRoute`. Итог: api — 58 jest / 479.

## 5. Доменная вёрстка — образец на ДТП (2026-08-30)

Generic `JsonView` заменён на доменную вёрстку для ДТП: `components/domains/dtp/`
(`dtp-types.ts` — типы ответов backend и форматтеры; `DtpPanels.tsx`, `DtpWorkspace.tsx`).
Страница `/domains/dtp/[projectId]` рендерит `DtpWorkspace`, остальные домены — generic.

Что показывает каждая вкладка и почему именно это:
- **Обзор** — когда/бюджет/счётчики, цель, критерии по категориям (вина / ущерб / страховое
  покрытие / прочее) с меткой «обязательно», подсказка следующего шага.
- **Участники** — роль как бейдж (Я / другая сторона / третье лицо), «скрылся с места»,
  страховка сразу в карточке (backend `listParticipants` теперь `include: { insurance }`,
  без N+1), предупреждение «нет страховки → расходы лягут напрямую», подсказка добавить
  роль «Я», если её нет.
- **Доказательства** — тип/звук/время/геометка/хеш, журнал доступа по кнопке, объяснение,
  что такое доказательная фиксация.
- **Консультанты** — карточки, внутри консультации со статусом (без разбора / черновик /
  проверена) и таблицей критерий → «что сказал»; кнопки «разобрать» (только при наличии
  записи) и «проверил, подтвердить».
- **Сравнение** — матрица критерии × консультанты, пустая ячейка = «не затрагивалось»,
  явная оговорка «таблица не выбирает лучшего»; сумма оценок против целевого бюджета.
- **Сверка** — статус по каждому критерию (расхождений нет / расхождение / мало данных),
  сводка сверху, показания консультантов рядом.
- **Бюджет** — по валютам: расходы / покрытие / «из своего кармана», подсветка превышения
  целевого; строки разделены на расходы и покрытие; предупреждение про legacy-оценки.
- **Соглашение** — дисклеймер, текст, «скопировать» / «в Telegram».
- **Вина** — официальный статус сверху или «официального нет — всё ниже мнения», таймлайн.

Формы ввода не переписывались — `EntityForm` по манифесту. Тиражирование на другие
домены: скопировать структуру `dtp-types.ts` (типы под свой контроллер) и заменить
вкладки по одной, начиная с сравнения/сверки/бюджета — они одинаковы у dtp,
family-law, health (общий `CriteriaComparisonService`), поэтому туда стоит вынести
общие компоненты `ComparisonMatrix`, `CrossCheckList`, `BudgetByCurrency` вторым шагом.

**Шаг 2 выполнен (2026-08-30):** общие компоненты вынесены в
`components/domains/shared/ConsultationPipeline.tsx` — `CriteriaByCategory`,
`ConsultationCard`, `SourceCard` (консультант/врач с консультациями и доп. содержимым),
`ComparisonMatrix`, `CrossCheckList`, `BudgetByCurrency`, `TextDocument`, хуки
`useList`/`useOne`. ДТП переведён на них (дубли удалены). На их основе:
- **Семейное право** (`family-law/FamilyLawWorkspace.tsx`): обзор (тип договора —
  backend `getConfig` теперь отдаёт `project.contractType`), стороны (Я / супруг(а)),
  имущество с итогами «совместное / личное» по валютам и владельцем из сторон, юристы с
  уведомлением о медиации внутри карточки, сравнение, сверка, бюджет, соглашение, статус
  (официально / мнения), цель с историей.
- **Здоровье** (`health/HealthWorkspace.tsx`): дисклеймер «не диагноз» сверху, врачи с
  источниками в карточке, анализы как OCR-черновик с кнопкой «текст совпадает с
  документом», сравнение, бюджет. Сверки нет — у health-контроллера нет
  `cross-consultation-check` (кандидат в backend, если понадобится).
Итого доменную вёрстку имеют dtp, family-law, health; generic остаются interview-pool,
investment, major-purchase — у них другой конвейер (кандидаты / предложения / варианты),
общий слой к ним не применим напрямую.

**Крупная покупка (2026-08-30):** `major-purchase/MajorPurchaseWorkspace.tsx` — свой
конвейер, общий слой не применим, но принципы те же: цена каждого варианта как бейдж
относительно диапазона бюджета («в бюджете / выше на N / ниже ожидаемого»), сверка с
объявлениями по ссылке со средней ценой и вердиктом «в рынке / заметно выше / ниже»,
встречи с покрытием критериев ✓ / ◐ / ✕ / ? (последнее = «тема не поднималась» —
вопрос к следующей встрече, не минус), вывод как черновик AI → редактируемый текст
пользователя → подтверждение; матрица сравнения: цена, сверки, локация, критерии,
последний вывод; локации — существующая `VariantLocationPanel`. В онбординге чек-лист
теперь рендерится списком, для крупной покупки — с выбором категории (backend требует
`?category=`, раньше уходил без неё).
Доменную вёрстку имеют 4 из 6 (dtp, family-law, health, major-purchase); generic —
interview-pool (пять ручных панелей уже есть, generic только обзор/compliance) и
investment (предложения / встречи / сверки с источником / группа).

**Все шесть доменов на доменной вёрстке (2026-08-30):**
- **Инвестиции** (`investment/InvestmentWorkspace.tsx`): дисклеймер «не инвестиционный
  совет» первым блоком, предложение → встречи с разбором (общий `ConsultationCard`) +
  публичные источники с текстом на момент добавления, матрица сравнения (общий
  `ComparisonMatrix`, теперь понимает `opportunities`/`meetingsCount`/`comparisonCount` и
  необязательный `budget`), группа — существующая панель. **Backend:** снова
  create-only — у предложения не было ни `GET meetings`, ни `GET comparisons`; добавлен
  `GET investment/opportunities/:id` с `meetings[]`+`comparisons[]` (манифест обновлён).
- **Подбор персонала** (`interview-pool/InterviewPoolOverview.tsx`): обзор вакансии
  (зарплата / занятость / формат / оформление / число вопросов), предупреждения о
  требованиях по полу и возрасту как ограничениях, требующих обоснования, флаги
  соответствия с цитатой («приложение не запрещает — показывает»), этапы собеседования
  таймлайном. Пять ручных панелей фазы C остались как есть; вкладка compliance-флагов
  слита в обзор.
`JsonView`/`JsonPanel` остаются только как fallback в generic-страницах (`EntityPanel`,
`BudgetPanel`) и в ручных панелях interview-pool (повестка/релевантность/команда —
структуры, которые backend отдаёт как свободный JSON). Это следующий кандидат, если
захочется добить: `agenda`, `relevance-snapshot`, `client-reports.content`.

**Добивка JsonView (2026-08-30):** `interview-pool/InterviewPoolViews.tsx` — повестка
(нераскрытые вопросы, обязательные сверху, «повестка пуста» как успех), снимок
релевантности (доля раскрытых обязательных вопросов как прозрачная метрика, покрытие
✓/◐/✕ по вопросам, «на что обратить внимание»; история — компактно), содержимое отчёта
заказчику (SUMMARY — воронка + таблица по покрытию; PER_CANDIDATE — процесс, покрытие,
вывод-черновик). Прогресс инвест-группы — цифры + полоса. Попутно найден баг фазы C:
`ClientReportsPanel` получал `config.candidates`, которого нет → кнопки «отчёт по
кандидату» никогда не появлялись; теперь кандидаты берутся из pipeline. Удалён мёртвый
код (панели family-law/investment/major-purchase в generic-странице после перехода
на workspace).
Остаток `JsonView`: generic-fallback (`EntityPanel`, `BudgetPanel`, generic обзор —
ни один домен их больше не рендерит), `candidate-shares` preview и «кандидаты
команды» в TeamPanel. Всё остальное — доменная вёрстка.

**Сверка с учётом HTTP-метода (2026-08-30):** первый скрипт сравнивал только пути и
пропустил create-only коллекции. Прогон с методами нашёл ещё три в зоне доменов:
`POST candidate-profiles`, `POST recruiting-teams`, `POST investment-groups` — без
единого GET, из-за чего TMA просил пользователя **ввести ID профиля кандидата
руками**, а панели команды/группы не знали, где пользователь состоит. Добавлены
`GET candidate-profiles` (свои + расшаренные в мои команды), `GET recruiting-teams`,
`GET investment-groups` (с ролью / взносом), 2 теста; в TMA — выбор кандидата из списка,
список «мои команды / группы» с переключением. Остальные находки скрипта — действия
(`detect`, `generate`, `enable`…) или коллекции, читаемые через родителя (`budget`,
`conversation`), не гапы.

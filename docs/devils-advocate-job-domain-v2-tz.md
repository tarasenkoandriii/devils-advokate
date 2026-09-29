# Devil's Advocate — ТЗ: Job Domain v2 — «лист условий» как договорный документ

> Компаньон к `docs/devils-advocate-interview-pool-tz.md` (агентство, interview-pool v1
> реализована), к Пункту [job-search] (соискатель, реализован без отдельного ТЗ — описан
> в `TODO.md`) и к `devils-advocate-job-landing-tz.md` (в корне репозитория; обещания
> аудиториям лендинга). Не заменяет их — достраивает общее ядро под три роли найма и
> задаёт этап 2.
>
> Дата: 2026-09-02. **Ревизия 4 — консолидированная.** Ревизии 1–3.1 того же дня
> накапливали правки поверх текста (три самоаудита, четыре набора «аддитивных» схем, пять
> разделов приёмки); внешнее ревью нашло 80 дефектов, из которых большая часть — не
> ошибки замысла, а расхождения между слоями одного документа. Ревизия 4 переписывает
> документ как **одно актуальное состояние**: одна схема (§5), один API (§6), одна
> приёмка (§11), один порядок сдачи (§9), один реестр функций как источник истины по
> ролям и связкам (§12). История правок — в журнале ревизий (§16), а не в теле.
> Семь вопросов, которые прошлая ревизия оставляла владельцу, закрыты решениями с
> обоснованием (§13); каждое можно отменить одной строкой.
> Статус: **ПРОЕКТ, к обсуждению с владельцем** — ничего из этого документа в коде ещё
> нет. Основание: решение владельца сформулировать v2 вокруг тезиса «интервью и CV под
> конкретную вакансию — частный случай договорного документа», три поддомена
> (соискатель, агентство, работодатель), работодатель — это компания.

---

## 0. Словарь

Термины ниже употребляются в документе только в этих значениях; ревью показало, что
половина противоречий прежних ревизий — терминологические.

| Термин | Значение | Чем НЕ является |
| --- | --- | --- |
| **Соискатель** | пользователь режима `JOB_SEARCH`; ищет работу себе | «кандидат» |
| **Кандидат** | `CandidateProfile` в проекте агентства или работодателя — человек, которого рассматривают; как правило, не пользователь | соискатель |
| **Агентство** | пользователь режима `INTERVIEW_POOL` (имя режима историческое, §13.7); команда `RecruitingTeam.teamType = AGENCY`; подбирает для заказчиков | работодатель |
| **Работодатель** | пользователь режима `EMPLOYER_HIRING`; **всегда компания** (юрлицо или ФОП), представленная людьми; команда `teamType = EMPLOYER` | человек |
| **Компания** | объект досье — `EmployerDossier`: юрлицо/ФОП, идентифицируемое кодом реестра или доменом; одна сущность на все роли | представитель |
| **Представитель** | человек, действующий от имени компании (HR, рекрутер, нанимающий менеджер) — `EmployerRepresentativeClaim`; фиксируется заявление о роли, исследуется не он, а его связь с компанией | объект досье |
| **Заказчик** | компания-клиент агентства (в отчётах, брифах, `ClientReport`) | работодатель-пользователь |
| **Нанимающий менеджер** | представитель работодателя, для которого ищут человека; в проекте работодателя — член команды | заказчик |
| **Вакансия** | объявление о найме на позицию: у соискателя — `JobVacancy` (принесённый текст), у агентства/работодателя — `VacancyPosting` (свой текст) и сам проект | «позиция» |
| **Позиция** | только `ClausePosition` — позиция стороны по пункту листа | вакансия |
| **Пункт** (`TermsClause`) | строка листа условий; ровно одного из двух видов: **требование** (`REQUIREMENT`) — «что я требую от другой стороны», к нему применимо *покрытие*; **условие** (`CONDITION`) — «что я предлагаю/заявляю», к нему применима *позиция* (`stance`) | «условие» как общее слово |
| **Критерий** | только `JobSearchCriterion` соискателя (источник пунктов) | пункт, «критерий прорывной» (в §10 — «признак») |
| **Вопрос анкеты** | только `QuestionnaireItem` агентства/работодателя (источник пунктов) | пункт |
| **Лист** | `TermsSheet` трёх видов: `VACANCY` (условия и требования компании по вакансии — у агентства/работодателя, один на проект), `INTERVIEW` (по кандидату), `VACANCY_RESPONSE` (соискателя по чужой вакансии) | «общий документ сторон» — его нет (§7.3) |
| **Этап 2** | всё, что после ядра (Я) и ядра работодателя (1б); связки Т/П/Б — его подмножества и порядок внутри него | «второй этап» ≠ отдельная сущность |
| **Копия с происхождением** | единственный способ передачи данных между проектами: копия + `sharedFromProjectId`/`sourceProjectId` + момент + чьё согласие | ссылка на чужой оригинал |

Именование полей `kind`: в документе оно осталось только у `TermsSheetKind` и
`TermsClauseKind`. Площадка варианта текста — `channel`, язык — `lang`, тип команды —
`teamType`, источник вакансии — `intakeSource`.

---

## 1. Проверено перед написанием — что есть в коде и где зазор

Проверено прямым чтением `schema.prisma`, `job-search*.service.ts`,
`interview-pool*.service.ts`, `chat-import*`, `ai-router.service.ts`, манифестов TMA
(`apps/tma/src/lib/domains/manifests.ts` — семь манифестов: dtp, family-law, health,
investment, major-purchase, interview-pool, job-search) и ТЗ interview-pool, а не по
памяти. Утверждения ниже — с оговорками, которые внешнее ревью заставило уточнить.

**Что есть.**

- Соискатель (`job-search`): `JobSearchConfig` (роль, город/регион, зарплатное
  ожидание, формат, `cvDraft`/`cvText`/`cvReviewedAt`), `JobSearchCriterion`
  (`category` — обязательный enum из 5 значений, `isRequired`), `JobVacancy`
  (`sourceUrl` и `siteHost` — **NOT NULL**, `rawText`, после сверки —
  `matchBreakdown [{criterionId, coverage, note}]`, `locationMatch`, `salaryMentioned`
  дословно; потолок `MAX_VACANCIES_PER_CONFIG = 50`). Три AI-задачи:
  `job-search-onboarding-extract`, `job-search-cv-draft` («строго из слов кандидата»;
  `CvDraft` — `skills: string[]`, `highlights: string[]`, без мест под цитаты),
  `job-search-vacancy-match` (покрытие без вердикта). Статистика — без AI.
- Агентство (`interview-pool`): `InterviewPoolConfig`, `QuestionnaireItem`
  (`category String?`), `CandidateProfile` (не `Person`; **привязан к
  `RecruitingTeam`**, то есть виден во всех проектах команды), `CandidatePipelineStatus`
  (стадии без ACCEPTED/REJECTED — намеренно), `CandidateStageProgress.conversationId`
  (мост к транскрипту), `PoolRelevanceEntry` (`criteriaBreakdown` — покрытие +
  `sourceSegmentId`; `attentionPoints` и `followUpRequestsDraft` — отдельные колонки),
  `ComplianceFlag` (`configId` NOT NULL; цитата, никогда не в отчёте), `ClientReport`
  (черновик → ревью → отправка; `coverageScore` в SUMMARY считается всегда и
  сохраняется в `content`), `CandidateShare` (`sourceCandidateId` NOT NULL,
  `candidateConsentConfirmed`, TTL 72 ч), `RecruitingTeam` с ролями `OWNER | MEMBER`,
  `assertInterviewPoolProjectAccess` — жёстко требует `mode === INTERVIEW_POOL`.
- Общие механики: `CriteriaComparisonService` (используется двумя доменами — ДТП и
  семейное право; форма подтверждена тремя), `DecisionObjective`,
  `NegotiationBoundaries`, `Commitment` (`personId` **NOT NULL**),
  `ConversationAgenda`, `Prediction`/`OutcomeScenario` (у сценария есть `confidence`),
  `SafeShareAction`, `live-hint-interview` (`LiveHintEvent` связан с
  `QuestionnaireItem`), спарринг, импорт переписок (`.eml`/чаты разбираются **на
  клиенте**, на сервер идут `sender/text/timestamp`, создаётся `Conversation` +
  `TranscriptSegment`; сущности «импорт» нет), `fetchUrlText`
  (`common/safe-url-fetch.ts`), фоновая полоса роутера `enqueue()` (сегодня — только
  медиа-блоки), голосовой ввод во всех формах доменов, `Person` (однопользовательская
  модель: `createdByUserId`, команде не видна), `enum-migration-lag`.

**Зазоры, подтверждённые кодом.**

1. **CV одно на проект, а не на вакансию.** `cvText` живёт в `JobSearchConfig`;
   `matchVacancy()` сверяет вакансию с этим единственным CV. Ни модели варианта, ни
   привязки текста CV к `JobVacancy`.
2. **Три структурных близнеца без общего слоя.** `JobSearchCriterion`,
   `QuestionnaireItem`, `QuizCriterion` — одна форма (`text`, `isRequired`,
   `orderIndex`) с точностью до категории (enum / строка / нет), три таблицы, три
   набора промптов. `matchBreakdown` и `criteriaBreakdown` — одна форма покрытия,
   разные JSON без схемы, у соискателя без ссылки на источник.
3. **Нет понятия «оффер».** Ни принести письмо с условиями и сверить, ни собрать
   черновик условий из согласованного.
4. **Нет позиции стороны по пункту с историей.** Каждая сверка — снимок,
   перезаписывающий предыдущий (история снимков есть только у агентства).
5. **Одна граница проходит через два домена и не названа:** критерии соискателя и
   анкета агентства — требования сторон одного договора, живущие порознь.
6. **Работодатель — объект, а не пользователь.** Он присутствует как «заказчик» в
   брифах и отчётах, но лист условий у него никто не ведёт, текст вакансии он пишет
   вне продукта, кандидатов получает PDF.
7. **Компания на другом конце никем не проверяется.** Агентство отправляет данные
   кандидатов заказчику, соискатель — CV работодателю; сущности «компания» нет ни в
   одном домене.

---

## 2. Тезис: наём — это переговоры по договору, а не «подбор»

Вакансия — оферта работодателя: набор требований и условий. CV под конкретную
вакансию — встречное предложение соискателя: по каждому требованию оферты его
покрытие («покрываю — вот чем, своими словами»; «частично»; «не покрываю»; «не знаю,
о чём речь») плюс его собственные требования к работодателю (зарплата, формат,
локация). Интервью — переговорная сессия по этому документу: вопрос проверяет пункт,
ответ фиксирует позицию, «вернёмся с ответом» — открытый пункт с обязательством и
сроком. Оффер — редакция документа стороной работодателя. Отказ — документ, закрытый
одной стороной.

Отсюда одна сущность на три поддомена — **лист условий** (`TermsSheet`): пункты
двух сторон (`EMPLOYER`/`CANDIDATE`), позиции по каждому с опорой на источник,
редакции, статус. CV под вакансию — **рендеринг листа со стороны соискателя**
(детерминированная компиляция, как `compileCvText` и `getSettlementProtocolDraft()`).
Повестка интервью — **пункты с `unknown`**. Разбор собеседования — **заполнение
позиций цитатами из транскрипта** (это уже делает `PoolRelevanceEntry`; он становится
проекцией). Оффер — **условия со `stance = accepted` плюс новые условия**, принесённые
текстом и разобранные так же, как вакансия.

Что тезис даёт: один язык для трёх ролей (покрытие + источник), один движок сверки
«данные против пунктов», историю переговоров вместо снимков, раскрываемую до цитаты
explainability. Что запрещает — одним правилом то, что уже запрещено в обоих доменах:
**никакого единого числа по стороне**. У договора нет балла — есть пункты, по которым
договорились, и пункты, по которым нет. Ни ранга, ни «шанса оффера», ни
«подходит/не подходит». Решения принимает человек с каждой стороны (лендинг-ТЗ §2,
п. 4 «Честные границы»).

Честные границы тезиса:

- Интервью — не только переговоры по условиям. Soft skills, «сработаемся ли» — лист
  не моделирует и не должен: пункты про личность — первый шаг к скорингу личности.
  Позиция по пункту «коммуникация» — только цитата, без оценки.
- CV — не только ответ на оферту. Базовое CV «про себя вообще» (`cvText`) остаётся;
  вариант под вакансию — производная.
- Стороны не обязаны быть пользователями одновременно, и **общего документа сторон не
  существует** (§7.3): у каждой роли свой проект и свой лист; между проектами ходят
  копии с происхождением и согласием.

---

## 3. Юридический ландшафт — что меняется относительно interview-pool v1

Ландшафт v1 (EU AI Act Annex III, NYC LL144, «советник, не судья», сквозной запрет
дискриминации, шеринг как отдельный слой риска) — без изменений; см.
`docs/devils-advocate-interview-pool-tz.md` §2.

1. **Оффер и переговоры о зарплате — не юридическая консультация.** Продукт сверяет
   текст оффера с тем, что человек сказал сам и что говорили ему; не толкует трудовое
   право и не оценивает законность условий. На пунктах из фиксированного списка
   (испытательный срок, неконкуренция, штрафы, NDA) — «уточните у юриста», как в ДТП
   и семейном праве.
2. **Позиция с цитатой — персональные данные обеих сторон.** Лист наследует режим
   хранения транскриптов (согласия `RECORDING`/`EPHEMERAL_SERVER`/
   `THIRD_PARTY_AUDIO_RECORDING`, удаление у STT-провайдера после расшифровки, экспорт
   и удаление по art. 15/17 — каскадом от `Project`).
3. **Отзыв согласия кандидата на шеринг** (v1 §8 — вне объёма) становится
   обязательным: как только соискатель может сам передать агентству или работодателю
   свои данные (К-8), он должен иметь право их отозвать, а получатель — видеть
   «отозвано», а не тихо работать с копией. Копия остаётся (законный интерес
   получателя на записи о собственном процессе), но исключается из новой обработки
   (§5: `CandidateProfile.consentRevokedAt`).
4. **Оффер-конструктор (А-1) не подписывает и не отправляет оффер.** Черновик из
   согласованных позиций; отправка — гейтом `reviewedAt`. Юридическую силу придаёт
   работодатель вне продукта.
5. **Текст вакансии — регулируемый текст.** (а) Директива ЕС 2023/970 о прозрачности
   оплаты — начальный уровень или диапазон оплаты в объявлении или до собеседования,
   запрет спрашивать о прошлой зарплате; срок транспозиции — 7 июня 2026, детали — по
   странам; (б) Украина, ст. 24¹ Закона «Про рекламу» — запрет указывать в объявлениях
   возраст, пол, расу, цвет кожи, убеждения, членство в профсоюзах, происхождение,
   имущественное положение, место жительства, язык (кроме установленных законом
   случаев). Проверка текста (А-14) — флаг с цитатой; **ссылка на норму показывается в
   интерфейсе только при `LEGAL_REFERENCES_CONFIRMED=true`** (§13.5), до этого —
   нейтральная формулировка без номера статьи. Не юридическое заключение, не
   блокировка публикации.
6. **Приток вакансий (К-11…К-16, К-20, К-29) не делает продукт джоб-бордом.** Продукт
   не хранит и не индексирует вакансии вне проекта пользователя, не обходит сайты по
   своей инициативе, не выдаёт «ленту» — обрабатывает принесённое (ссылка, страница
   результатов, письмо-рассылка, пересланное сообщение) тем же `fetchUrlText`
   (`common/safe-url-fetch.ts`), что в job-search, с потолками частоты. ToS площадок и
   `robots.txt` — на стороне пользователя как инициатора; продукт не маскирует клиента
   и не обходит защиту от автоматизации.
7. **Справки о компании — открытые данные о юрлице, не разведка о людях.**
   Государственные реестры Украины — открытые данные (закон «Про доступ до публічної
   інформації», постановление КМУ № 835); сведения о юрлице — не персональные данные,
   сведения о руководителе/бенефициарах — персональные, хранятся ровно в объёме
   открытой части реестра, без обогащения. `PERSON_RESEARCH` здесь **не** применяется:
   продукт не исследует людей. Отзывы сотрудников — только ссылками, без цитат и
   пересказа (§5: у фактов категории `REVIEWS` `quote` пуст). Реестры других
   юрисдикций — §13.4.
8. **«Негласно» = отсутствие любого обращения к компании.** Продукт не пишет, не
   звонит, не загружает сайт компании по своей инициативе; проверка представителя
   (§3.9) сравнивает домены и читает реестр, а не сайт. Единственное исключение —
   страница, которую пользователь **сам** дал ссылкой (`fetchUrlText`, как любую
   другую). Это не тайное наблюдение и не обход защиты сайтов.
9. **Работодатель — компания; представитель — не объект исследования.** На другом
   конце всегда стоит компания; рекрутер, HR, нанимающий менеджер — её представители.
   О представителе фиксируется ровно то, что он заявил (имя, роль, как связался), и
   проверяется одно — **представляет ли он эту компанию**: совпадает ли домен его
   контакта с доменом компании из досье, значится ли он в открытой части реестра как
   руководитель/подписант (если утверждает это). Ответ — «подтверждено открытым
   источником / не подтверждается открытыми источниками / со слов», без третьего.
   Что не делается никогда: поиск представителя в соцсетях, по фото, телефону; «пробив»
   физлица; сопоставление «где он ещё работает». Если пользователю нужно проверить
   человека — это отдельный контур `PERSON_RESEARCH` со своим согласием, и он не
   смешивается с досье компании.
10. **Роли контролёра/процессора при передаче между проектами** (работодатель ↔
    агентство, Р-15/Р-4) и **уведомление кандидата от имени компании как deployer**
    (Р-12) — проходят юридическую оценку до запуска соответствующих связок (§17).

---

## 4. Архитектурные решения

### 4.1 `TermsSheet` — одна таблица на три роли, три вида листа

Первый импульс — «третий близнец» (`JobVacancyCvVariant` соискателю, `OfferDraft`
агентству). Против — зазор §1.2: близнецы уже трижды написаны порознь. Против общей
таблицы — опыт семейного права v2 §3.2, где общий enum не сошёлся. Здесь набор полей
пункта и позиции сходится с точностью до категории (§1: enum / строка / нет) — значит
одна таблица с `side`, а `category` хранится строкой, словари остаются доменными.

Три вида листа, каждый с **ровно одной опорой**:

| `kind` | Чей | Опора (одна из трёх, остальные `null`) | Сколько на опору |
| --- | --- | --- | --- |
| `VACANCY` | агентство, работодатель | `configId` → `InterviewPoolConfig` (проект = вакансия; конфиг создаётся пустым вместе с проектом) | один за всё время |
| `INTERVIEW` | агентство, работодатель | `pipelineStatusId` → `CandidatePipelineStatus` | один за всё время |
| `VACANCY_RESPONSE` | соискатель | `vacancyId` → `JobVacancy` | один за всё время |

`VACANCY`-лист — то, чего не хватало прежним ревизиям: пункты компании из брифа,
конфига и анкеты живут **один раз**, на уровне вакансии; `INTERVIEW`-лист каждого
кандидата **наследует** их (`TermsClause.sourceClauseId` → пункт `VACANCY`-листа), и
позиции по кандидату пишутся у него. Текст вакансии (А-11), инфляция требований (А-13),
вопросы читателя (А-16), трассировка к брифу (А-22) — работают с `VACANCY`-листом, а не
с листом «какого-то кандидата». «Один за всё время» — буквально: `@unique` на опоре,
закрытый лист возобновляют (`IN_NEGOTIATION`), новый на ту же опору не открывают
(409). Prisma не выражает «ровно одно из трёх» — инвариант держит сервис (400) и
конвенционный тест.

`QuestionnaireItem` и `JobSearchCriterion` **остаются** источниками пунктов. Миграции
данных нет: лист строится по запросу — **и** технически при первом `regenerate()`
релевантности (агентству не нужно нажимать кнопку, чтобы `criteriaBreakdown` стал
проекцией; см. §6.2).

### 4.2 Требование или условие — правило назначения `kind`

Пункт — либо **требование** (`REQUIREMENT`: «что я требую от другой стороны»; к нему
применимо покрытие другой стороной), либо **условие** (`CONDITION`: «что я
предлагаю/заявляю»; к нему применима позиция стороны). Правило назначения при
создании пункта, без исключений:

- импортированный `JobSearchCriterion` → `CANDIDATE / REQUIREMENT` (соискатель требует
  от работодателя зарплату/формат/локацию — покрывает текст вакансии; это и есть
  сегодняшний `matchBreakdown`, поэтому проекция сохраняется);
- импортированный `QuestionnaireItem` и требования из брифа/конфига → `EMPLOYER /
  REQUIREMENT` (компания требует опыт — покрывает кандидат);
- условия из текста вакансии, брифа, оффера («удалёнка», «зарплата до Z»,
  «испытательный срок 3 мес.») → `EMPLOYER / CONDITION`;
- условия из слов кандидата/соискателя («хочу удалёнку», «не раньше октября») →
  `CANDIDATE / CONDITION`.

`DecisionObjective.nonNegotiables/negotiables` предзаполняют `isRequired` **только** у
пунктов, добавленных вручную или из слов; импортированный критерий сохраняет свой
`isRequired` (приёмка 1).

### 4.3 Позиция — с опорой на источник, всегда

`ClausePosition` требует `evidenceKind` + (`evidenceRef` или `evidenceQuote`):
`TRANSCRIPT_SEGMENT` (интервью, онбординг, **импортированная переписка** — она тоже
`Conversation` + `TranscriptSegment`, различие в `Conversation.sourceType`),
`VACANCY_TEXT`, `OFFER_TEXT`, `CLIENT_BRIEF`, `PUBLIC_SOURCE` (факт досье),
`OWN_DOCUMENT` (абзац импортированного резюме), `INTERVIEWER_DEBRIEF` (слова
интервьюера — мнение, маркируется), `USER_STATED` (ввёл сам; обязателен `quote`).
AI **предлагает** позиции (`confirmedAt = null`), человек подтверждает или отклоняет
(`rejectedAt` — след остаётся для explainability и bias-аудита, А-9). Пункты из
неструктурированного текста — тоже черновики: `TermsClause.confirmedAt/rejectedAt`.

### 4.4 Редакции вместо снимков — цепочка на (пункт, сторона)

`ClausePosition` append-only; `supersedesId` ссылается на предыдущую **подтверждённую**
позицию **той же стороны** по тому же пункту. По одному условию пишут обе стороны
(`offered` работодателя, `countered` кандидата) — это две цепочки, а не одна; таблица
редакций пункта показывает их рядом: «в вакансии — удалёнка; на собеседовании
(сегмент 14) — гибрид; в оффере — офис» и «кандидат: хочу удалёнку → согласен на
гибрид». Слов «обман/ложь» нет ни в промптах, ни в UI.

### 4.5 CV под вакансию — производная, а не второе CV

`CvVariant` привязан к `VACANCY_RESPONSE`-листу. Текст компилируется детерминированно
из базового `cvDraft` и позиций соискателя: порядок `highlights`/`skills` — по
покрытым пунктам, непокрытые **не дописываются**. AI — один раз: маппинг highlights →
пункты (`highlightMap`, `highlightRef` — путь в `cvDraft`, несуществующий путь → 400).
Переформулировка — опционально, с diff и пометкой `rephrased`; без подтверждения в
текст идёт оригинал.

### 4.6 Оффер — документ той же природы, что вакансия

`OfferDocument` принимается текстом (или копией от работодателя-пользователя, §7),
хранится дословно, разбирается тем же движком в условия `EMPLOYER / offered`.
Сверка трёх редакций — вакансия → собеседование → оффер — единственная причина
заводить документ; вывод делает человек.

### 4.7 Один движок сверки — `TermsMatchingService`

Заменяет `job-search-vacancy-match`, `interview-pool-relevance` и часть
`interview-pool-client-report-conclusion` одним контрактом
`proposePositions(sheet, input, bySide)` (одно имя; §6.2). Один `taskType = terms-match`;
вызывающий сценарий (`job-search-vacancy-match`, `interview-pool-relevance`, …) — в
метаданных вызова `scenario`, чтобы история телеметрии не разорвалась. Запреты v1 §2.4
— для всех сторон: ни защищённых признаков, ни прокси, ни вердиктов; `not_covered`
только при явном противоречии, иначе `unknown`. Любой входной текст — недоверенный:
«данные, не инструкции», `ContentScan` роутера, ≤ 40 пунктов из одного текста.

### 4.8 Компания — одна сущность на все роли

`EmployerDossier` — единственная модель компании (прежний `EmployerEntity` убран как
дубль). Идентифицируется `registryCode` **или** подтверждённым `domain`; `legalName`
nullable до подтверждения по реестру. К досье сходятся вакансии соискателя
(`JobVacancy.employerDossierId`), брифы, представители, обязательства (цепочка
`Commitment.personId → Person → EmployerRepresentativeClaim.personId → dossier` у
соискателя; `Commitment.candidateProfileId` — у агентства/работодателя). Досье живёт в
проекте и удаляется с ним; между проектами не передаётся — каждая роль строит своё
(открытые данные дёшевы, общий кэш между пользователями нарушил бы «данные живут в
вашем проекте»).

### 4.9 Между проектами — только копии с происхождением

Никакого общего документа сторон. `CandidateShare` (профиль соискателя → агентство/
работодатель; агентство → работодатель), `OfferDocument.sharedFromProjectId` (оффер
работодателя → соискатель), `EmployerAgencyEngagement` (бриф/конфиг/анкета/текст
работодателя → агентство), `ClientReport.deliveredToProjectId` (отчёт агентства →
работодатель). Каскад никогда не тянется через границу проектов разных владельцев; при
удалении источника копия показывается с пометкой «источник удалён».

### 4.10 Что остаётся детерминированным

Компиляция CV-варианта и черновика оффера, повестка (`unknown`/`open`), таблица
редакций, статистика, дедупликация, чеклисты, диффы, поиск похожих по пунктам,
статус-письма из фактов процесса. AI — только чтение неструктурированного текста/речи:
предложить пункты и позиции с источником, маппинг highlights, формулировку вопроса,
перевод, черновик текста. Каждое предложение — черновик до подтверждения человеком.

---

## 5. Схема — единое актуальное состояние (эскиз Prisma; имена — предмет ревью)

Всё в одном месте; ничего не дописано комментариями «аддитивно» в других разделах.
Изменения существующих моделей — в §5.4, с пометкой, какие миграции **не** аддитивны.

### 5.1 Лист условий

```prisma
enum TermsSide      { EMPLOYER  CANDIDATE }
enum TermsSheetKind { VACANCY  INTERVIEW  VACANCY_RESPONSE }
enum TermsSheetStatus { DRAFT  IN_NEGOTIATION  AGREED  DECLINED  WITHDRAWN }
enum TermsClauseKind  { REQUIREMENT  CONDITION }
enum ClauseCoverage   { covered  partial  not_covered  unknown }
enum ClauseStance     { unknown  offered  accepted  countered  declined  open }
enum EvidenceKind {
  TRANSCRIPT_SEGMENT  VACANCY_TEXT  OFFER_TEXT  CLIENT_BRIEF
  PUBLIC_SOURCE  OWN_DOCUMENT  INTERVIEWER_DEBRIEF  USER_STATED
}

model TermsSheet {
  id               String @id @default(cuid())
  projectId        String
  project          Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  kind             TermsSheetKind
  status           TermsSheetStatus @default(DRAFT)
  // Ровно одна опора по kind (§4.1); XOR держит сервис + конвенционный тест.
  configId         String? @unique   // VACANCY: InterviewPoolConfig
  pipelineStatusId String? @unique   // INTERVIEW: CandidatePipelineStatus
  vacancyId        String? @unique   // VACANCY_RESPONSE: JobVacancy
  title            String            // «Backend, ТОВ Х» — человеку
  clauses          TermsClause[]
  offers           OfferDocument[]
  cvVariants       CvVariant[]
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  @@index([projectId, kind])
}

model TermsClause {
  id             String @id @default(cuid())
  sheetId        String
  sheet          TermsSheet @relation(fields: [sheetId], references: [id], onDelete: Cascade)
  side           TermsSide
  kind           TermsClauseKind     // §4.2
  text           String
  category       String?             // словарь доменный
  isRequired     Boolean @default(false)
  orderIndex     Int
  // Происхождение пункта (одно из):
  sourceCriterionId         String?  // JobSearchCriterion
  sourceQuestionnaireItemId String?  // QuestionnaireItem
  sourceClauseId            String?  // INTERVIEW наследует пункт VACANCY-листа
  sourceEvidence            EvidenceKind?
  sourceRef                 String?  // id сегмента / вакансии / оффера / брифа
  sourceQuote               String?  // цитата источника, ≤ 500 (А-22: пункт → фраза брифа)
  // Пункт из неструктурированного текста — черновик до подтверждения (§4.3).
  confirmedAt    DateTime?
  rejectedAt     DateTime?
  // Пара «одно условие с двух сторон»; предлагает движок, подтверждает человек (§6.1).
  counterpartClauseId String?
  counterpartConfirmedAt DateTime?
  positions      ClausePosition[]
  @@index([sheetId, orderIndex])
  @@index([sourceClauseId])
  @@index([counterpartClauseId])
}

model ClausePosition {
  id            String @id @default(cuid())
  clauseId      String
  clause        TermsClause @relation(fields: [clauseId], references: [id], onDelete: Cascade)
  bySide        TermsSide
  coverage      ClauseCoverage?     // только clause.kind = REQUIREMENT
  stance        ClauseStance?       // только clause.kind = CONDITION (ровно одно заполнено)
  note          String?             // 1–2 нейтральных предложения
  evidenceKind  EvidenceKind        // опора обязательна (§4.3)
  evidenceRef   String?
  evidenceQuote String?             // ≤ 500
  proposedByInferenceId String?
  confirmedAt   DateTime?           // null = черновик
  rejectedAt    DateTime?
  supersedesId  String?             // предыдущая ПОДТВЕРЖДЁННАЯ позиция той же bySide по этому пункту (§4.4)
  createdAt     DateTime @default(now())
  @@index([clauseId, bySide, createdAt])
}

model OfferDocument {
  id                  String @id @default(cuid())
  sheetId             String
  sheet               TermsSheet @relation(fields: [sheetId], references: [id], onDelete: Cascade)
  rawText             String
  source              String?             // «письмо от 12.09», URL, имя файла
  parsedAt            DateTime?
  reviewedAt          DateTime?           // у работодателя: ревью перед отправкой (Р-3)
  // Копия у соискателя от работодателя-пользователя (§7): происхождение и судьба.
  sharedFromProjectId String?
  sharedAt            DateTime?
  withdrawnAt         DateTime?           // работодатель отозвал/заменил — копия помечается, не удаляется
  createdAt           DateTime @default(now())
  @@index([sheetId])
}

model CvVariant {
  id           String @id @default(cuid())
  sheetId      String
  sheet        TermsSheet @relation(fields: [sheetId], references: [id], onDelete: Cascade)
  lang         String @default("ru")   // К-28: языковой вариант — тоже CvVariant
  highlightMap Json                    // [{highlightRef, clauseId, rephrased?, rephraseConfirmed?}]
  cvText       String
  compiledAt   DateTime @default(now())
  reviewedAt   DateTime?
  @@index([sheetId])
}
```

### 5.2 Текст вакансии, бриф, приток

```prisma
model VacancyPosting {
  id        String @id @default(cuid())
  projectId String                 // INTERVIEW_POOL или EMPLOYER_HIRING
  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  revisions VacancyPostingRevision[]
  variants  VacancyPostingVariant[]
  reviewShares PostingReviewShare[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([projectId])
}

// Редакция — история правок ИСТОЧНИКА текста.
model VacancyPostingRevision {
  id         String @id @default(cuid())
  postingId  String
  posting    VacancyPosting @relation(fields: [postingId], references: [id], onDelete: Cascade)
  text       String
  checks     Json?       // только не-compliance: { salaryDisclosed, clauseLinks[], readability[] } — без числа-«качества»
  reviewedAt DateTime?   // утверждена к публикации
  createdAt  DateTime @default(now())
  @@index([postingId, createdAt])
}

// Вариант — детерминированный срез редакции под площадку и язык (две оси, §0).
model VacancyPostingVariant {
  id                    String @id @default(cuid())
  postingId             String
  posting               VacancyPosting @relation(fields: [postingId], references: [id], onDelete: Cascade)
  derivedFromRevisionId String
  channel               String        // 'full' | 'short' | 'telegram' | 'career_page' — словарь в сервисе
  lang                  String        // 'uk' | 'ru' | 'en'
  text                  String
  backCheck             Json?         // А-18: пункты перевода против оригинала — потеряно/добавлено
  reviewedAt            DateTime?
  createdAt             DateTime @default(now())
  @@unique([postingId, derivedFromRevisionId, channel, lang])
  @@index([postingId])
}

// А-30 — согласование текста с заказчиком вне продукта, по токену.
model PostingReviewShare {
  id         String @id @default(cuid())
  postingId  String
  posting    VacancyPosting @relation(fields: [postingId], references: [id], onDelete: Cascade)
  revisionId String
  token      String @unique
  expiresAt  DateTime
  comments   Json?      // [{at, text}] — без аккаунта и имени
  createdAt  DateTime @default(now())
  @@index([postingId])
}

enum ClientBriefOrigin { EXTERNAL  INTERNAL  FROM_EMPLOYER_PROJECT }
model ClientBrief {
  id              String @id @default(cuid())
  projectId       String
  project         Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  rawText         String
  source          String?           // «письмо от …», «созвон 12.09», «со слов, голосом»
  origin          ClientBriefOrigin @default(EXTERNAL)
  sourceProjectId String?           // FROM_EMPLOYER_PROJECT: проект работодателя (без FK — граница проектов)
  receivedAt      DateTime @default(now())
  @@index([projectId])
}

// К-11/К-12/К-20/К-29 — «кандидат в базу»: заголовок и ссылка БЕЗ содержимого.
enum VacancyIntakeSource { MANUAL_URL  SEARCH_PAGE  EMAIL_ALERT  TELEGRAM_FORWARD  PASTED_TEXT  EMPLOYER_SHARE }
model VacancyCandidate {
  id           String @id @default(cuid())
  configId     String
  config       JobSearchConfig @relation(fields: [configId], references: [id], onDelete: Cascade)
  title        String
  company      String?
  url          String?
  intakeSource VacancyIntakeSource
  batchId      String?
  fetchedVacancyId String? @unique  // после загрузки → JobVacancy
  createdAt    DateTime @default(now())
  @@index([configId, createdAt])
}
```

### 5.3 Компания, представитель, передачи между проектами

```prisma
enum EmployerFactCategory { REGISTRY  COURT  TAX  SANCTIONS  REVIEWS  DOMAIN  OTHER }
model EmployerDossier {
  id           String @id @default(cuid())
  projectId    String                     // проект любой роли; у работодателя — на себя
  project      Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  legalName    String?                    // nullable до подтверждения реестром (§4.8)
  registryCode String?                    // ЄДРПОУ / РНОКПП ФОП
  domain       String?
  jurisdiction String @default("UA")      // §13.4
  confirmedAt  DateTime?                  // человек подтвердил идентификацию
  facts        EmployerDossierFact[]
  representatives EmployerRepresentativeClaim[]
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  @@unique([projectId, registryCode])
  // Postgres считает NULL различными: до registryCode единственность по (projectId, domain)
  // держит сервис (409); при появлении кода дубли по домену предлагаются к слиянию.
  @@index([projectId])
}
model EmployerDossierFact {
  id        String @id @default(cuid())
  dossierId String
  dossier   EmployerDossier @relation(fields: [dossierId], references: [id], onDelete: Cascade)
  category  EmployerFactCategory
  quote     String?    // дословно из открытого реестра, ≤ 1000; для REVIEWS — ВСЕГДА null (§3.7)
  sourceUrl String     // хост из EMPLOYER_REGISTRY_HOSTS или ссылка пользователя
  fetchedAt DateTime
  @@index([dossierId, category])
}
// Представитель — НЕ объект исследования (§3.9). Не Person: Person однопользовательская,
// а команда работодателя/агентства должна видеть заявление. Соискатель МОЖЕТ связать
// заявление со своим Person (для Commitment, К-3).
enum RepresentationCheck { CONFIRMED_PUBLIC  NOT_CONFIRMED  AS_STATED }
model EmployerRepresentativeClaim {
  id             String @id @default(cuid())
  dossierId      String
  dossier        EmployerDossier @relation(fields: [dossierId], references: [id], onDelete: Cascade)
  displayName    String
  claimedRole    String?
  contactDomain  String?
  personId       String? @unique          // job-search: Person проекта соискателя
  person         Person? @relation(fields: [personId], references: [id], onDelete: SetNull)
  check          RepresentationCheck @default(AS_STATED)
  checkSourceUrl String?                  // ТОЛЬКО хост реестра; сайт компании не загружается (§3.8)
  checkedAt      DateTime?
  @@index([dossierId])
}

enum RecruitingTeamType { AGENCY  EMPLOYER }
enum EngagementStatus   { PENDING  ACTIVE  REVOKED  CLOSED }
// Р-15 / Р-4: заказ агентству из проекта работодателя.
model EmployerAgencyEngagement {
  id                String @id @default(cuid())
  employerProjectId String
  employerProject   Project @relation(fields: [employerProjectId], references: [id], onDelete: Cascade)
  agencyProjectId   String?     // INTERVIEW_POOL: создаётся при accept (или передаётся существующий); без FK
  agencyTeamId      String?
  token             String @unique
  sharedItems       String[]    // 'brief' | 'config' | 'questionnaire' | 'posting' — ровно эти четыре
  status            EngagementStatus @default(PENDING)
  expiresAt         DateTime
  acceptedAt        DateTime?
  revokedAt         DateTime?
  createdAt         DateTime @default(now())
  @@index([employerProjectId])
  @@index([agencyProjectId])
}

enum CandidateConsentSource { RECRUITER_CONFIRMED  CANDIDATE_SELF }
```

### 5.4 Изменения существующих моделей

| Модель | Изменение | Миграция |
| --- | --- | --- |
| `ProjectMode` | `+ EMPLOYER_HIRING` | `ALTER TYPE … ADD VALUE` отдельным вызовом до выката |
| `RecruitingTeam` | `+ teamType RecruitingTeamType @default(AGENCY)` | аддитивная |
| `InterviewPoolConfig` | создаётся **пустым вместе с проектом** (сегодня — после онбординга); поля без изменений | сервис, не схема |
| `ComplianceFlag` | `+ postingRevisionId String? @index`, `+ clientBriefId String? @index`; `configId` остаётся NOT NULL (конфиг всегда есть) | аддитивная |
| `CandidateProfile` | `+ consentRevokedAt DateTime?`, `+ sharedFromProjectId String?` (копия от соискателя/агентства), `+ consentTextVersion String?` | аддитивная |
| `CandidateShare` | `sourceCandidateId` → **nullable**; `+ sourceCvVariantId String?` (самошеринг соискателя), `+ consentSource CandidateConsentSource @default(RECRUITER_CONFIRMED)`, `+ consentTextVersion String`, `+ acceptedIntoMode ProjectMode?`, `+ revokedAt DateTime?` | **не аддитивна**: `ALTER COLUMN "sourceCandidateId" DROP NOT NULL` |
| `ClientReport` | `+ deliveredToProjectId String?` | аддитивная |
| `Commitment` | `personId` → **nullable**; `+ candidateProfileId String?`; ровно одно из двух — сервис | **не аддитивна**: `DROP NOT NULL` |
| `JobVacancy` | `sourceUrl`, `siteHost` → **nullable** (PASTED_TEXT, TELEGRAM_FORWARD, EMPLOYER_SHARE); `+ employerDossierId String? @index`, `+ intakeSource VacancyIntakeSource @default(MANUAL_URL)`, `+ intakeBatchId`, `+ contentHash`, `+ duplicateOfId String?` (К-15: лист открывается на главную вакансию группы), `+ watchEnabled Boolean @default(false)`, `+ lastRefetchedAt`, `+ previousRawText`, `+ responseStatus`/`responseStatusAt` (К-29) | **не аддитивна**: два `DROP NOT NULL` |
| `JobSearchConfig` | `+ cvDraftEvidence Json?` — `[{path, quote, sourceRef}]` параллельно `cvDraft` (К-22; сам `CvDraft` не меняется, `isValidCvDraft` остаётся) | аддитивная |
| `LiveHintEvent` | `+ clauseId String?` | аддитивная |
| `Conversation` | без изменений; импортированная переписка различается `sourceType` | — |

Что **не** добавляется: балл по листу, ранг, «вероятность оффера», любой агрегат по
стороне или по человеку. Счётчики покрытий — только на экране.

Переходы `TermsSheetStatus`: все — руками человека, **кроме одного**: `DRAFT →
IN_NEGOTIATION` при первой подтверждённой позиции любой стороны (нетерминальный). Из
терминальных — «возобновить» в `IN_NEGOTIATION` с записью в редакциях. `AGREED` — про
условия, не про решение о найме; стадии кандидата по-прежнему без `ACCEPTED/REJECTED`.

---

## 6. Сервисы и API — единый контракт

### 6.1 `TermsSheetService` (`apps/api/src/terms-sheet/`, общий)

`openVacancySheet(projectId)` — `VACANCY`: пункты `EMPLOYER` из `QuestionnaireItem` и
конфига (детерминированно) и из подтверждённого брифа (черновики с `sourceQuote`).
`openForCandidate(pipelineStatusId)` — `INTERVIEW`: наследует пункты `VACANCY`-листа
(`sourceClauseId`), сторона `CANDIDATE` пуста до первого источника.
`openForVacancy(vacancyId)` — `VACANCY_RESPONSE`: пункты `EMPLOYER` из `rawText`
(черновики), `CANDIDATE` из критериев (детерминированно). Если у вакансии есть
`duplicateOfId` — 409 с указанием на главную (К-15).
`addOffer(sheetId, rawText, source)`, `confirmClauses/rejectClauses`,
`confirmPositions/rejectPositions`, `setCounterpart(clauseId, counterpartClauseId)`,
`setStatus`, `revisions(clauseId)` → две цепочки по сторонам, `agenda(sheetId)`,
`offerDraft(sheetId)` — детерминированная компиляция из `accepted` (А-1).

Доступ выбирается **по `ProjectMode` проекта**: `JOB_SEARCH` — владелец
(`job-search-access`); `INTERVIEW_POOL` и `EMPLOYER_HIRING` — команда
(`interview-pool-access`, функция `assertInterviewPoolProjectAccess` расширяется с
`mode === INTERVIEW_POOL` до двух режимов — это правка существующего кода, §15).

### 6.2 `TermsMatchingService`

`proposePositions(sheet, input: { segments } | { text, evidenceKind, evidenceRef },
bySide)` → черновики позиций; `proposeClauses(sheet, text, side, evidenceKind,
evidenceRef)` → черновики пунктов с `sourceQuote`; `proposeCounterparts(sheet)`.
`taskType = terms-match` / `terms-clauses-extract`, `scenario` в метаданных.
`interview-pool-relevance.regenerate()` переходит на сервис: для кандидата без листа
**сам открывает `INTERVIEW`-лист** (техническая сущность, без кнопки), пишет позиции
и **дополнительно** `criteriaBreakdown` из них; `attentionPoints`/`followUpRequestsDraft`
— как сегодня. `matchVacancy()` — так же: `matchBreakdown` становится проекцией
покрытия пунктов `CANDIDATE / REQUIREMENT` (§4.2). Спеки v1 — контракт без правок
ожиданий.

### 6.3 `CvVariantService`

`proposeHighlightMap(sheetId)`, `compile(sheetId, highlightMap)` (детерминированно),
`rephrase(variantId, refs[])` — отдельный шаг с diff, `translate(variantId, lang)` +
обратная сверка (К-28), `consistency(projectId)` (К-23), `review`.

### 6.4 Сервисы связок

Каждый — отдельный Nest-модуль, роль-независимый; роль различается доступом (§6.1).

- `VacancyPostingService` (Т): `draftFromSheet(projectId)` — из `VACANCY`-листа,
  `check(revisionId)` → `checks` + `ComplianceFlag(postingRevisionId)`,
  `traceToBrief(revisionId)` (А-22), `deriveVariants(revisionId, channels[], langs[])`,
  `translate(...)` с обратной сверкой, `publishChecklist(revisionId)`,
  `createReviewShare(postingId, revisionId)`, `review(revisionId)`.
- `ClientBriefService` (Я — приём и разбор; Б — остальное): `ingest(projectId, rawText,
  origin, source)`, `extractClauses(briefId)` → черновики пунктов `VACANCY`-листа с
  цитатами, `questions(briefId)` (А-23), `complianceScan(briefId)` (А-24),
  `diffAgainstPrevious(briefId)` (А-29).
- `EmployerDossierService` (Я — `identify`; Б — остальное): `identify(projectId,
  { legalName? , registryCode? , domain? })` — только запись и единственность, без
  сети; `refresh(dossierId)` — хосты из `EMPLOYER_REGISTRY_HOSTS[jurisdiction]` или
  ссылки пользователя, ≤ 1/сутки, ≤ 10 источников; `addUserSource(dossierId, url)`;
  `representativeCheck(claimId)` — сравнение `contactDomain` с `domain` досье +
  поиск роли в уже загруженных фактах `REGISTRY`; **сайт компании не загружается**;
  `discrepancies(dossierId, briefId | vacancyId | postingId)`;
  `shipmentChecklist(projectId)` (А-27).
- `VacancyIntakeService` (П): `fromSearchPage(configId, url | html)` →
  `VacancyCandidate[]`, `fromEmailAlert(configId, links[])` — ссылки извлекает
  **клиентский** разбор письма (как чат-импорт), `fromForwardedMessage(telegramId,
  projectId, text)` — `forward_origin` отброшен на входе, `fromPastedText(configId,
  text)`, `fetchCandidate(candidateId)` → `JobVacancy`, `dedupe(configId)`,
  `refetchDue(limit)`, `importResponses(configId, text | csv)` (К-29).
- `BatchMatchService` (П, К-14): `enqueue(configId, vacancyIds[])` — **расширение
  `enqueue()` роутера на текстовые пакеты — новая работа**, потолок
  `AI_BATCH_MATCH_PER_USER_PER_DAY`.
- `CvDialogueService` (Б): `nextQuestion(sheetId)`, `recordAnswer(sheetId, clauseId,
  text | segmentId)` → `TranscriptSegment` (`appendAnswer`) + черновик позиции,
  `importCv(projectId, file | text)` → `cvDraft` + `cvDraftEvidence` (К-22).
- `EngagementService` (1б): `invite(employerProjectId, sharedItems[], expiresAt)`,
  `accept(token, teamId, agencyProjectId?)` — без `agencyProjectId` **создаёт**
  `INTERVIEW_POOL`-проект команды и копирует `sharedItems` с `sourceProjectId`;
  `deliverReport(reportId, engagementId)`, `forwardFollowUp(engagementId,
  candidateProfileId, text)` → `CandidateFollowUpRequest` в проекте агентства (Р-4),
  `postingReview(engagementId, revisionId, text)` — комментарий работодателя к тексту
  агентства внутри продукта (Р-4; замена А-30 для этого ребра), `revoke`.
- `OfferExchangeService` (1б, Р-3): `shareToCandidate(offerId, candidateShareId |
  token)` — у соискателя, если вакансии этой компании нет, создаётся `JobVacancy`
  (`intakeSource = EMPLOYER_SHARE`, `rawText` = утверждённая редакция `VacancyPosting`)
  и `VACANCY_RESPONSE`-лист, затем копия `OfferDocument`; `withdraw(offerId)` →
  `withdrawnAt` на копии.
- `CandidateSelfShareService` (2, К-8): `create(sheetId, cvVariantId, visibleClauseIds[],
  expiresAt)` → `CandidateShare(sourceCandidateId = null, sourceCvVariantId,
  consentSource = CANDIDATE_SELF, consentTextVersion)`; `revoke(shareId)` →
  `revokedAt` у шеринга и `consentRevokedAt` у созданного профиля-копии;
  `accept(token, projectId)` — агентством или работодателем → `CandidateProfile`
  с `sharedFromProjectId`, `acceptedIntoMode`.

### 6.5 API (эскиз, единый)

```
# лист условий (все роли; доступ по ProjectMode)
POST   /terms-sheets/projects/:projectId/vacancy                → VACANCY (агентство, работодатель)
POST   /terms-sheets/from-candidate/:pipelineStatusId           → INTERVIEW
POST   /terms-sheets/from-vacancy/:vacancyId                    → VACANCY_RESPONSE (соискатель)
GET    /terms-sheets/:id                                        → пункты + текущие позиции обеих сторон
GET    /terms-sheets/:id/revisions/:clauseId                    → редакции по сторонам
POST   /terms-sheets/:id/clauses                                → пункт вручную { side, kind, text, isRequired }
POST   /terms-sheets/:id/clauses/confirm | /reject              → { clauseIds[] }
PATCH  /terms-sheets/:id/clauses/:clauseId                      → { counterpartClauseId } (подтверждение пары)
POST   /terms-sheets/:id/propose                                → { evidenceKind, evidenceRef?, text? } → черновики позиций
POST   /terms-sheets/:id/positions                              → позиция вручную (USER_STATED, quote обязателен)
POST   /terms-sheets/:id/positions/confirm | /reject            → { positionIds[] }
POST   /terms-sheets/:id/offers                                 → { rawText, source? } → OfferDocument + черновики
PATCH  /terms-sheets/:id/status                                 → { status }
GET    /terms-sheets/:id/agenda                                 → пункты unknown/open (К-5, повестка)
POST   /terms-sheets/:id/offer-draft                            → компиляция из accepted (А-1)
POST   /terms-sheets/:id/cv-variant/propose | /compile          → highlightMap → CvVariant
POST   /cv-variants/:id/review | /rephrase | /translate
GET    /terms-sheets/:id/dialogue/next                          → вопрос по пункту или null (К-21)
POST   /terms-sheets/:id/dialogue/answer                        → { clauseId, text | segmentId }

# текст вакансии (агентство, работодатель)
POST   /vacancy-postings/projects/:projectId/draft              → revision (А-11)
POST   /vacancy-postings/revisions/:id/check                    → checks + ComplianceFlag[] (А-12, А-14, А-15, А-19)
GET    /vacancy-postings/revisions/:id/trace                    → пункт → цитата брифа (А-22)
GET    /vacancy-postings/revisions/:id/reader-questions         → А-16
POST   /vacancy-postings/revisions/:id/variants                 → { channels[], langs[] } (А-17, А-18)
GET    /vacancy-postings/revisions/:id/publish-checklist        → А-20
POST   /vacancy-postings/revisions/:id/review                   → reviewedAt
POST   /vacancy-postings/:id/review-share                       → { revisionId } → токен (А-30; только INTERVIEW_POOL)
GET    /posting-review/:token                                   → публично: текст + пометки происхождения
POST   /posting-review/:token/comments                          → { text }

# бриф (агентство: внешний; работодатель: внутренний)
POST   /client-briefs/projects/:projectId                       → { rawText, source?, origin }
POST   /client-briefs/:id/extract                               → черновики пунктов VACANCY-листа (А-21)
GET    /client-briefs/:id/questions | /compliance               → А-23 | А-24
GET    /client-briefs/projects/:projectId/diff                  → А-29 (только INTERVIEW_POOL)

# компания (все роли)
POST   /employer-dossiers/projects/:projectId                   → identify { legalName?, registryCode?, domain? }
POST   /employer-dossiers/:id/refresh | /sources                → факты | { url }
POST   /employer-dossiers/:id/representatives                   → { displayName, claimedRole?, contactDomain?, personId? }
POST   /employer-dossiers/representatives/:id/check
GET    /employer-dossiers/:id/discrepancies                      → { briefId | vacancyId | postingId }
GET    /employer-dossiers/projects/:projectId/shipment-checklist → А-27 (только INTERVIEW_POOL)

# приток (соискатель)
POST   /job-search/projects/:projectId/intake/search-page       → { url? , html? } → VacancyCandidate[] (К-11)
POST   /job-search/projects/:projectId/intake/email-alert       → { links[{url,title?}] } (К-12)
POST   /job-search/projects/:projectId/intake/pasted             → { text } → JobVacancy (PASTED_TEXT)
POST   /job-search/projects/:projectId/intake/responses          → { text | csv } (К-29)
POST   /job-search/vacancy-candidates/:id/fetch                  → JobVacancy
POST   /job-search/projects/:projectId/batch-match               → { vacancyIds[] } → jobIds (К-14)
GET    /job-search/projects/:projectId/query-builder             → К-13
PATCH  /job-search/vacancies/:id/watch                           → { enabled } (К-16)
GET    /job-search/vacancies/:id/changes                          → К-16
GET    /job-search/projects/:projectId/gap-map                   → К-18
GET    /job-search/projects/:projectId/similar/:vacancyId        → К-27
POST   /job-search/vacancies/:id/scam-signals                     → К-25
POST   /job-search/projects/:projectId/cv/import                 → К-22
GET    /job-search/projects/:projectId/cv/consistency            → К-23
POST   /job-search/projects/:projectId/cover-letter/:sheetId     → К-19
POST   /internal/job-search/refetch                              → x-dispatch-secret, тик pg_cron (К-16)
POST   /internal/job-search/forwarded                            → x-dispatch-secret { telegramId, projectId, text } (К-20; проект выбирается в диалоге бота)

# передачи между проектами
POST   /job-search/terms-sheets/:id/self-share                   → { cvVariantId, visibleClauseIds[], expiresAt } → токен (К-8)
POST   /job-search/self-shares/:id/revoke                        → revokedAt (соискатель)
POST   /candidate-shares/accept                                  → { token, projectId } (агентство/работодатель)
POST   /candidate-shares/:id/revoke                              → агентство фиксирует отзыв, полученный вне продукта (А-6)
POST   /engagements/projects/:employerProjectId                  → { sharedItems[], expiresAt } → токен (Р-15)
POST   /engagements/accept                                       → { token, teamId, agencyProjectId? }
POST   /engagements/:id/follow-up | /posting-review | /revoke    → Р-4
POST   /client-reports/:id/deliver                               → { engagementId } (Р-4)
POST   /offers/:id/share-to-candidate | /withdraw                → Р-3
```

Все маршруты — за `TelegramAuthGuard` + `ProjectFrozenGuard`, кроме публичных по
токену (`/posting-review/:token`, приём шерингов) — со сроком, ограничением частоты и
принципом `previewShare` (ничего сверх явно переданного) — и внутренних за
`x-dispatch-secret`. Ошибки AI — `rethrowClientVisibleAiError`; идемпотентность —
штатная роутера. Маршруты с пометкой «только INTERVIEW_POOL» в проекте `EMPLOYER_HIRING`
отвечают 404 «не применимо к роли» (приёмка 44).

---

## 7. Три роли: треугольник и согласия

### 7.1 Почему три, а не два

Работодатель — вторая сторона договора из §2: вакансия — его оферта, оффер — его
редакция, обещания на собеседовании — его обязательства. Пока он объект, лист у него
никто не ведёт. Агентство и работодатель — разные роли с разными интересами: агентство
держит несколько заказчиков, работодатель — несколько вакансий; смешать их значит
показывать нанимающему менеджеру «отчёт заказчику» о нём самом. Решение: **общая
механика, три поддомена-роли**. Поддомен — это `ProjectMode`, манифест TMA, доступ и
экраны поверх общего слоя.

| | Соискатель | Агентство | Работодатель |
| --- | --- | --- | --- |
| `ProjectMode` | `JOB_SEARCH` | `INTERVIEW_POOL` | `EMPLOYER_HIRING` |
| Проект | один поиск | один пул под заказчика | одна вакансия |
| Команда | нет | `RecruitingTeam` (`AGENCY`) | `RecruitingTeam` (`EMPLOYER`): HR, нанимающий менеджер, интервьюеры — роли `OWNER/MEMBER` как в v1; дифференциации видимости по стадиям **нет** (названо ограничением, как per-candidate ACL) |
| Листы | `VACANCY_RESPONSE` | `VACANCY` + `INTERVIEW` по кандидатам | то же |
| Текст вакансии | приносит | пишет по брифу заказчика | пишет по внутреннему брифу |
| Досье | на компанию-работодателя | на компанию-заказчика | на себя |
| Оффер | получает, сверяет | собирает черновик заказчику | владелец документа |
| Отчёт | — | `ClientReport` заказчику | получает как пользователь |

### 7.2 Рёбра и согласия

| Ребро / действие | Чьё согласие | Запись | Где копия | Отзыв |
| --- | --- | --- | --- | --- |
| Соискатель → агентство / работодатель: CV-вариант + отмеченные пункты (К-8) | соискателя — **акт передачи с текстом согласия v3** (§13.2), `consentTextVersion` | `CandidateShare(consentSource = CANDIDATE_SELF)` | `CandidateProfile(sharedFromProjectId)` у получателя | соискателем → `revokedAt` шеринга, `consentRevokedAt` профиля; получатель видит «отозвано», новые снимки/отчёты профиль не включают |
| Работодатель → соискатель: оффер копией (Р-3) | работодателя (действие ревью + отправки) | `OfferDocument.sharedAt` | копия в проекте соискателя | `withdrawnAt` на копии; документ у соискателя остаётся его документом |
| Работодатель → агентство: бриф, конфиг, анкета, текст (Р-15) | работодателя | `EmployerAgencyEngagement.sharedItems` | копии с `sourceProjectId` в проекте агентства | `REVOKED`: полученное остаётся, нового нет |
| Агентство → работодатель: отчёт, профили (Р-4) | кандидата на профиль (v1) + агентства на отчёт | `ClientReport.deliveredToProjectId`, `CandidateShare` | проект работодателя | кандидатом → `consentRevokedAt` |
| Агентство ↔ кандидат (v1 §6.1a) | два отдельных чекбокса (AI-ассистент; передача профиля) | `CandidateShare(RECRUITER_CONFIRMED)`, уведомление об AI | у агентства | А-6 |
| Запись собеседования, AI-обработка | как сегодня: `RECORDING`/`EPHEMERAL_SERVER`/`THIRD_PARTY_AUDIO_RECORDING`, `EXTERNAL_AI` | `ConsentRecord` | — | как сегодня |
| Досье, представитель | не требуется (открытые данные о юрлице; заявление + проверка связи) | `EmployerDossier`, `EmployerRepresentativeClaim` | проект | с проектом |

### 7.3 Что не вводится

Общий документ, который правят две или три стороны. Разные согласия, разные интересы,
продукт — не посредник в сделке. Копии с происхождением — единственный мост; каскад
через границу проектов не тянется.

### 7.4 Известные ограничения модели команды

`CandidateProfile` привязан к `RecruitingTeam`, а не к проекту: профиль, принятый
работодателем в вакансию A, технически виден команде в вакансии B (как у агентства с
несколькими заказчиками — А-10). Названо честно; проектная видимость профилей — в А-10
как общая для двух ролей работа. Модель команды v1 рассчитана на пулы, не на компанию
с сотней интервьюеров — замер после 1б.

---

## 8. UX трёх ролей

### 8.1 Соискатель (`JobSearchWorkspace`, TMA)

Вкладка «Вакансии» → у вакансии **«Лист условий»**: две колонки (их / мои), у пункта —
покрытие/позиция и источник (тап раскрывает цитату); кнопки «Собрать CV под вакансию»
(маппинг → diff → текст), «Добавить оффер» (текст → позиции `offered` → таблица
редакций), «Что уточнить» (повестка), **«Дополнить в диалоге»** (К-21), **«Компания»**
(досье К-24, признаки К-25). Вкладка **«Приток»**: страница результатов, письмо,
вставленный текст, пересланное сообщение (после К-20), кандидаты в базу с кнопкой
«загрузить», очередь пакетной сверки, карта пробелов, похожие. Никаких процентов у
листа — счётчики по категориям покрытия.

### 8.2 Агентство (`InterviewPoolWorkspace`)

Карточка пула: **«Лист вакансии»** (`VACANCY`: пункты из брифа/конфига/анкеты с
цитатами, вопросы заказчику), **«Текст вакансии»** (бриф → требования → текст →
проверки → варианты по площадке и языку → согласование по ссылке), **«Заказчик»**
(досье компании, представители, чеклист перед отправкой кандидатов). У кандидата —
**«Лист условий»** (`INTERVIEW`: наследованные пункты слева, слова кандидата справа;
после стадии — «предложить позиции из интервью» → подтверждение; дебриф голосом с
пометкой «мнение интервьюера»), **«Черновик условий»** (А-1) → `ClientReport` с гейтом
ревью. `ComplianceFlag` в лист и отчёт не попадает.

### 8.3 Работодатель (`EmployerHiringWorkspace`)

Хаб проекта-вакансии: **«Компания»** (досье на себя, представители, «что увидит
кандидат»), **«Бриф»** (внутренний бриф голосом/текстом → пункты с цитатами → вопросы
нанимающему менеджеру), **«Текст вакансии»** (экран агентства; пометка «добавлено
агентством» → «добавлено HR», слово «заказчик» не употребляется — везде «компания» /
«вакансия», представитель — «нанимающий менеджер»), **«Кандидаты»** (свои и от
агентств с пометкой источника; лист по кандидату; стадии; follow-up агентству),
**«Оффер»** (черновик из `accepted`, сверка с обещаниями Р-9, отправка копией или
текстом), **«Агентства»** (engagement: передано, статус, комментарии к тексту, отзыв),
**«Закрытие»** (Р-14). Ни столбца «итог», ни ранга — покрытие по категориям и открытые
вопросы.

### 8.4 Песочница (админка)

Шаг 3 продолжается: лист по вакансии-примеру → позиции → CV-вариант → пример оффера →
таблица редакций; текст вакансии из примера брифа → проверки → чеклист; пример брифа
работодателя. Реальные LLM-вызовы; голосовой ввод везде, где текст.

### 8.5 Лендинг и вход

`/jobs` — третья аудитория «Нанимаю сам» (`employer_landing` → `audience = employer`,
`AUDIENCE_BY_SOURCE`/`parseStartPayload`); квиз — `landingContextHint` для
`EMPLOYER_HIRING`; манифест TMA — **восьмой** домен `employer-hiring` («Найм в
компанию»); агентство на лендинге и в TMA — «Подбор персонала». Честная граница для
работодателя: **«не отбирает за вас»**.

---

## 9. Этапность и потолки

### 9.1 Порядок сдачи (единый; решение §13.1)

**Я — ядро.** Схема §5.1 + `EmployerDossier`/`identify` + `ClientBrief`/`ingest`/
`extract` (без них 1б не собирается — ревью a11) → `TermsMatchingService` с
переводом `regenerate()`/`matchVacancy()` (v1 зелёный — критерий) → `VACANCY`/
`INTERVIEW`/`VACANCY_RESPONSE`-листы → CV-вариант → оффер как документ + `offerDraft`
(А-1) → таблица редакций → отзыв согласия → экраны соискателя и агентства → песочница.

**1б — ядро работодателя (Р-0…Р-5).** `ProjectMode` + манифест + квиз + лендинг →
`teamType` и доступ по режиму → экраны работодателя поверх Я → `EmployerAgencyEngagement`
+ доставка отчётов + follow-up → оффер копией. Не содержит ничего из этапа 2:
текст вакансии работодателя (Р-1) — это связка Т с ролью Р.

**Этап 2, выпуск А — связки Т и Б** (обслуживают две роли одним кодом; это проверка
решения §7.1): Т — А-11…А-20, А-30; Б — А-21 (остаток), А-22…А-28, К-21…К-25.

**Этап 2, выпуск Б — связка П:** К-11, К-12, К-13, К-14, К-15, К-16, К-29; К-20 —
последней (бот-приёмник, §13.6).

**Этап 2, остальное — парами по реестру §12:** каждая функция — самостоятельно
сдаваемая, с мини-ТЗ при взятии в работу; пара сдаётся вместе (одна механика, две
стороны — так дешевле и это проверка тезиса). Порядок пар — по обращениям
пользователей.

### 9.2 Потолки и стоимость

| Что | Потолок | Где |
| --- | --- | --- |
| Пунктов из одного текста | 40 | константа |
| Загруженных вакансий на проект соискателя | 50 (`MAX_VACANCIES_PER_CONFIG`) | v1 |
| `VacancyCandidate` без содержимого | 200, автоочистка > 30 дней | константа |
| Пакетная сверка | `AI_BATCH_MATCH_PER_USER_PER_DAY` = 100 вакансий/сутки | env |
| Повторная загрузка (К-16) | ≤ 1/сутки на вакансию, 20 за тик | константы + тик |
| Досье | ≤ 1 обновление/сутки на компанию, ≤ 10 источников | константы |
| Уточнений в диалоге CV на пункт | 3 | константа |
| Медиа/фон | `AI_MEDIA_CALLS_PER_USER_PER_DAY` = 20 | env (как сегодня) |
| Общий суточный | `AI_CALLS_PER_USER_PER_DAY` = 300 | env (как сегодня) |
| Токены | review-share 14 дней, engagement 30 дней, self-share и CandidateShare 72 ч | константы |

AI-вызовов на типовой сценарий: лист по вакансии — 2; CV-вариант — 1 (+1
переформулировка); оффер — 1; диалог CV — ≤ 6 на пункт; текст вакансии — 1 черновик
+ 1 проверка + 1 на язык. Остальное — детерминированно.

---

## 10. Функции этапа 2 — описания

Признак «прорывной»: меняет положение стороны в переговорах, стоит на том, чего у
других нет по построению (позиции с цитатами, редакции, «не судья»), не нарушает
границ лендинга («не детектор лжи», «не джоб-борд», «решения принимает человек», «CV
только из ваших слов», «не отбирает за вас»). Роли, связка, опора и пара каждой
функции — **только в реестре §12**; здесь — что даёт и где граница. Общие рамки не
повторяются у каждой функции: открытые источники и «негласно» — §3.7–3.9, отзыв
согласия — §3.3/§7.2, недоверенный ввод — §4.7.

### 10.1 Соискатель (К)

**К-1. Три редакции пункта: вакансия → собеседование → оффер.** Принёс оффер — по
каждому условию видно, что написано, что сказано (цитата из транскрипта) и что
предложено. Граница: таблица расхождений, не обвинение.

**К-2. Репетиция собеседования по листу.** Спарринг с архетипом интервьюера идёт по
пунктам; каждый ответ — позиция с цитатой из собственной реплики; после — какие пункты
закрыл словами, какие «плавают». Граница: учит говорить о своём опыте точнее, не
говорить то, чего не было; «правильных ответов» нет.

**К-3. Обязательства компании и «тишина».** «Вернёмся до пятницы» из транскрипта/
переписки → `Commitment` с `owner FIGURANT`, `dueDate`, напоминание; «молчат N дней» —
статус процесса. Контрагент — `Person` соискателя, связанный с
`EmployerRepresentativeClaim`; обещание принадлежит компании — человек может смениться.
Граница: факты и сроки, не совет «надавить»; напоминание себе, не письмо.

**К-4. Переговоры о зарплате по своим границам.** `NegotiationBoundaries` + условия
оффера `COMPENSATION` → `OutcomeScenario` (принять / встречное / отказаться) с
последствиями из собственных границ и скрипт в своих словах. Граница: «рыночной»
зарплаты нет (§14); `OutcomeScenario.confidence` не заполняется и не показывается —
реакция работодателя числом не предсказывается.

**К-5. «Что уточнить до отклика».** Пункты `unknown` → нейтральные вопросы для письма
или собеседования; ответ (импорт переписки) → позиция с цитатой. Граница: вопросы, не
«красные флаги».

**К-6. Live-подсказки на собеседовании — для соискателя.** Зеркало `live-hint-interview`
(`LiveHintEvent.clauseId`): «пункт X не обсуждён», «обещали Y — уточните срок». **Никакого
детектора манипуляций собеседника** — существующий детектор уловок остаётся в спарринге
и сопровождении; положение человека на собеседовании делает такую подсказку опасной
для него самого.

**К-7. Сравнение вакансий и офферов по своим требованиям.** Матрица «вакансии × мои
пункты» с покрытием и цитатами, строки переставляются руками, «лучшая» не выделяется.
Единственная сортировка — по числу `covered` среди `isRequired`, прозрачная и
**отключаемая** (в отличие от `coverageScore` SUMMARY-отчёта, который считается всегда).

**К-8. Передача CV-варианта агентству или работодателю под контролем соискателя.**
Ссылка с превью Safe Share, сроком и журналом просмотров; получатель-пользователь
принимает как `CandidateProfile` с согласием, подтверждённым **соискателем**
(`CANDIDATE_SELF`); отзыв — соискателем. Первая точка встречи сторон в продукте.
Граница: только CV-вариант и пункты, отмеченные «можно показать»; транскрипты
репетиций не передаются никогда.

**К-9. Разбор тестового задания и своего ответа по пунктам.** Задание — требования
`EMPLOYER`; ответ — `USER_STATED`; покрытие с цитатой из собственного ответа — до
отправки. Граница: не решает и не пишет ответ.

**К-10. Прогноз → факт → урок.** `Prediction` перед откликом, `actualOutcome`/`lesson`
по факту, калибровка на своих данных. Граница: не «шанс получить работу».

**К-11. Импорт страницы результатов поиска.** Ссылка или HTML страницы результатов →
`VacancyCandidate[]` (заголовок, компания, ссылка) без содержимого; загрузка — по
кнопке или пакетом. Граница: одна страница за запрос, без пагинации по своей
инициативе; в потолок 50 считаются только загруженные.

**К-12. Импорт писем-рассылок площадок.** Клиентский разбор письма (как чат-импорт)
извлекает ссылки и заголовки → `VacancyCandidate[]` (`EMAIL_ALERT`). Граница: письмо
приносит пользователь; почтовый ящик продукт не читает.

**К-13. Поисковые запросы под площадки.** Из критериев и базового CV — строки поиска
по синтаксису work.ua, robota.ua, Djinni, DOU, LinkedIn: детерминированные шаблоны +
AI-синонимы (черновик). Граница: копировать руками; словарь площадок — конфигурируемый.

**К-14. Пакетная сверка принесённых вакансий.** До 50 за раз фоновой полосой роутера;
результат — таблица К-7 с фильтром «все обязательные покрыты / есть неизвестные / есть
непокрытые». Граница: фильтр по **своим** требованиям, не рекомендация.

**К-15. Дедупликация.** `contentHash` по нормализованному тексту + заголовок/компания →
группа дублей с `duplicateOfId` на главную; лист один — на главную. Граница:
детерминированно; ложные дубли разводятся руками.

**К-16. Изменения вакансии со временем.** Повторная загрузка по кнопке или по
расписанию, включённому пользователем для конкретной вакансии (`watchEnabled`) → диф:
«исчез диапазон оплаты», «снята» (404 источника — изменение, не ошибка). Граница: не
мониторинг площадок; выключается одним переключателем.

**К-17. Критерии из собственных слов.** Транскрипты онбординга и репетиций → невысказанные
требования («не хотите ночных смен — добавить?») с цитатой → `JobSearchCriterion`.
Граница: только из его слов, без «типичных критериев для роли».

**К-18. Карта пробелов по своей базе.** Какие требования встречаются и не покрыты: «в
12 из ваших 23 вакансий просят Kubernetes». Граница: это ваши 23 вакансии, не рынок;
показывает, что просят, не советует, что учить.

**К-19. Черновик отклика из листа.** Письмо только из `covered`/`partial` с цитатами из
CV; `not_covered` — честно названы или явно пропущены человеком. Граница: отправляет
человек; продукт не откликается за него.

**К-20. Пересланное в бота сообщение — вакансия.** Пересылка боту → `JobVacancy`
(`TELEGRAM_FORWARD`, `rawText` = текст, `sourceUrl` при наличии); `forward_origin`
отбрасывается на входе. Требует приёмника сообщений у бота с выбором проекта в
диалоге — отдельная работа (§13.6); до неё тот же результат даёт вставка текста
(`PASTED_TEXT`). Граница: только пересланное самим пользователем.

**К-21. Подгонка резюме к вакансии в диалоге.** По пунктам `partial`/`not_covered`/
`unknown` — вопрос голосом или текстом; ответ → `TranscriptSegment` (`appendAnswer`) →
позиция → CV-вариант пересобирается. Ответ «нет» — честный `not_covered`; один вопрос о
смежном опыте, и только как вопрос; ≤ 3 уточнений на пункт. В промпте дословно: «не
предлагай формулировок, описывающих опыт, которого пользователь не подтвердил».

**К-22. Импорт существующего резюме как базы.** PDF/DOCX/текст → `cvDraft` +
`cvDraftEvidence` (каждый элемент → абзац документа, `OWN_DOCUMENT`); слияние с
сказанным голосом — по подтверждению. Граница: даты не «достраиваются», должности не
«нормализуются» без подтверждения.

**К-23. Согласованность между вариантами CV.** Один факт в вариантах A и B
сформулирован по-разному → флаг с двумя цитатами. Защита от собственных нестыковок,
не детектор лжи: продукт спрашивает, какая версия верна, — не решает.

**К-24. Досье на компанию-работодателя перед откликом.** `EmployerDossier` в проекте
соискателя, связанный с вакансиями; представитель — заявление + проверка связи.
Граница: §3.7–3.9; без «рейтинга работодателя».

**К-25. Признаки мошеннического объявления.** Флаги с цитатой: просьба оплатить,
паспорт/карта до оффера, зарплата резко выше остальных вакансий той же роли **в своей
базе** (не менее 3), контакт только через мессенджер без юрлица, компания не
идентифицирована, домен представителя ≠ домен компании. Граница: признаки, не вердикт;
словарь версионируется.

**К-26. Отклик-пакет.** CV-вариант, письмо, ответы на типовые вопросы формы (мотивация,
ожидания по оплате из своих требований, доступность) — одним экраном для копирования, с
превью Safe Share. Граница: продукт не откликается за человека.

**К-27. «Похожие на ту, что понравилась».** Ориентир → детерминированно близкие по набору
пунктов в своей базе; К-13 дополняет запросы её формулировками. Граница: сходство по
своей базе, не рекомендации.

**К-28. Языковой вариант CV с обратной сверкой.** uk/en `CvVariant` (`lang`) — перевод,
затем пункты из перевода против оригинала; потеряно/добавлено — флаг. Граница: перевод
черновой; термины — на человеке.

**К-29. Импорт истории откликов.** Страница/экспорт «мои отклики» → `responseStatus`
по вакансиям (откликнулся, просмотрено, отказ) с датами, дедупликация с К-15; «молчат N
дней» — как в К-3. Граница: только принесённое.

**К-30. Одна компания — вся история.** По `EmployerDossier`: вакансии этой компании в
базе, что говорил на прошлом собеседовании, что обещали, офферы. Граница: только
собственные данные пользователя.

### 10.2 Агентство (А) — по реестру большинство доступно и работодателю

**А-1. Оффер-конструктор из согласованных позиций.** Условия `accepted` → детерминированный
черновик (что согласовано, что открыто, что кандидат отклонил — с цитатами); отправка
заказчику — `ClientReport` с гейтом ревью. Граница: черновик, не оффер.

**А-2. Преданкета по ссылке с согласием кандидата.** Кандидат до интервью отвечает на
вопросы анкеты; ответы → позиции `CANDIDATE` с цитатами; интервью фокусируется на
`unknown`/`partial`. Два согласия v1 §6.1a — в самой форме, до ответа. **Первая
очередь — текстом** (§13.3): публичный STT-токен и запись голоса без аккаунта — вторая.
Граница: ответы не оцениваются числом и не сравниваются между кандидатами.

**А-3. Матрица покрытия «кандидаты × пункты» с раскрытием до цитаты.** Развитие
SUMMARY-отчёта: столбец «открытые вопросы» вместо итога; ручная перестановка
сохраняется. Граница: никакого столбца «итог».

**А-4.** Слита в **А-14** (обе — compliance текста вакансии; различие было в наличии
ссылки на норму, которое теперь гейтируется `LEGAL_REFERENCES_CONFIRMED`).

**А-5. Разбор тестового задания кандидата по пунктам.** Требования задания — пункты;
ответ кандидата — источник позиций с цитатами; `not_covered` только при явном
отсутствии. Граница: «отражено/не отражено», оценка решения — за экспертом.

**А-6. Отзыв согласия кандидатом и его видимость.** `consentRevokedAt` профиля —
исключение из новых снимков и отчётов; записи о собственном процессе остаются с
пометкой. Маршрут для отзыва, полученного вне продукта, — у агентства; отзыв через
самошеринг — у соискателя (К-8).

**А-7. «Кому мы обещали и молчим».** Кандидат в `AWAITING_FOLLOWUP` N дней, «ответим до
…» из транскрипта → `Commitment(candidateProfileId)` с напоминанием; сводка по пулу.
Граница: дисциплина процесса, не KPI сотрудников.

**А-8. Дебриф голосом после интервью → позиции с цитатами.** Слова интервьюера →
позиции `INTERVIEWER_DEBRIEF` (маркер «мнение», отдельно от фактов транскрипта);
защищённые признаки в дебрифе → `ComplianceFlag`, не позиция.

**А-9. Данные для bias-аудита — экспорт без защищённых признаков.** Агрегаты покрытия
по пунктам, стадиям, времени — без имён и признаков; материал для NYC LL144 / EU AI Act
(агентство и работодатель — deployer). Граница: продукт аудит не проводит.

**А-10. Несколько заказчиков внутри одного агентства / несколько вакансий у
работодателя.** Проектная видимость `CandidateProfile` (сегодня — командная, §7.4):
кандидат из проекта A не виден в проекте B без нового согласия; отчёты и черновики —
в рамках проекта. Граница: per-candidate ACL внутри проекта нет.

**А-11. Черновик текста вакансии из `VACANCY`-листа и конфига.** Структура (роль,
must/nice по `isRequired`, условия, процесс, как откликнуться) — детерминированно;
формулировки — AI-черновик. Граница: продукт не публикует.

**А-12. «Обещания против условий» конфига.** Тот же движок на собственный текст: оплата,
формат, локация в тексте против конфига — расхождение цитатой и полем. Граница: не
решает, что правильно.

**А-13. Инфляция требований ↔ анкета.** Требование `VACANCY`-листа без вопроса анкеты —
«вы это не проверяете, зачем оно в must?»; вопрос без требования — «проверяете, но не
сказали кандидату» (пары по `counterpartClauseId`/`sourceClauseId`). Граница: подсказка,
не правка.

**А-14. Compliance текста вакансии (поглотила А-4).** Флаг с цитатой: ст. 24¹ ЗУ «Про
рекламу», Директива 2023/970 (нет диапазона, запрос прошлой зарплаты), неформализуемые
прокси («молодая команда») — плюс нейтральная альтернатива формулировки. Ссылка на норму
— только при `LEGAL_REFERENCES_CONFIRMED`. Словарь норм конфигурируемый, версионируется
датой. У работодателя чеклист А-20 ставит эти пункты первыми — он рекламодатель и
субъект директивы. Граница: не юридическое заключение, не блокировка.

**А-15. Читаемость и жаргон.** Аббревиатуры, внутренние названия, длинные предложения,
непроверяемые требования («стрессоустойчив») — цитата + предложение. Граница: без
«оценки качества» числом.

**А-16. Вопросы, которые задаст кандидат.** Текст прогоняется как лист глазами читателя
без критериев: что останется `unknown` (испытательный срок, оборудование, переработки,
сроки ответа) — «ответьте заранее». Граница: вопросы, не «привлекательность» числом.

**А-17. Варианты под площадки.** Полная / короткая / Telegram / карьерная страница —
детерминированные срезы редакции по `channel`; правка источника пересобирает,
утверждает человек каждый. Граница: копирование руками.

**А-18. Многоязычные версии со сверкой пунктов.** `lang` uk/ru/en — перевод, затем
`backCheck`: пункты перевода против оригинала. Украинская версия обязательна для
публичных объявлений — флаг, не блокировка. Граница: перевод черновой.

**А-19. Прозрачность оплаты одной кнопкой.** `salaryRange` в конфиге, но не в тексте →
вставка; нет ни там, ни там → напоминание о норме и поле; проверка «не спрашиваем
прошлую зарплату» в анкете. Граница: решение публиковать — за компанией.

**А-20. Чеклист публикации и журнал редакций.** Детерминированно: compliance без
открытых флагов, оплата раскрыта или явно пропущена с причиной, требования ↔ анкета,
варианты пересобраны, языки сверены; журнал — кто, когда, что. Граница: не блокирует
`reviewedAt`.

**А-21. Бриф как документ.** Письмо, переписка, транскрипт созвона, голосовая заметка
«со слов заказчика» или внутренний бриф менеджера → `ClientBrief` дословно →
черновики пунктов `VACANCY`-листа с `sourceQuote`; конфиг предзаполняется из
подтверждённых. Приём и разбор — в ядре (§9.1); остальное связки Б — здесь. Граница:
защищённые признаки из брифа → `ComplianceFlag(clientBriefId)`, не пункт.

**А-22. Трассировка «фраза → пункт → текст».** Каждое требование текста ведёт к пункту,
пункт — к цитате брифа; без цитаты — «добавлено агентством» / «добавлено HR», видно в
чеклисте и заказчику. Граница: факт происхождения, не оценка правомерности.

**А-23. Вопросы автору брифа до текста.** `unknown` и противоречия внутри брифа →
нейтральные вопросы заказчику (агентство) или нанимающему менеджеру (работодатель);
ответ — новая редакция позиции с цитатой. Граница: вопросы, не тактика; продукт не
эскалирует.

**А-24. Compliance брифа с деловой альтернативой.** Дискриминационное пожелание →
`ComplianceFlag` **плюс** требование, покрывающее деловую цель без признака
(«командировки 2 раза в месяц» вместо «без детей»), и заготовка для разговора.
Граница: продукт не пишет заказчику сам и бриф не блокирует.

**А-25. Досье на компанию-заказчика.** `refresh` по реестру, судам (трудовые споры по
фильтру пользователя), налоговому долгу, санкциям, отзывам по ссылкам пользователя →
факты с `sourceUrl`/`fetchedAt`. Граница: §3.7–3.9; никакого «индекса надёжности». У
работодателя аналог — Р-6 (досье на себя).

**А-26. Расхождения бриф ↔ досье ↔ текст.** Компания в брифе ≠ реестр по домену
представителя; «директор» ≠ реестр; «в стадии прекращения»; ФОП вместо ТОВ; КВЕД без
связи с ролью — цитатами с двух сторон. Граница: расхождение, не вывод.

**А-27. Чеклист «кому отправляем кандидатов».** Перед первым `CandidateShare`/
`ClientReport` заказчику: юрлицо активно, домен контакта = реестр/досье, не в санкциях,
досье моложе 30 дней; не закрывается без `registryCode` или подтверждённого домена.
Открытый пункт не блокирует отправку — пишется в аудит. Обязанность агентства перед
кандидатом по v1 §2.5.

**А-28. Выжимка о компании для кандидата.** Публичные факты (юрлицо, год, сфера,
ссылки) в приглашение; отзывы — только ссылками. Граница: агентство выбирает, продукт
не «продаёт» компанию.

**А-29. История брифов повторного заказчика.** Новый бриф против прошлых по тому же
`registryCode` — детерминированный диф. Граница: только свои брифы.

**А-30. Согласование текста с заказчиком вне продукта по ссылке.** `PostingReviewShare`:
заказчик без аккаунта видит текст и пометки происхождения, комментирует; редакцию
делает агентство. Для работодателя-пользователя это ребро идёт через engagement (Р-4).
Граница: заказчик не редактирует сам и не видит `ComplianceFlag`.

### 10.3 Работодатель (Р)

**Р-0. Проект-вакансия.** Создание из квиза/`/intake` — проект в состоянии «черновик»
до `identify` компании (первый экран: название / код / домен — досье на себя, чтобы
работодатель увидел то, что увидит кандидат); затем внутренний бриф голосом или
текстом (`origin = INTERNAL`) → пункты `VACANCY`-листа с цитатами → конфиг.

**Р-1. Текст вакансии из внутреннего брифа.** Связка Т целиком (роль Р): трассировка к
фразе нанимающего менеджера, пометка «добавлено HR».

**Р-2. Собеседования по анкете с позициями.** Анкета, повестка, стадии, движок по
транскрипту, live-подсказки, дебриф — общий слой; интервьюеры — члены команды.

**Р-3. Оффер как документ.** Черновик из `accepted` (А-1) → ревью нанимающим менеджером
(`reviewedAt`) → соискателю-пользователю копией (§6.4 `OfferExchangeService`) или
текстом через Safe Share. Все редакции пункта работодатель видит со своей стороны.

**Р-4. Работа с агентством внутри продукта.** Приём `ClientReport` и профилей в проект
(`deliveredToProjectId`), follow-up-вопросы по кандидату → `CandidateFollowUpRequest`
агентства через engagement, комментарии к тексту вакансии агентства — через engagement.

**Р-5. Права.** Команда `EMPLOYER`: роли `OWNER/MEMBER` как в v1; член команды видит
проект целиком. Дифференциации «интервьюер видит только свои стадии» **нет** — названо
ограничением; per-candidate ACL нет.

Что работодатель не получает по построению: ранг кандидатов, «вероятность принять
оффер», сравнение ожиданий кандидатов между собой числом, данные кандидата, которые тот
не передал сам или через агентство с согласием.

**Р-6. Досье на себя — «что видит кандидат».** Открытые источники о собственной
компании; расхождения между текстом вакансии и открытыми данными («стабильная
компания» при налоговом долге) — цитатами. Граница: продукт не советует, что «улучшить
в репутации».

**Р-7.** → **А-23** с ролью Р (вопросы нанимающему менеджеру).

**Р-8. Единый лист по кандидату через агентство и напрямую.** Один и тот же человек от
агентства и сам — одна позиция по пункту с двумя источниками (отчёт агентства,
собственное собеседование); расхождения цитатами. Граница: «что сказано где», не «кто
прав»; данные агентства не переиспользуются в другой вакансии без нового согласия
(с ограничением §7.4).

**Р-9. Оффер ↔ обещания перед отправкой.** Каждое условие оффера против позиций
`EMPLOYER` из собеседований («сказали “гибрид 2 дня”, в оффере — офис»); расхождение
показывается, отправку не блокирует, пишется в редакции и аудит.

**Р-10. Ответ каждому: письмо-статус из фактов процесса.** Кандидатам в ожидании или с
отказом — черновик из стадий и открытых пунктов, без оценок и внутренних заметок;
утверждает человек. Граница: не объясняет «почему не подошёл» через сравнение с
другими.

**Р-11.** → **А-14 + А-19** с ролью Р (в чеклисте А-20 у работодателя — первыми).

**Р-12. Уведомление кандидата об AI-ассистенте — от имени компании.** Шаблон с
реквизитами компании из досье и двумя согласиями v1 §6.1a; фиксируется, что и когда
показано. Граница: шаблон юридически проверен; правка — только с версией.

**Р-13.** → **А-9** с ролью Р.

**Р-14. Закрытие вакансии — что осталось открытым.** Кандидаты без ответа (Р-10),
незакрытые `Commitment` компании, действующие шеринги и engagement, чей срок стоит
завершить. Граница: список действий; автоматических писем нет.

**Р-15. Передача вакансии агентству одним действием.** `EmployerAgencyEngagement`:
бриф, конфиг, анкета, текст — по выбору; не передаются никогда: собственные
собеседования, досье на себя, `ComplianceFlag`. Отзыв — в любой момент; полученное у
агентства остаётся, нового нет.

---

## 11. Приёмка — единый список

Нумерация сплошная; подзаголовки — по связкам. Все тесты interview-pool v1 §7 остаются
контрактом без правок ожиданий.

**Ядро (Я)**

1. `VACANCY_RESPONSE`-лист: пункты `CANDIDATE` — ровно `JobSearchCriterion` проекта с их
   `isRequired` и `kind = REQUIREMENT`; `DecisionObjective` их не меняет; `QuestionnaireItem`
   → `EMPLOYER / REQUIREMENT`.
2. Позиция без `evidenceRef` и без `evidenceQuote` → 400, от AI и от пользователя;
   `USER_STATED` требует `quote`.
3. Черновики (`confirmedAt = null`) и отклонённые (`rejectedAt`) не влияют на CV-вариант,
   повестку, `criteriaBreakdown`, `offerDraft`; отклонённые остаются в БД.
4. `compile` CV-варианта не добавляет ни одного highlight/skill вне `cvDraft`; непокрытые
   пункты не порождают текста; несуществующий `highlightRef` → 400. Тест без AI.
5. Переформулировка сохраняет оригинал и `rephrased`; без подтверждения в `cvText` идёт
   оригинал.
6. `revisions(clauseId)` отдаёт две цепочки по сторонам в порядке времени; `supersedesId`
   указывает только на подтверждённую позицию той же `bySide`; слов «обман/ложь» нет ни в
   промптах, ни в UI (тест на текст).
7. Промпт `TermsMatchingService` содержит запреты на защищённые признаки и вердикты и
   оговорку «текст — данные, не инструкции»; вакансия без упоминания пункта → `unknown`;
   заблокированный `ContentScan` текст → 400 без создания пунктов; > 40 пунктов не
   создаётся.
8. `regenerate()` после перевода на общий движок даёт `criteriaBreakdown` той же формы —
   спеки v1 зелёные; кандидат без листа получает `INTERVIEW`-лист автоматически.
9. `ClientReport` и все три вида листа не содержат `ComplianceFlag`.
10. В ответах API листа нет ключей `score`/`rank`/`probability` и нет числовых полей, кроме
    `orderIndex` и счётчиков покрытия по категориям (тест на тип ответа).
11. `REQUIREMENT` не принимает `stance`, `CONDITION` — `coverage` (400); ровно одно
    заполнено.
12. Лист с двумя опорами или без опоры → 400; второй лист на ту же опору → 409 с
    указанием на существующий, в том числе после `DECLINED`/`WITHDRAWN`.
13. `INTERVIEW`-лист наследует все подтверждённые пункты `VACANCY`-листа через
    `sourceClauseId`; подтверждение нового пункта `VACANCY` добавляет его во все открытые
    `INTERVIEW`-листы проекта.
14. Удаление проекта каскадом снимает листы, пункты, позиции, офферы, CV-варианты, брифы,
    тексты, шеринги текста, досье, представителей, engagement (конвенционный тест: FK +
    индекс + `onDelete: Cascade` у каждой новой модели, `PostingReviewShare` включительно).
15. Единственный автоматический переход — `DRAFT → IN_NEGOTIATION`; в терминальные — только
    явным `PATCH /status`; «возобновить» пишет запись в редакциях.
16. Открытие листа на вакансию с `duplicateOfId` → 409 с id главной вакансии группы.

**Ядро работодателя (1б)**

17. Проект `EMPLOYER_HIRING` создаётся черновиком; до `identify` компании операции с
    листом, брифом и текстом → 409 «укажите компанию».
18. `teamType = EMPLOYER`: в локализационных ключах ответов нет «заказчик»;
    `assertInterviewPoolProjectAccess` принимает `INTERVIEW_POOL` и `EMPLOYER_HIRING`,
    отвергает `JOB_SEARCH` (403).
19. `ClientReport` с `deliveredToProjectId` виден работодателю в его проекте, без
    `ComplianceFlag` и внутренних заметок агентства.
20. `sharedItems` — подмножество четырёх значений (иначе 400); копируются только
    соответствующие таблицы; собеседования, досье на себя, `ComplianceFlag` работодателя —
    никогда (тест на набор таблиц-источников); `accept` без `agencyProjectId` создаёт
    `INTERVIEW_POOL`-проект команды.
21. `REVOKED` останавливает доставку отчётов, follow-up и комментарии; полученное остаётся у
    обеих сторон.
22. Оффер копией: `sharedFromProjectId`/`sharedAt` у копии; правка у работодателя копию не
    меняет; `withdraw` ставит `withdrawnAt`, копия не удаляется; при отсутствии вакансии этой
    компании у соискателя создаются `JobVacancy(EMPLOYER_SHARE)` и `VACANCY_RESPONSE`-лист.
23. Р-9: отправка оффера с расхождением против позиций собеседования проходит и пишет
    расхождение в редакции пункта и AuditLog.
24. Лендинг: `employer_landing` → `/intake` с подсказкой `EMPLOYER_HIRING`;
    `sanitizeStartPayload`/`parseStartPayload` понимают третий источник;
    `intake-scenarios-have-ui` требует манифест `employer-hiring`.
25. Удаление аккаунта одной стороны: копии у других остаются и показываются с «источник
    удалён»; нет FK между проектами разных владельцев (тест схемы).

**Передачи и согласия**

26. `consentSource = CANDIDATE_SELF` возможен только из `JOB_SEARCH`, `RECRUITER_CONFIRMED`
    — только из `INTERVIEW_POOL`/`EMPLOYER_HIRING`; `consentTextVersion` обязателен; первая
    передача по каждому ребру требует `ConsentRecord` текста согласия версии v3 (§13.2) —
    старая запись типа без версии не засчитывается.
27. `consentRevokedAt` профиля исключает его из `regenerate()`, новых отчётов и engagement-
    доставок; экран показывает «согласие отозвано»; отзыв самошеринга ставит `revokedAt`
    шеринга и `consentRevokedAt` созданного профиля.
28. Самошеринг передаёт только `cvText` варианта и пункты из `visibleClauseIds`; ни одного
    поля транскриптов и репетиций (тест на набор полей копии).

**Текст вакансии (Т)**

29. Пункты из `rawText`/брифа создаются черновиками; `checks` не содержит агрегата; чеклист
    А-20 с открытым флагом не блокирует `reviewedAt`.
30. Варианты уникальны по (редакция, `channel`, `lang`); новая редакция сбрасывает
    `reviewedAt` вариантов предыдущей.
31. Требование текста без `sourceQuote` брифа получает пометку «добавлено агентством» /
    «добавлено HR» (по `teamType`) в `trace` и в `PostingReviewShare`.
32. Без `LEGAL_REFERENCES_CONFIRMED` в ответе `check` нет ключей с номером нормы (тест на
    ключи); с флагом — есть; текст флага в обоих случаях нейтральный.
33. `ComplianceFlag` с `postingRevisionId`/`clientBriefId` виден только породившей стороне и
    не копируется ни одним engagement.

**Бриф и досье (Б)**

34. Пункт или позиция с `CLIENT_BRIEF` требует существующий бриф того же проекта и цитату,
    присутствующую в `rawText` (подстрока после нормализации пробелов).
35. `EmployerDossierFact`: `sourceUrl` — только хост из `EMPLOYER_REGISTRY_HOSTS[jurisdiction]`
    или URL, добавленный пользователем (иначе 400 «только открытые источники или ваша
    ссылка»); `REVIEWS` с непустым `quote` → 400; без `fetchedAt` → 400; в ответе досье нет
    числовых агрегатов.
36. Контур досье не инициирует запросов к домену компании: все хосты вызовов `fetchUrlText`
    — реестры или явные ссылки пользователя (тест на аргументы); `representativeCheck` не
    делает сетевых вызовов; имя представителя не встречается ни в одном URL/запросе;
    `PERSON_RESEARCH` не запрашивается.
37. Единственность досье: без `registryCode` — одно на (`projectId`, `domain`), 409; при
    установлении кода дубли по домену предлагаются к слиянию; `refresh` требует
    `registryCode` или подтверждённый `domain`, иначе 400 «укажите компанию»; попытка
    построить досье по имени физлица без компании → 400.
38. А-27: чеклист не закрывается без `registryCode`/подтверждённого домена; открытый пункт
    не блокирует `share`/`send`, но пишет пункт в AuditLog отправки.
39. К-21: промпт содержит запрет «не предлагай формулировок для неподтверждённого опыта»;
    ответ «нет» оставляет `not_covered`; каждый ответ — `TranscriptSegment` с `evidenceRef`
    в позиции; не более 3 уточнений на пункт.
40. К-22: каждый элемент `cvDraft` из документа имеет запись в `cvDraftEvidence`; элемент без
    неё → 400 при подтверждении. К-23: расхождение — две цитаты, без «верно/неверно».
41. К-25: сравнение зарплаты — только с вакансиями той же роли в проекте; при менее чем 3
    признак не выставляется; «компания не идентифицирована» ставится при отсутствии досье.

**Приток (П) и роли**

42. К-11/К-12: `VacancyCandidate` без содержимого; потолок 200 с автоочисткой > 30 дней;
    51-я **загруженная** вакансия → 400 с текстом про потолок.
43. К-16: повторная загрузка чаще суток → 429; `watchEnabled` per-вакансия; 404 источника
    фиксируется как изменение. К-20/`PASTED_TEXT`: `rawText` не содержит
    `forward_origin`/`forward_from`; `sourceUrl = null` допустим. К-19: текст отклика не
    содержит навыка вне `skills` `cvDraft` (детерминированная проверка по словарю); факты
    — промпт-тест + обязательное ревью перед копированием.
44. Функции реестра §12 с ролями «А Р» доступны в `EMPLOYER_HIRING` тем же маршрутом; А-25,
    А-27, А-29, А-30 в нём → 404 «не применимо к роли» (тест по таблице реестра).

---

## 12. Реестр функций — источник истины по ролям, связкам и парам

Роли: К — соискатель, А — агентство, Р — работодатель. Связки: Я — ядро, 1б — ядро
работодателя, Т — текст вакансии, Б — бриф и досье, П — приток, 2 — остальной этап 2.
Слитые id (А-4, Р-7, Р-11, Р-13) оставлены в таблице ради стабильности ссылок и **не
считаются**. Итог: 30 К + 29 А + 13 Р = **72 функции**; Я и Р-0…Р-5 — ядро, не функции.

| Id | Функция | Роли | Связка | Пара |
| --- | --- | --- | --- | --- |
| Я | Лист условий трёх видов, позиции с источником, CV-вариант, оффер, редакции, движок, бриф (приём), компания (identify) | К А Р | Я | — |
| Р-0…Р-5 | Проект-вакансия, права, engagement, доставка отчётов, оффер копией | Р | 1б | — |
| К-1 | Три редакции пункта | К | 2 | Р-9 |
| К-2 | Репетиция по листу | К | 2 | А-8 |
| К-3 | Обязательства компании и «тишина» | К | 2 | А-7, Р-10 |
| К-4 | Зарплата по своим границам | К | 2 | — |
| К-5 | «Что уточнить до отклика» | К | 2 | А-23 |
| К-6 | Live-подсказки для соискателя | К | 2 | live-hint v1 |
| К-7 | Сравнение вакансий по своим требованиям | К | 2 | А-3 |
| К-8 | Самошеринг CV-варианта | К → А Р | 2 | А-6, Р-15 |
| К-9 | Тестовое задание — свой ответ | К | 2 | А-5 |
| К-10 | Прогноз → факт → урок | К | 2 | — |
| К-11 | Страница результатов поиска | К | П | — |
| К-12 | Письма-рассылки | К | П | — |
| К-13 | Поисковые запросы под площадки | К | П | А-18 |
| К-14 | Пакетная сверка | К | П | А-20 |
| К-15 | Дедупликация | К | П | — |
| К-16 | Изменения вакансии со временем | К | П | А-12 |
| К-17 | Критерии из своих слов | К | 2 | А-13 |
| К-18 | Карта пробелов | К | 2 | — |
| К-19 | Черновик отклика | К | 2 | А-16 |
| К-20 | Пересланное в бота сообщение | К | П (последней) | — |
| К-21 | Резюме в диалоге | К | Б | А-23 |
| К-22 | Импорт резюме | К | Б | А-21 |
| К-23 | Согласованность вариантов CV | К | Б | А-22 |
| К-24 | Досье на компанию-работодателя | К | Б | А-25, Р-6 |
| К-25 | Признаки мошеннического объявления | К | Б | А-27 |
| К-26 | Отклик-пакет | К | 2 | — |
| К-27 | Похожие на понравившуюся | К | 2 | — |
| К-28 | Языковой вариант CV | К | 2 | А-18 |
| К-29 | Импорт истории откликов | К | П | — |
| К-30 | Одна компания — вся история | К | 2 | — |
| А-1 | Оффер-конструктор | А Р | Я (компиляция) / 2 (экран) | К-1 |
| А-2 | Преданкета по ссылке (текст → голос) | А Р | 2 | К-5 |
| А-3 | Матрица покрытия | А Р | 2 | К-7 |
| А-4 | → А-14 | — | — | — |
| А-5 | Тестовое задание кандидата | А Р | 2 | К-9 |
| А-6 | Отзыв согласия — видимость | А Р | 2 | К-8 |
| А-7 | «Кому обещали и молчим» | А Р | 2 | К-3 |
| А-8 | Дебриф голосом | А Р | 2 | К-2 |
| А-9 | Данные для bias-аудита | А Р | 2 | — |
| А-10 | Проектная видимость кандидатов | А Р | 2 | — |
| А-11 | Черновик текста из VACANCY-листа | А Р | Т | — |
| А-12 | Текст против конфига | А Р | Т | К-16 |
| А-13 | Инфляция требований ↔ анкета | А Р | Т | К-17 |
| А-14 | Compliance текста (+А-4) | А Р | Т | — |
| А-15 | Читаемость и жаргон | А Р | Т | — |
| А-16 | Вопросы читателя | А Р | Т | К-19 |
| А-17 | Варианты по площадкам | А Р | Т | — |
| А-18 | Языки со сверкой | А Р | Т | К-13, К-28 |
| А-19 | Прозрачность оплаты | А Р | Т | — |
| А-20 | Чеклист публикации | А Р | Т | К-14 |
| А-21 | Бриф как документ | А Р | Я (приём, разбор) / Б | К-22 |
| А-22 | Трассировка фраза → пункт → текст | А Р | Б | К-23 |
| А-23 | Вопросы автору брифа (+Р-7) | А Р | Б | К-5, К-21 |
| А-24 | Compliance брифа с альтернативой | А Р | Б | — |
| А-25 | Досье на компанию-заказчика | А | Б | К-24, Р-6 |
| А-26 | Расхождения бриф ↔ досье ↔ текст | А Р | Б | — |
| А-27 | Чеклист «кому отправляем» | А | Б | К-25 |
| А-28 | Выжимка о компании для кандидата | А Р | Б | — |
| А-29 | История брифов заказчика | А | 2 | — |
| А-30 | Согласование по ссылке вне продукта | А | Т | Р-4 (внутри продукта) |
| Р-6 | Досье на себя | Р | Б | К-24, А-25 |
| Р-7 | → А-23 | — | — | — |
| Р-8 | Единый лист через агентство и напрямую | Р | 2 | — |
| Р-9 | Оффер ↔ обещания | Р | 2 | К-1 |
| Р-10 | Письмо-статус каждому | Р | 2 | К-3, А-7 |
| Р-11 | → А-14, А-19 | — | — | — |
| Р-12 | Уведомление об AI от имени компании | Р | 2 | — |
| Р-13 | → А-9 | — | — | — |
| Р-14 | Закрытие вакансии | Р | 2 | — |
| Р-15 | Передача вакансии агентству | Р → А | 1б | К-8, А-30 |

Что объединяет реестр: ни одна функция не вводит число по человеку; ни одна не заставляет
продукт ходить куда-то по своей инициативе; всё, что требует транскрипта, наследует
согласия и удаление у провайдера без новых правил; пары — одна механика с двух сторон
одного договора, и это проверка тезиса §2 на прочность.

---

## 13. Решения по семи открытым вопросам

Каждое — решение по умолчанию с обоснованием; владелец отменяет одной строкой в §16.

1. **Порядок после ядра: Я → 1б → выпуск А (Т + Б) → выпуск Б (П) → остальное парами.**
   1б — в основном права, тексты и манифест: дёшево и открывает третью аудиторию
   лендинга. Т и Б обслуживают две роли одним кодом — это проверка решения о трёх
   поддоменах, и её стоит пройти рано. П требует бот-приёмника и потолков и приносит
   пользу одной роли. Альтернатива «П раньше 1б, если приоритет — рост базы с лендинга»
   отклонена: у П нет ничего, что удерживало бы пришедшего, кроме листа, который уже в Я.
2. **Согласие = акт передачи с текстом v3.** Текст согласия дополняется «данные могут быть
   переданы также работодателю-пользователю»; `consentTextVersion` пишется в шеринг;
   первая передача по каждому ребру требует свежую `ConsentRecord` этой версии — потому что
   продукт сегодня проверяет тип согласия, не версию (`docs/AUDIT-STT-ROUTER-LANDING-
   2026-09-02.md` §1.4), и ребро «соискатель → работодатель» — новый получатель, о
   котором старое согласие не говорило.
3. **А-2 — текстом первой очередью.** Публичная форма с двумя согласиями и текстовыми
   ответами закрывает 80 % ценности (позиции с цитатами до интервью) без анонимного
   STT-токена и записи голоса без аккаунта — самой тяжёлой части. Голос — вторым шагом,
   после юридической оценки (§17).
4. **Реестры — Украина; поле `jurisdiction`.** `EMPLOYER_REGISTRY_HOSTS` — карта
   `{ UA: [...] }`; досье с иной юрисдикцией честно показывает «реестры этой юрисдикции не
   подключены — добавьте ссылки сами» и принимает только ссылки пользователя. Списки
   ЕС/США ведёт владелец при появлении спроса; код не меняется.
5. **`LEGAL_REFERENCES_CONFIRMED`.** Номера норм (ст. 24¹, Директива 2023/970) в
   интерфейсе — только при `true`; до подтверждения юристом флаг формулируется нейтрально.
   Так конфигурационный зазор не выглядит отказом, а юридический риск не ждёт релиза.
6. **Бот-приёмник — последним в П; `PASTED_TEXT` — с первого дня.** Вставка текста даёт тот
   же `JobVacancy` без вебхука и выбора проекта в диалоге; приёмник делается, когда
   остальная связка П уже в проде и видно, сколько вакансий приходит текстом.
7. **`INTERVIEW_POOL` остаётся в коде.** Переименование режима — миграция данных и правка
   всех проверок ради красоты имени; на лендинге и в TMA — «Подбор персонала» и «Найм в
   компанию».

---

## 14. Вне объёма и риски

- **Рынок труда как данные.** Никакой «средней зарплаты», «типичных требований» — это
  кроулинг (не джоб-борд) или агрегация между пользователями (запрещено принципом «данные
  живут в вашем проекте»).
- **Общий документ сторон** — не делается (§7.3).
- **Soft skills, «культурное соответствие», тон, мимика** — нет (v1 §8, §2 этого
  документа).
- **Автоматические переходы стадий, авто-отказы, автоматические письма** — нет.
- **Юридическая проверка оффера и текста** — нет; максимум — «уточните у юриста» на
  пунктах из списка и флаг с цитатой.
- **Проверка представителя как человека** — нет (§3.9).
- **Дифференциация прав внутри команды по стадиям, per-candidate ACL, проектная видимость
  профилей** — не в ядре; последняя — А-10.
- Риск: общий движок — единая точка регрессии трёх поддоменов. Смягчение: проекции
  сохраняются, спеки v1 — контракт, перевод — вторым шагом Я.
- Риск: лист перегружает соискателя, который хотел «просто CV». Смягчение: базовое CV и
  разбор вакансии работают как сегодня; лист — кнопкой.
- Риск: `RecruitingTeam` под компанией с десятками вакансий и интервьюеров. Смягчение:
  замер после 1б; модель команды не меняется до данных.
- Не проверено текстом: удобство двухколоночного листа на телефоне (нужен макет);
  стоимость движка на длинных транскриптах (замер в песочнице).

---

## 15. Деплой, телеметрия, что трогает существующий код

- **Миграции.** Аддитивные: новые таблицы (`terms_sheets`, `terms_clauses`,
  `clause_positions`, `offer_documents`, `cv_variants`, `vacancy_postings`,
  `vacancy_posting_revisions`, `vacancy_posting_variants`, `posting_review_shares`,
  `client_briefs`, `vacancy_candidates`, `employer_dossiers`, `employer_dossier_facts`,
  `employer_representative_claims`, `employer_agency_engagements`), новые nullable-колонки
  (§5.4), новые перечисления и значения (`ProjectMode`, `EvidenceKind`, …) — `ALTER TYPE …
  ADD VALUE` отдельным вызовом до выката, код устойчив к отставанию (`enum-migration-lag`,
  прецедент `PROCESSING`). **Не аддитивные**, отдельными файлами с явным именем:
  `commitments.personId DROP NOT NULL`, `candidate_shares.sourceCandidateId DROP NOT NULL`,
  `job_vacancies.sourceUrl / siteHost DROP NOT NULL`.
- **`taskType`** (телеметрия): `terms-clauses-extract`, `terms-match` (со `scenario`),
  `cv-variant-highlight-map`, `cv-variant-rephrase`, `cv-variant-translate`,
  `cv-variant-consistency`, `vacancy-posting-draft`, `vacancy-posting-check`,
  `vacancy-posting-translate`, `client-brief-questions`, `client-brief-compliance`,
  `employer-dossier-extract`, `cv-dialogue-question`, `cv-dialogue-position`,
  `cv-import-structure`, `job-search-query-builder`, `job-search-cover-letter`,
  `job-search-criteria-suggest`, `vacancy-scam-signals`. Расширение `enqueue()` на
  текстовые пакеты — отдельная работа в роутере.
- **Конфигурация:** `EMPLOYER_REGISTRY_HOSTS` (карта по `jurisdiction`),
  `LEGAL_REFERENCES_CONFIRMED`, `AI_BATCH_MATCH_PER_USER_PER_DAY`; внутренние тики
  `/internal/job-search/refetch` и `/internal/job-search/forwarded` — за `x-dispatch-secret`.
- **Существующий код, который трогает третья роль:** `ProjectMode`; `INTAKE_SCENARIOS` и
  промпт классификатора; `landingContextHint` (`employer_landing`); `AUDIENCE_BY_SOURCE`/
  `LandingAudience`; тест `intake-scenarios-have-ui`; манифесты TMA (`employer-hiring`,
  `extras` у `jobSearch`: «лист условий», «приток», «запросы»; у `interviewPool`: «лист
  вакансии», «текст вакансии», «заказчик»); `DOMAIN_LIST` квиза; админка сценариев и
  песочница; `assertInterviewPoolProjectAccess` (два режима); тексты interview-pool по
  `teamType`; `InterviewPoolConfig` создаётся с проектом; лендинг `/jobs` (третья вкладка,
  словари трёх языков, JSON-LD); голосовой ввод во всех новых многострочных полях.

---

## 16. Журнал ревизий

| Ревизия | Что сделано | Что отменено позже |
| --- | --- | --- |
| 0 | Тезис, ядро, схема, 10 + 10 функций этапа 2 | `TermsSheetKind.OFFER`; `Commitment.counterpartyLabel`; `CvVariant.vacancyId` |
| 1 | Самоаудит (12 дефектов): `TermsClauseKind`, XOR опоры, `counterpartClauseId`, `rejectedAt`, машина статусов, недоверенный ввод, порядок этапа 2, деплой; ещё 10 + 10 (текст вакансии, приток) | `VacancyPostingRevision.variant`; compliance в `checks` |
| 2 | Самоаудит (11 дефектов): вариант/редакция разделены, `ComplianceFlag` для текста и брифа, потолки притока, тик refetch, `forward_origin`; ещё 10 + 10 (бриф, досье, диалог CV) | `EmployerEntity` (дубль досье); `IMPORTED_MESSAGE` |
| 2.1 | Работодатель — компания; представитель — заявление и одна проверка связи | представитель как `Person` для команд |
| 3 | Три поддомена; `EMPLOYER_HIRING`; Р-0…Р-15; engagement; оффер копией | три уровня прав Р-5; проект без компании |
| 3.1 | API и сервисы связок, экраны работодателя, матрица согласий, потолки, реестр 76, 7 открытых вопросов | — |
| **4** | Внешнее ревью — 80 дефектов (27 противоречий, 9 ссылок, 16 схемных, 5 нумерации, 14 несверенных утверждений о коде, 17 дыр в потоках, 8 терминологических) — закрыты консолидацией: словарь §0; один порядок этапов; `VACANCY`-лист; правило `kind` при импорте; `accepted`; цепочки на (пункт, сторона); `channel` + `lang`; одна схема с явными не-аддитивными миграциями; `VacancyCandidate`; `EmployerRepresentativeClaim` без `Person`; `REVIEWS` без цитат; проверка представителя без загрузки сайта; единый API с reject/pairing/self-share/engagement-маршрутами; одна приёмка (44); реестр как источник истины (А-4 → А-14; Р-7/Р-11/Р-13 → роли); семь решений §13 | — |

---

## 17. Юридическая оговорка

Документ описывает продуктовую и техническую архитектуру; он не является юридической
консультацией и не заменяет проверку трудового, антидискриминационного законодательства
и требований к автоматизированным инструментам найма в юрисдикциях запуска (ЕС — AI Act
Annex III с отсрочкой до 02.12.2027, Директива 2023/970; США — NYC Local Law 144;
Украина — КЗпП, ст. 24¹ Закона «Про рекламу», закон о защите персональных данных, закон
о языке). До запуска соответствующих связок юридическую оценку проходят: текст согласия
v3 и передача по рёбрам треугольника (К-8/А-6, Р-3, Р-4, Р-15 — роли контролёра/
процессора); А-2 (публичная форма, затем голос); А-9 (выгрузка данных о процессе); А-14/
А-19 (номера норм в интерфейсе — гейт `LEGAL_REFERENCES_CONFIRMED`); К-11/К-16/К-29
(загрузка страниц площадок по инициативе пользователя — их условия использования); А-25/
К-24/Р-6 (открытые реестры: объём данных о руководителях, условия использования API
открытых данных); А-30 (доступ заказчика без аккаунта к тексту с пометками); Р-12
(уведомление кандидата от имени компании как deployer) — так же, как это было сделано для
шеринга в interview-pool v1.

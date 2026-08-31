# Devil's Advocate — ТЗ: Family Law Assistant v2 (учасники, активи, статус процесу, бюджет, повістка питання)

> Компаньон-документ до `devils-advocate-family-law-tz.md` (не заміняє, розширює вже
> реалізовану базу — `FamilyLawConfig`/`FamilyLawCriterion`/`FamilyLawAdvisor`/
> `FamilyLawConsultation` лишаються без змін) та до `devils-advocate-dtp-v2-tz.md`
> (структурний паралелізм — той самий клас доповнень, знайдений тим самим методом
> перевірки реального коду, не за аналогією). Виникло з прямого запиту: перевірити, чи ті
> самі недоопрацювання, що в ДТП v2, присутні тут, і зробити прикидку компаньйон-ТЗ —
> прикидка вже затверджена в діалозі, цей документ її деталізує.

---

## 0. Перевірено перед написанням — підтверджено 6 прогалин, і 1 ревізія власного плану під час проєктування

**Перевірено прямим читанням `schema.prisma`/`family-law.service.ts`, не за аналогією з ДТП:**
`FamilyLawConsultation` не має власного поля `currency` (той самий баг, що вже виправлений у
ДТП v2); `getComparisonTable()` **навіть не намагається** сумувати `estimatedCost` (гірше за
первинний ДТП — там хоч наївна сума була); немає моделі учасника/сторони спору; немає
структурованого реєстру активів; немає статусу процесу; немає зіставлення слів між
консультаціями; **і нова прогалина, якої в ДТП не було:** `goalDescription` неможливо оновити
взагалі — жодного update-методу, підтверджено відсутністю `PATCH`/`async update` в контролері
й сервісі.

**Ревізія власного плану, знайдена під час детального проєктування (розділ 3.2 нижче), не
приховано:** у попередній відповіді запропонував "спільну модель `DecisionStatusDetermination`
з полем `domainType`" для статусу процесу — при спробі реально спроєктувати поле `source`
з'ясувалось, що воно НЕ конвергує так само чисто, як `criteriaBreakdown`. Значення для ДТП
(поліція/страхова/суд) і для сімейного права (подання до суду/медіаційна угода/неформальна
домовленість) перетинаються лише частково ("суд" є в обох, решта — ні). Форсування в один
спільний enum означало б показувати користувачу ДТП варіант "медіаційна угода" чи навпаки —
та сама помилка, що вже відхилена для `DtpBudgetLineItem.category` в попередньому аудиті.
**Виправлено:** статус процесу лишається ОКРЕМОЮ моделлю з власним enum (розділ 3.2), спільна
тільки ФОРМА решти полів і сервісна логіка, не таблиця.

**Підтверджено такою ж перевіркою, як для ДТП: `cross-consultation-check` дійсно конвергує без
форсування** — `CriterionStatement` byte-for-byte ідентичний у трьох незалежно написаних
реалізаціях (DTP/family-law/health, перевірено прямим `grep` перед цим документом). Це єдине
доповнення цього документа, що переноситься як спільний сервіс, не паралельна копія.

---

## 1. Призначення і межі

**Що це:** структуроване відстеження сторони спору (подружжя), реєстру активів під поділ,
офіційно повідомленого статусу процесу, деталізованого бюджету по категоріях і валютах,
генерація ЧЕРНЕТКИ-компіляції (не тексту самого договору — той принцип уже встановлений і не
переглядається, `devils-advocate-family-law-tz.md` §8), і версійна історія повістки питання
(`goalDescription`), щоб зміна мети процесу лишалась видимою, не втраченою.

**Чого це категорично НЕ, розширення меж §1 `devils-advocate-family-law-tz.md`:**
- **Не визначення статусу процесу системою.** `FamilyLawStatusDetermination` фіксує, що
  ОФІЦІЙНО повідомлено користувачу — ніколи не обчислюється й не пропонується AI, той самий
  структурний принцип, що `DtpFaultDetermination`.
- **Не оцінка справедливості поділу активів.** Реєстр активів фіксує факти (що є, хто володіє,
  скільки коштує за оцінкою користувача) — не радить, як їх ділити.
- **Не готовий до підпису документ.** Той самий принцип, що вже встановлений — чернетка,
  не юридично завершений текст.

---

## 2. Юридичний ландшафт

### 2.1 UPL — без змін, посилання на вже наявне дослідження

`devils-advocate-family-law-tz.md` §2.1 застосовується без змін до чернетки-компіляції цього
документа (розділ 3.6) — той самий принцип, що вже застосований у `devils-advocate-dtp-v2-tz.md`
§2.1 для його протоколу.

### 2.2 Реєстр активів — фінансові дані ОБОХ сторін, чутливіше за реєстр страхування в ДТП

**Не з пошуку, пряме продуктове міркування.** На відміну від `DtpParticipantInsurance` (дані
про ІНШОГО учасника ДТП, незнайому людину), реєстр активів у сімейному праві типово містить
фінансову інформацію ОБОХ сторін — включно з даними самого користувача. Це не змінює правовий
статус (GDPR/privacy аналіз той самий, що вже в `devils-advocate-dtp-v2-tz.md` §2.2), але
підвищує практичну шкоду при витоку — реєстр активів подружжя, якщо потрапить не в ті руки, дає
повнішу фінансову картину, ніж номер страхового поліса незнайомця. **Наслідок:** той самий
принцип "леджер, не перевірене джерело істини", але з явним нагадуванням у преамбулі чернетки
(розділ 3.6) про особливу чутливість цього розділу протоколу.

---

## 3. Архітектурні рішення

### 3.1 Сторона спору — окрема модель, БЕЗ уніфікації з DtpParticipant

**Явне рішення з діалогу перед цим документом, не мовчазний вибір.** `FamilyLawParty` —
структурно схожа на `DtpParticipant` (`role`, `displayName`), але НЕ та сама таблиця:
`role: SELF | SPOUSE` (без `THIRD_PARTY` — треті особи типу спільного бізнес-партнера чи
родича-співвласника поза обсягом цього проходу, той самий принцип звуження, що вже
застосований до опіки дітей, `devils-advocate-family-law-tz.md` §8). Немає аналога
`hasFledScene` — домен-специфічний факт ДТП, не має сенсу тут; якщо в майбутньому знадобиться
"сторона ухиляється від процесу" — це БУДЕ окреме поле, не перейменований `hasFledScene`.

**Той самий захист "лише один SELF", що вже застосований у ДТП v2 (§3.1 того документа) —
включно з частковим унікальним індексом бази даних проти стану гонитви**, не тільки сервісною
перевіркою (той самий урок, перенесений одразу, не через окремий аудит-прохід постфактум).

### 3.2 Статус процесу — окрема модель, спільна ФОРМА, не спільна таблиця (ревізія розділу 0)

`FamilyLawStatusDetermination` — СПИСОК записів (той самий принцип, що `DtpFaultDetermination`
— статус процесу змінюється в часі: подання позову → медіація → остаточна ухвала/угода).
`source: FamilyLawStatusSource` — ВЛАСНИЙ enum
(`COURT_FILING`/`MEDIATION_AGREEMENT`/`INFORMAL_AGREEMENT`/`UNDETERMINED`), не спільний з
`DtpFaultSource` (розділ 0 — ревізія). `isOfficial`/`statusText`/`determinedAt`/
`referenceDocumentNumber` — та сама форма полів, що `DtpFaultDetermination`, включно з
консервативним дефолтом `isOfficial: false`.

**Заповнює КОРИСТУВАЧ вручну** — та сама структурна гарантія, що вже застосована в ДТП (немає
жодного сервісного методу, що пише сюди з `AIRouterService`).

### 3.3 Реєстр активів — не той самий факт, що страхування, окрема модель

`FamilyLawAsset` — тип активу (вільний текст, юрисдикційно й культурно надто різноманітний для
enum — нерухомість/авто/рахунок/бізнес-частка/інше), опис, поточний заявлений власник
(`FamilyLawParty` чи "спільна власність" — `ownerId: String?`, `null` = спільне), заявлена
оцінка вартості (`estimatedValue`/`currency` — власна валюта, той самий урок мультивалютності,
що вже застосований у ДТП v2, тут одразу з першого проходу), `isMaritalProperty: Boolean`
(спільне майно подружжя проти особистого — ключова юридична категорія в більшості юрисдикцій,
той самий принцип "факт, не оцінка" — це те, що СКАЗАВ користувач/юрист, не висновок AI).

### 3.4 Бюджет — окрема модель від DtpBudgetLineItem, той самий короткий патерн

**Свідомо НЕ уніфіковано з `DtpBudgetLineItem`** (розділ попереднього діалогу, підтверджено
тут) — `category` розходиться (`ASSET_TRANSFER`/`LEGAL_FEES`/`SUPPORT_PAYMENT`/`OTHER` замість
`REPAIR`/`INSURANCE_DEDUCTIBLE`/...), форсування в один enum давало б користувачу вибір
"REPAIR" при розлученні. `direction`(EXPENSE/COVERAGE — тут COVERAGE радше "компенсація від
іншої сторони", ніж "страхове покриття", та сама структура, інший сенс)/`amount`/`currency`/
`partyId?` (перейменовано від `participantId` для консистентності назви з розділом 3.1) —
короткий патерн, дешевше повторити явно, ніж ускладнювати спільну модель.

`GET .../budget` повертає `byCurrency` (масив, групування по валюті — той самий фікс, що ДТП
v2, тут одразу, не через окремий аудит-прохід) і `hasLegacyEstimatedCosts` (та сама
оптимізація видимості ризику подвійного обліку з `FamilyLawConsultation.estimatedCost`).

### 3.5 Зіставлення слів між консультаціями — СПІЛЬНИЙ сервіс, не паралельна копія

**Єдине справжнє об'єднання цього документа.** `CriteriaComparisonService` — новий, спільний
модуль (`src/criteria-comparison/`), що приймає масив `{ criterionId, whatWasSaid,
sourceSegmentId?, sourceLabel }[]` (уже згрупований по критерію викликаючим кодом, сервіс
доменно-агностичний) і повертає `NO_DISCREPANCY_FOUND`/`DISCREPANCY_FOUND`/
`INSUFFICIENT_DATA`. System prompt теж доменно-агностичний — заборона "ніколи не визначай, яке
твердження правдиве" не потребує знання, ДТП це чи розлучення (на відміну від system prompt
самого `generateBreakdown()`, де заборона предметна: "не визначай винуватця" проти "не давай
UPL-пораду" — ЦІ лишаються окремими, домен-специфічними, тільки порівняльний рівень
уніфікований).

**АМЕНДМЕНТ до `devils-advocate-dtp-v2-tz.md` §3.7/5.6/6 — явно назване, не тихе
розходження:** той документ спроєктував `DtpService.detectCrossConsultationDiscrepancy` як
метод усередині `DtpService`. Цей документ ЗАМІНЮЄ це рішення — метод переноситься в спільний
`CriteriaComparisonService.compare()`, `DtpService` і `FamilyLawService` викликають той самий
сервіс, передаючи вже зібрані дані зі своїх таблиць. API contract ДТП (`GET
/dtp/criteria/:criterionId/cross-consultation-check`) не змінюється ззовні — зміна тільки
внутрішньої реалізації, той самий принцип "контракт стабільний, реалізація рефакториться", що
вже застосований по всьому продукту.

### 3.6 Чернетка-компіляція — той самий принцип, що ДТП, з явним попередженням про чутливість активів

За аналогією з `devils-advocate-dtp-v2-tz.md` §3.5 — детермінований шаблон, не AI-генерація.
Складається з: сторони (§3.1), останній `FamilyLawStatusDetermination` (§3.2, з міткою
офіційності), реєстр активів (§3.3, **з explicit позначкою в преамбулі про підвищену
чутливість фінансових даних обох сторін**, розділ 2.2), бюджет по валютах (§3.4). Той самий
незнімний преамбул "не юридично завершений документ", розширений реченням про чутливість
активів.

### 3.7 Історія повістки питання — нова знахідка, немає аналога в ДТП

**`goalDescription` у ДТП так само незмінний після створення — той самий клас прогалини існує
і там, не тільки тут, але поза обсягом цього документа** (companion до family-law, не до ДТП;
якщо потрібно — окремий, третій документ). Тут: `FamilyLawGoalRevision` — СПИСОК, той самий
принцип, що статус процесу (§3.2) — кожна зміна мети додає новий запис, стара версія лишається
видимою, не стирається. `FamilyLawConfig.goalDescription` лишається як є (поточне значення,
для швидкого доступу без join), `FamilyLawGoalRevision` — повна історія. Перший запис
створюється автоматично разом із `FamilyLawConfig` (той самий текст, що первинний
`goalDescription`) — історія повна з моменту створення, не тільки з моменту першої зміни.

---

## 4. Схема

```prisma
model FamilyLawParty {
  id       String          @id @default(cuid())
  configId String
  config   FamilyLawConfig @relation(fields: [configId], references: [id], onDelete: Cascade)

  role        FamilyLawPartyRole
  displayName String?

  createdAt DateTime @default(now())

  assets          FamilyLawAsset[]
  budgetLineItems FamilyLawBudgetLineItem[]

  @@map("family_law_parties")
}

enum FamilyLawPartyRole {
  SELF
  SPOUSE
}

// §2.2/3.3 ТЗ — власна модель, НЕ той самий факт, що DtpParticipantInsurance.
model FamilyLawAsset {
  id       String          @id @default(cuid())
  configId String
  config   FamilyLawConfig @relation(fields: [configId], references: [id], onDelete: Cascade)

  assetType   String
  description String?

  ownerId String?
  owner   FamilyLawParty? @relation(fields: [ownerId], references: [id], onDelete: SetNull)

  isMaritalProperty Boolean @default(true)

  estimatedValue Float?
  currency       String?

  createdAt DateTime @default(now())

  @@map("family_law_assets")
}

enum FamilyLawStatusSource {
  COURT_FILING
  MEDIATION_AGREEMENT
  INFORMAL_AGREEMENT
  UNDETERMINED
}

// §3.2 ТЗ (ревізія розділу 0) — та сама ФОРМА, що DtpFaultDetermination,
// ВЛАСНИЙ enum джерела. Заповнюється КОРИСТУВАЧЕМ, ніколи AI.
model FamilyLawStatusDetermination {
  id       String          @id @default(cuid())
  configId String
  config   FamilyLawConfig @relation(fields: [configId], references: [id], onDelete: Cascade)

  source       FamilyLawStatusSource
  statusText   String
  determinedAt DateTime

  isOfficial              Boolean @default(false)
  referenceDocumentNumber String?

  createdAt DateTime @default(now())

  @@map("family_law_status_determinations")
}

enum FamilyLawBudgetCategory {
  ASSET_TRANSFER
  LEGAL_FEES
  SUPPORT_PAYMENT
  OTHER
}

enum FamilyLawBudgetDirection {
  EXPENSE
  COVERAGE
}

// §3.4 ТЗ — окрема від DtpBudgetLineItem, той самий короткий патерн.
model FamilyLawBudgetLineItem {
  id       String          @id @default(cuid())
  configId String
  config   FamilyLawConfig @relation(fields: [configId], references: [id], onDelete: Cascade)

  category    FamilyLawBudgetCategory
  direction   FamilyLawBudgetDirection
  amount      Float
  currency    String?
  description String?

  partyId String?
  party   FamilyLawParty? @relation(fields: [partyId], references: [id], onDelete: SetNull)

  consultationId String?
  consultation   FamilyLawConsultation? @relation(fields: [consultationId], references: [id], onDelete: SetNull)

  createdAt DateTime @default(now())

  @@map("family_law_budget_line_items")
}

// §3.7 ТЗ — історія повістки питання, немає аналога в ДТП (нова знахідка).
model FamilyLawGoalRevision {
  id       String          @id @default(cuid())
  configId String
  config   FamilyLawConfig @relation(fields: [configId], references: [id], onDelete: Cascade)

  goalDescription String
  changedAt       DateTime @default(now())

  @@map("family_law_goal_revisions")
}
```

**Ретроактивна правка вже реалізованої моделі (розділ 0, той самий клас знахідки, що
`DtpConsultation.currency` в ДТП v2):**

```prisma
model FamilyLawConsultation {
  // ... наявні поля без змін ...
  estimatedCost Float?
  currency      String? // НОВЕ поле, той самий принцип, що DtpConsultation.currency
                          // (devils-advocate-dtp-v2-tz.md розділ 0, знахідка 3)
}
```

**Розширення `FamilyLawConfig`:**

```prisma
model FamilyLawConfig {
  // ... наявні поля без змін ...
  parties              FamilyLawParty[]
  assets               FamilyLawAsset[]
  statusDeterminations FamilyLawStatusDetermination[]
  budgetLineItems      FamilyLawBudgetLineItem[]
  goalRevisions        FamilyLawGoalRevision[]
}
```

---

## 5. Компоненти

### 5.1 Спільний сервіс порівняння (§3.5 ТЗ)

`src/criteria-comparison/criteria-comparison.service.ts` — новий модуль, ДОМЕННО-АГНОСТИЧНИЙ.
`DtpModule`/`FamilyLawModule` обидва імпортують. Той самий принцип чесної деградації, що вже
встановлений у ДТП v2 — `INSUFFICIENT_DATA`, коли менше двох джерел.

### 5.2 Сторони й активи (§3.1/3.3 ТЗ)

Створення сторони, опційна прив'язка активів. Актив без `ownerId` — спільна власність, той
самий принцип чесної деградації, що консервативний дефолт `isMaritalProperty: true`.

### 5.3 Статус процесу (§3.2 ТЗ)

Той самий шаблон, що ДТП v2 §5.2/5.5 — тільки додавання, історія не стирається.

### 5.4 Бюджет (§3.4 ТЗ)

Той самий шаблон, що ДТП v2 §5.3 — `byCurrency`, `hasLegacyEstimatedCosts`, з першого проходу.

### 5.5 Чернетка-компіляція (§3.6 ТЗ)

Той самий шаблон, що ДТП v2 §5.4, з додатковим реченням у преамбулі про чутливість активів.

### 5.6 Історія повістки питання (§3.7 ТЗ)

`PATCH /family-law/configs/:id/goal` (новий ендпоінт, якого не було в первинному
`devils-advocate-family-law-tz.md` взагалі) створює НОВИЙ запис `FamilyLawGoalRevision` і
оновлює `FamilyLawConfig.goalDescription` в одній транзакції — стара версія не втрачається.

---

## 6. API contract

```
# ── Сторони й активи (§5.2) ──
POST /family-law/configs/:id/parties
  Body: { role, displayName? }
GET  /family-law/configs/:id/parties
POST /family-law/configs/:id/assets
  Body: { assetType, description?, ownerId?, isMaritalProperty?, estimatedValue?, currency? }
GET  /family-law/configs/:id/assets

# ── Статус процесу (§5.3) ──
POST /family-law/configs/:id/status-determinations
  Body: { source, statusText, determinedAt, isOfficial?, referenceDocumentNumber? }
GET  /family-law/configs/:id/status-determinations

# ── Бюджет (§5.4) ──
POST /family-law/configs/:id/budget-line-items
  Body: { category, direction, amount, currency?, description?, partyId?, consultationId? }
GET  /family-law/configs/:id/budget
  → { lineItems: [...], byCurrency: [...], targetBudget, currency, hasLegacyEstimatedCosts }

# ── Зіставлення слів між консультаціями (§5.1, СПІЛЬНИЙ сервіс) ──
GET  /family-law/criteria/:criterionId/cross-consultation-check
GET  /family-law/configs/:id/cross-consultation-check
  # той самий контракт, що /dtp/criteria/:criterionId/..., внутрішньо викликає
  # той самий CriteriaComparisonService (розділ 3.5, амендмент до dtp-v2-tz.md)

# ── Чернетка-компіляція (§5.5) ──
GET  /family-law/configs/:id/settlement-protocol-draft

# ── Повістка питання (§5.6) ──
PATCH /family-law/configs/:id/goal
  Body: { goalDescription }
  → FamilyLawConfig (оновлено) + новий FamilyLawGoalRevision
GET  /family-law/configs/:id/goal-history
  → [{ goalDescription, changedAt }, ...] у хронологічному порядку
```

---

## 7. Acceptance-тести

```
Given FamilyLawParty з role=SPOUSE уже існує
When створюється FamilyLawParty з role=SELF, потім ще один з role=SELF
Then другий SELF відхиляється (сервісна перевірка + частковий унікальний індекс, §3.1 ТЗ —
     той самий захист, що ДТП v2, перенесений одразу)

Given FamilyLawAsset без ownerId
When створюється запис
Then isMaritalProperty=true за замовчуванням (консервативний дефолт), актив трактується як
     спільна власність, поки явно не вказано інше

Given FamilyLawStatusDetermination створено без isOfficial
When перевіряється значення
Then isOfficial=false — та сама гарантія, що DtpFaultDetermination

Given спроба знайти спільний Prisma-enum для FamilyLawStatusSource і DtpFaultSource
When перевіряється схема
Then enum'и ОКРЕМІ — підтверджує ревізію розділу 0, не спільна таблиця

Given DTP і family-law конфіги, кожен з 2+ консультаціями з розбіжним whatWasSaid для
      одного критерію
When викликається cross-consultation-check для обох
Then обидва повертають DISCREPANCY_FOUND через ТОЙ САМИЙ CriteriaComparisonService — підтверджує
     реальне (не задеклароване) спільне використання, не паралельні копії коду

Given FamilyLawConfig створено з goalDescription="Шлюбний договір"
When перевіряється FamilyLawGoalRevision одразу після створення
Then існує ОДИН запис, що дублює початкове значення — історія повна з моменту створення

Given goalDescription оновлюється через PATCH .../goal тричі
When викликається GET .../goal-history
Then повертаються ВСІ чотири версії (початкова + три оновлення) в хронологічному порядку,
     жодна не втрачена

Given GET .../budget викликається на конфігу з FamilyLawBudgetLineItem у UAH та в USD
When перевіряється відповідь
Then byCurrency містить два окремі записи — той самий фікс, що ДТП v2, з першого проходу
```

---

## 8. Що свідомо виключено з цього проходу

- **Уніфікація `FamilyLawAsset`/`DtpParticipantInsurance` в спільну модель** — розглянуто й
  явно відхилено (розділ 2.2/3.3) — різні факти, не той самий факт у різному вбранні.
- **Уніфікація `FamilyLawBudgetLineItem`/`DtpBudgetLineItem`** — розглянуто й явно відхилено
  (розділ 3.4) — `category` розходиться по суті, не тільки за назвою значень.
- **Уніфікація `FamilyLawParty`/`DtpParticipant`** — розглянуто й явно відхилено (розділ 3.1)
  — домен-специфічні прапорці (`hasFledScene`) не мають спільного сенсу.
- **`FamilyLawStatusDetermination`/`DtpFaultDetermination` як одна таблиця** — початково
  запропоновано в діалозі, ПІД ЧАС проєктування виявлено нездійсненним без втрати типізації
  `source` — ревізія задокументована в розділі 0, не прихована.
- **`THIRD_PARTY` роль для `FamilyLawParty`** — не запитано, той самий принцип "не додавати
  про запас", що вже застосований по всьому продукту.
- **Виправлення тієї самої прогалини (`goalDescription` без історії) у вже написаному
  `devils-advocate-dtp-v2-tz.md`** — названо як реальну, існуючу прогалину (розділ 3.7), але
  її виправлення в ДТП — поза обсягом ЦЬОГО документа (companion до family-law), окремий,
  третій прохід за потреби.

---

## 9. Юридичне застереження

Розділ 2 спирається на `devils-advocate-family-law-tz.md` §2.1 (UPL) та
`devils-advocate-dtp-v2-tz.md` §2.2 (дані третіх осіб, тут — GDPR-аналіз той самий, ризик
практичної шкоди вищий через фінансові дані обох сторін, не тільки однієї незнайомої людини).
Компанія, що розгортає цю фічу, зобов'язана оцінити власним юрисконсультом: чи реєстр активів
подружжя вимагає окремого, суворішого технічного захисту (шифрування на рівні поля, не тільки
на рівні бази даних) порівняно з рештою продукту — цей документ не досліджує це питання
окремо, тільки називає його явно.

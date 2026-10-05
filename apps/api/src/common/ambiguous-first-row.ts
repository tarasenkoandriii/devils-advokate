// Пункт [the-first-row-was-whichever] 2026-10-05 — реестр мест, где
// `findFirst` берёт «одну из», и это ОСОЗНАННО.
//
// ЗАЧЕМ РЕЕСТР, А НЕ ЧИСЛО. Разбор `[one-of-several-spoke-for-all]`
// 2026-09-25 уже проходил этим путём и оставил после себя абзац с
// числами: «из 223 вызовов 126 без сортировки, у 51 фильтр не выглядит
// уникальным, и только у 12 используется СОДЕРЖИМОЕ найденной строки,
// девять из двенадцати защищены `@@unique` или уникальны по
// построению». Числа честные, но проверить их заново нечем: ни одно из
// двенадцати мест не названо. Поэтому следующий читатель (этот Пункт)
// измерил всё с нуля — и нашёл внутри той успокаивающей фразы два
// места, где человек платит: произвольная из двух ACTIVE-версий
// промпта и произвольный из двух «решающих людей» в прогнозе.
// УСПОКОЕНИЕ, КОТОРОЕ НЕЛЬЗЯ ПЕРЕПРОВЕРИТЬ, РАВНО ОТСУТСТВИЮ
// УСПОКОЕНИЯ. Отсюда правило: не число в документе, а список имён,
// который сверяется на каждом прогоне.
//
// ЧТО ИЗМЕРЕНО. 174 вызова `findFirst` в `apps/api/src`; у 95 фильтр
// уникален по схеме (`@id`, `@unique`, `@@unique` целой группой), у 77
// — нет, у 2 фильтр не читается автоматически. Из 77 у 50 `orderBy`
// БЫЛ, и ровно поэтому прошлое измерение их не видело: оно отбирало
// «без сортировки». А сортировка по одному неуникальному столбцу
// (`createdAt`, `endMs`, `orderIndex`, `versionNumber`) ничью не
// разрывает — это ровно урок Пункта [tie-is-random] 2026-09-06,
// примененный тогда только к `findMany` с потолком. `findFirst` и есть
// `take: 1`, и правило обязано было распространиться на него сразу.
// Не распространилось: «правило было, просто не везде».
//
// ПРАВИЛО ТЕПЕРЬ ОДНО. У вызова `findFirst` с неуникальным фильтром
// обязано быть ЛИБО уникальное поле в `orderBy`, ЛИБО запись здесь с
// причиной. Третьего (молча «одну из») больше нет; сверяет это спека
// `audit-2026-10-05-the-first-row-was-whichever.spec.ts`.

export type AmbiguityReason =
  /** Содержимое строки не читается — только факт её существования.
   *  Любая подходящая даёт тот же исход. */
  | 'existence-only'
  /** Двух подходящих строк быть не может, но держит это не схема, а
   *  построение: свежий идентификатор, цепочка `@unique`, единственный
   *  писатель. Такая гарантия обязана быть названа — она ломается
   *  молча, когда появляется второй путь записи. */
  | 'unique-by-construction'
  /** Две подходящие возможны, но они равнозначны по смыслу, и выбор
   *  не меняет того, что получает человек. */
  | 'choice-indifferent';

export interface AmbiguousFirstRow {
  /** Путь от `apps/api/src`. */
  file: string;
  model: string;
  reason: AmbiguityReason;
  /** Почему именно так — и чем это доказано, а не «кажется». */
  why: string;
}

export const AMBIGUOUS_FIRST_ROW: readonly AmbiguousFirstRow[] = [
  // ── содержимое не читается: только «есть или нет» ──
  {
    file: 'candidate-self-share/candidate-self-share.service.ts',
    model: 'consentRecord',
    reason: 'existence-only',
    why: 'Результат идёт только в `if (!existing)`; поля не читаются. Две действующие записи означают одно и то же разрешение, а отзыв гасит все записи типа разом (`consent.service.ts`, `updateMany` без фильтра по version и purposes) — значит «отозвал, а вторая живая осталась» невозможно.',
  },
  {
    file: 'onboarding/onboarding.service.ts',
    model: 'consentRecord',
    reason: 'existence-only',
    why: 'То же: `if (existing) return`. Отзыв религиозного согласия идёт `updateMany` по типу и гасит все.',
  },
  {
    file: 'client-brief/client-brief.service.ts',
    model: 'employerDossier',
    reason: 'existence-only',
    why: 'Проверяется только, названа ли компания в проекте: `if (!dossier) throw COMPANY_REQUIRED`. Реквизиты из досье в бриф не переносятся. Там, где они ПЕРЕНОСЯТСЯ, выбор уже разобран иначе — `employer-dossier/single-dossier.ts` и `manyCompaniesMessage`.',
  },
  {
    file: 'employer-hiring/employer-hiring.service.ts',
    model: 'employerDossier / conversationParticipant / termsSheet',
    reason: 'existence-only',
    why: 'Три вызова в одном файле: `assertCompanyIdentified` читает только факт наличия досье; участник self уходит в `participantId` сегмента, где оба кандидата — сам пользователь; лист VACANCY уникален по построению (см. ниже, `hiring-extras`).',
  },
  {
    file: 'employer-hiring/engagement.service.ts',
    model: 'employerDossier',
    reason: 'existence-only',
    why: 'Только `if (!dossier) throw`; в создаваемое приглашение агентству ни одно поле досье не попадает.',
  },
  {
    file: 'vacancy-posting/vacancy-posting.service.ts',
    model: 'employerDossier / complianceFlag',
    reason: 'existence-only',
    why: 'Досье — только факт наличия. Языковой флаг — «такой уже заведён, второй не плодим»; человеку всё равно печатается полный список флагов отдельным `findMany` с сортировкой.',
  },
  {
    file: 'live-argument-tracking/live-argument-tracking.service.ts',
    model: 'liveManipulationFlag',
    reason: 'existence-only',
    why: 'Строка служит булевым признаком «уловка за последние 30 секунд была»; ни technique, ни description, ни confidence не читаются. Несколько флагов за окно — норма: одна проверка фрагмента пишет по флагу на каждую найденную уловку.',
  },
  {
    file: 'venue-application/venue-application.service.ts',
    model: 'venueBookingConfirmation',
    reason: 'existence-only',
    why: 'Только «отметка за сегодня уже есть?» → один и тот же отказ с одним текстом. ОТДЕЛЬНО НАЗВАНО И НЕ ЗАКРЫТО: сама пара «проверил — создал» неатомарна, и два одновременных нажатия удвоят `referralFeeOwed`, который оператор видит как «к оплате» заведению; плюс «день» считается от серверной таймзоны, а не от таймзоны человека. Это не про выбор строки, поэтому закрывается отдельно.',
  },
  {
    file: 'dtp/dtp-v2.service.ts',
    model: 'dtpParticipant',
    reason: 'existence-only',
    why: 'Только `if (existing) throw`. Сама единственность SELF теперь держится замком по `configId` и частичным уникальным индексом из `manual-migrations/one_active_row_2026_10_05.sql` — до этого Пункта её не держало НИЧЕГО, хотя шапка кода и ТЗ §3.1 ссылались на индекс, которого в репозитории не было.',
  },
  {
    file: 'family-law/family-law-v2.service.ts',
    model: 'familyLawParty',
    reason: 'existence-only',
    why: 'То же и по той же причине: «той самий захист, що ДТП v2» было правдой — защиты не было ни там, ни тут.',
  },

  // ── две возможны, но они про одно и то же ──
  {
    file: 'dtp/dtp-onboarding.service.ts',
    model: 'conversationParticipant',
    reason: 'choice-indifferent',
    why: 'Оба кандидата `isSelf: true`, и `personId` у такого участника принудительно `null` (`conversations.service.ts`, `mapParticipant`) — то есть оба означают самого пользователя. Потребители сегментов фильтруют по признаку `isSelf`, а не по строке участника, поэтому исход одинаков; расходится только служебная метка диаризации.',
  },
  {
    file: 'family-law/family-law-onboarding.service.ts',
    model: 'conversationParticipant',
    reason: 'choice-indifferent',
    why:
      'Оба кандидата `isSelf: true` с принудительным `personId: null`, то есть оба означают самого пользователя; его `id` уходит в `participantId` дописанного сегмента, а все потребители сегментов отбирают их по признаку `isSelf`, не по строке участника. Расходится только служебная метка диаризации, которой человеку нигде не показывают. Это восьмая копия одного метода `appendAnswer` — и ВОТ ЭТО настоящая находка места: решение по нему принимается не по файлу, а по всем восьми сразу, а копия, расходящаяся молча, и есть то, от чего реестр страхует.',
  },
  {
    file: 'health/health-onboarding.service.ts',
    model: 'conversationParticipant',
    reason: 'choice-indifferent',
    why:
      'Оба кандидата `isSelf: true` с принудительным `personId: null`, то есть оба означают самого пользователя; его `id` уходит в `participantId` дописанного сегмента, а все потребители сегментов отбирают их по признаку `isSelf`, не по строке участника. Расходится только служебная метка диаризации, которой человеку нигде не показывают. Это восьмая копия одного метода `appendAnswer` — и ВОТ ЭТО настоящая находка места: решение по нему принимается не по файлу, а по всем восьми сразу, а копия, расходящаяся молча, и есть то, от чего реестр страхует.',
  },
  {
    file: 'interview-pool/interview-pool-onboarding.service.ts',
    model: 'conversationParticipant',
    reason: 'choice-indifferent',
    why:
      'Оба кандидата `isSelf: true` с принудительным `personId: null`, то есть оба означают самого пользователя; его `id` уходит в `participantId` дописанного сегмента, а все потребители сегментов отбирают их по признаку `isSelf`, не по строке участника. Расходится только служебная метка диаризации, которой человеку нигде не показывают. Это восьмая копия одного метода `appendAnswer` — и ВОТ ЭТО настоящая находка места: решение по нему принимается не по файлу, а по всем восьми сразу, а копия, расходящаяся молча, и есть то, от чего реестр страхует.',
  },
  {
    file: 'investment/investment-onboarding.service.ts',
    model: 'conversationParticipant',
    reason: 'choice-indifferent',
    why:
      'Оба кандидата `isSelf: true` с принудительным `personId: null`, то есть оба означают самого пользователя; его `id` уходит в `participantId` дописанного сегмента, а все потребители сегментов отбирают их по признаку `isSelf`, не по строке участника. Расходится только служебная метка диаризации, которой человеку нигде не показывают. Это восьмая копия одного метода `appendAnswer` — и ВОТ ЭТО настоящая находка места: решение по нему принимается не по файлу, а по всем восьми сразу, а копия, расходящаяся молча, и есть то, от чего реестр страхует.',
  },
  {
    file: 'job-search/job-search-onboarding.service.ts',
    model: 'conversationParticipant',
    reason: 'choice-indifferent',
    why:
      'Оба кандидата `isSelf: true` с принудительным `personId: null`, то есть оба означают самого пользователя; его `id` уходит в `participantId` дописанного сегмента, а все потребители сегментов отбирают их по признаку `isSelf`, не по строке участника. Расходится только служебная метка диаризации, которой человеку нигде не показывают. Это восьмая копия одного метода `appendAnswer` — и ВОТ ЭТО настоящая находка места: решение по нему принимается не по файлу, а по всем восьми сразу, а копия, расходящаяся молча, и есть то, от чего реестр страхует.',
  },
  {
    file: 'major-purchase/major-purchase-onboarding.service.ts',
    model: 'conversationParticipant',
    reason: 'choice-indifferent',
    why:
      'Оба кандидата `isSelf: true` с принудительным `personId: null`, то есть оба означают самого пользователя; его `id` уходит в `participantId` дописанного сегмента, а все потребители сегментов отбирают их по признаку `isSelf`, не по строке участника. Расходится только служебная метка диаризации, которой человеку нигде не показывают. Это восьмая копия одного метода `appendAnswer` — и ВОТ ЭТО настоящая находка места: решение по нему принимается не по файлу, а по всем восьми сразу, а копия, расходящаяся молча, и есть то, от чего реестр страхует.',
  },
  {
    file: 'admin-sandbox/admin-sandbox.service.ts',
    model: 'project',
    reason: 'choice-indifferent',
    why: 'Технический проект песочницы оператора: два вызова, оба «найти или создать» по `(ownerId, question)` с одним и тем же текстом вопроса и цели («можно удалять»). Две строки созданы одним кодом из одних данных, состояния, читаемого позже по этой паре, у них нет, а `id` сразу отдаётся вызывающему. Цена — лишний мусорный проект в списке оператора, не подмена данных.',
  },

  // ── двух быть не может, но держит это построение, а не схема ──
  {
    file: 'conversations/paralinguistics.service.ts',
    model: 'conversation',
    reason: 'unique-by-construction',
    why: '`paralinguisticsJobId` это `AIJob.id` (`@id @default(cuid())`), пишется единственным местом значением только что созданной джобы, а переиспользование джобы по `inputHash` на асинхронной полосе выключено: `enqueue` зовёт `prepareJob(request, \'background\')`, то есть `allowReuse = false` (проверено — `execute` передаёт `true`, `enqueue` не передаёт ничего).',
  },
  {
    file: 'vacancy-intake/job-search-tools.service.ts',
    model: 'jobVacancy',
    reason: 'unique-by-construction',
    why: 'То же: `batchMatchJobId` — свежий `AIJob.id`, один писатель, и поле СНИМАЕТСЯ после обработки, так что устаревшие значения не накапливаются.',
  },
  {
    file: 'media-review/media-review-auto.service.ts',
    model: 'mediaReviewQueueItem',
    reason: 'unique-by-construction',
    why: 'То же: `aiJobId` — свежий `AIJob.id` от `enqueue`. Повторный запуск разбора обновляет ТУ ЖЕ строку новым jobId, второй не создаёт. Укрепить это до ограничения стоило бы дешево (`aiJobId String? @unique`) и дало бы заодно индекс, которого у поля нет вовсе, — названо и не сделано: это миграция, она требует проверки данных, а у строки с NULL уникальность Postgres не проверяет.',
  },
  {
    file: 'safe-share/safe-share.service.ts',
    model: 'contentScanResult',
    reason: 'unique-by-construction',
    why: '`externalRef` равен `SafeShareAction.id` — свежему cuid, созданному в том же вызове `preflight`, а `scan()` сохраняет результат ровно один раз. У поля нет даже индекса: оно намеренно полиморфно (`media:youtube:<id>` и прочее), и уникальность по нему как таковому была бы неверной.',
  },
  {
    file: 'hiring-extras/hiring-extras.service.ts',
    model: 'termsSheet',
    reason: 'unique-by-construction',
    why: 'Лист `kind=VACANCY` создаётся единственным местом и всегда с `configId`, а `TermsSheet.configId @unique` + `InterviewPoolConfig.projectId @unique` дают «не больше одного на проект». ОГОВОРКА: `configId` нуллируемый, и в Postgres NULL друг с другом не конфликтуют — появится путь, создающий VACANCY без `configId`, и ничья вернётся сразу в двух местах, ничего в базе её не остановит.',
  },
  {
    file: 'terms-sheet/terms-sheet.service.ts',
    model: 'termsSheet',
    reason: 'unique-by-construction',
    why: 'Ветка «лист успел создать параллельный вызов» перечитывает его по `key`, а оба вызывающих места передают ровно одно уникальное поле (`configId` либо `vacancyId`). Типы этого не требовали: оба поля необязательны, и `where: {}` вернул бы ПЕРВУЮ строку таблицы, то есть чужой лист условий в тексте отказа. Добавлена проверка в рантайме — ловушка закрыта до появления третьего вызывающего.',
  },
];

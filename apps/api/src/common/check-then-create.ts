// Пункт [check-then-create-2] 2026-09-27 — вторая половина сверки
// «проверил — и создал».
//
// ЧТО БЫЛО СДЕЛАНО В ПЕРВОЙ (2026-09-04). Форма дефекта: метод читает,
// есть ли уже такая строка, и если нет — создаёт. Между чтением и
// записью проходит время, и второй такой же вызов (двойное нажатие,
// повтор при плохой связи, две вкладки) успевает пройти проверку до
// того, как первый запишет. Первая сверка нашла 46 мест, вылечила самые
// дорогие (живое сопровождение разговора, вступления в команду и группу,
// семь «создать конфигурацию домена») и завела `unique-violation.ts`.
//
// ЧЕГО ЕЙ НЕ ХВАТИЛО, И ЭТО ЕДИНСТВЕННЫЙ ПОВОД ДЛЯ ВТОРОЙ. Её мера
// осталась ДИАПАЗОНОМ: «мест больше 30 и меньше 80». Из такой проверки
// не следует, ни какие места вылечены, ни что новое место не появилось.
// То есть правило было применено там, где смотрели, — и ровно это
// повторяющееся в проекте «правило было, просто не везде».
//
// ИЗМЕРЕНО ЗАНОВО, по замкнутому населению: место, где в ОДНОМ методе
// читают и создают одну и ту же модель, И у модели есть уникальное
// ограничение, ВСЕ поля которого стоят в условии чтения. Таких мест
// оказалось 19, и у ВОСЬМИ лекарства не было:
//
//   `client-brief/ensureConfig`, `employer-hiring/updateConfig`,
//   `evaluation/findOrCreateMetric`, `library/submitProject`,
//   `terms-sheet/openVacancySheet`, `terms-sheet/openForVacancy`,
//   `text-to-speech/synthesize`, `working-materials/submitVersion`.
//
// Девятое нашлось уже при разборе: `engagement/copyItems` создавал конфиг
// парой «есть — обновить, нет — создать», и в ТОМ ЖЕ методе соседнее
// копирование объявления давно сделано `upsert`-ом. Мера его не увидела,
// потому что искала лекарство по методу, а не по модели, — и это ошибка
// самой меры, записанная здесь, чтобы её не повторить.
//
// ЧЕТЫРЕ РАЗНЫХ ЛЕКАРСТВА, И ПУТАТЬ ИХ НЕЛЬЗЯ. Выбор определяется не
// удобством, а замыслом места: что ДОЛЖНО случиться при повторе.
//
// САМОЕ ДОРОГОЕ ИЗ НАЙДЕННОГО — `working-materials/submitVersion`. Там
// окно между «узнать номер следующей версии» и «вставить её» — не
// миллисекунды, а весь вызов модели, десятки секунд. Две правки одного
// материала получали один номер, и вторая падала на уникальном
// `(workingMaterialId, versionNumber)` ПОСЛЕ того, как разбор уже сделан
// и оплачен: человек терял готовую работу и видел внутреннюю ошибку. И
// `upsert` там был бы не лечением, а второй бедой — он перезаписал бы
// чужую версию, то есть потерял бы уже сохранённый разбор молча.

/** Что должно произойти при повторе — и, значит, чем лечится гонка. */
export type RaceCure =
  /** Повтор задуман безвредным: `upsert` убирает окно по определению. */
  | 'upsert'
  /** Повтор — ошибка ПО ЗАМЫСЛУ. Гонку не исключить, но ответ обязан
   * совпадать: P2002 превращается в тот же отказ, что и проверка. */
  | 'same-answer'
  /** Номер вычислен заранее; на занятом номере пересчитать и вставить
   * снова. `upsert` здесь перезаписал бы чужую запись. */
  | 'renumber'
  /** Пакетная вставка: `createMany` со `skipDuplicates`. */
  | 'skip-duplicates'
  /** Вторая вставка не нужна вовсе (кэш): дубль пропускается молча, а
   * ЛЮБОЙ ДРУГОЙ отказ — нет. */
  | 'ignore-duplicate';

export interface CuredRace {
  /** Файл относительно `src/`. */
  file: string;
  /** Метод, внутри которого стоит лечение. */
  method: string;
  /** Модель Prisma, гонка по которой лечится. */
  model: string;
  /** Уникальное ограничение, которое эту гонку и делает видимой. */
  key: string;
  cure: RaceCure;
  /** Строка, по которой лечение видно в коде. Привязана к МОДЕЛИ, а не к
   * методу: мера первой сверки искала лекарство по методу и потому не
   * увидела гонку в `copyItems`, где рядом лечили другую модель. */
  shows: string;
  why: string;
}

export const CURED_RACES: readonly CuredRace[] = [
  // ── повтор — ошибка по замыслу: ответ обязан совпадать ───────────
  {
    file: 'health/health.service.ts', method: 'createConfig', model: 'HealthConfig', key: 'projectId',
    cure: 'same-answer', shows: 'isUniqueViolation',
    why: 'человек должен прочитать «разбор для этого проекта уже настроен», а не «внутренняя ошибка сервера» — первая сверка, 2026-09-04',
  },
  {
    file: 'dtp/dtp.service.ts', method: 'createConfig', model: 'DtpConfig', key: 'projectId',
    cure: 'same-answer', shows: 'isUniqueViolation',
    why: 'то же место в домене ДТП: семь доменов держат одну и ту же форму «создать конфигурацию», и разойтись они не должны — иначе один домен снова начнёт отдавать пятисотку',
  },
  {
    file: 'family-law/family-law.service.ts', method: 'createConfig', model: 'FamilyLawConfig', key: 'projectId',
    cure: 'same-answer', shows: 'isUniqueViolation',
    why: 'то же место в семейном праве: форма та же, и ответ на повтор обязан быть тем же понятным отказом',
  },
  {
    file: 'investment/investment.service.ts', method: 'createConfig', model: 'InvestmentConfig', key: 'projectId',
    cure: 'same-answer', shows: 'isUniqueViolation',
    why: 'то же место в инвестициях: форма та же, и ответ на повтор обязан быть тем же понятным отказом',
  },
  {
    file: 'job-search/job-search.service.ts', method: 'createConfig', model: 'JobSearchConfig', key: 'projectId',
    cure: 'same-answer', shows: 'isUniqueViolation',
    why: 'то же место в поиске работы: форма та же, и ответ на повтор обязан быть тем же понятным отказом',
  },
  {
    file: 'major-purchase/major-purchase.service.ts', method: 'createConfig', model: 'MajorPurchaseConfig', key: 'projectId',
    cure: 'same-answer', shows: 'isUniqueViolation',
    why: 'то же место в крупной покупке: форма та же, и ответ на повтор обязан быть тем же понятным отказом',
  },
  {
    file: 'interview-pool/interview-pool.service.ts', method: 'createConfig', model: 'InterviewPoolConfig', key: 'projectId',
    cure: 'same-answer', shows: 'isUniqueViolation',
    why: 'то же место в подборе персонала: форма та же, и ответ на повтор обязан быть тем же понятным отказом',
  },
  {
    file: 'interview-pool/interview-pool.service.ts', method: 'addCandidate', model: 'CandidatePipelineStatus', key: 'projectId+candidateProfileId',
    cure: 'same-answer', shows: 'isUniqueViolation',
    why: 'кандидат уже в воронке — это не ошибка вызывающего, и отвечать на неё пятисоткой нельзя',
  },
  {
    file: 'employer-dossier/employer-dossier.service.ts', method: 'identify', model: 'EmployerDossier', key: 'projectId+registryCode',
    cure: 'same-answer', shows: 'isUniqueViolation',
    why: 'досье по тому же коду ЕДРПОУ уже заведено — человек получает его, а не отказ',
  },
  {
    file: 'employer-hiring/offer-exchange.service.ts', method: 'resolveCandidateSheet', model: 'EmployerDossier', key: 'projectId+registryCode',
    cure: 'same-answer', shows: 'isUniqueViolation',
    why: 'та же модель на пути обмена офферами: досье заводится по дороге, и гонка здесь особенно вероятна',
  },
  {
    file: 'library/library.service.ts', method: 'submitProject', model: 'LibraryEntry', key: 'sourceProjectId',
    cure: 'same-answer', shows: 'isUniqueViolation',
    why: 'отказ повторной отправки называет НАСТОЯЩЕЕ состояние записи (ждёт модерации / опубликована / отклонена); на гонке человек получал пятисотку вместо этого объяснения, а текст теперь один на оба пути',
  },
  {
    file: 'terms-sheet/terms-sheet.service.ts', method: 'createSheetOrPointToExisting', model: 'TermsSheet', key: 'configId | vacancyId',
    cure: 'same-answer', shows: 'isUniqueViolation',
    why: 'в отказе едет `existingSheetId` — им экран отправляет человека в уже открытый лист; на гонке терялась именно эта половина, и «уже открыт» становилось тупиком',
  },

  // ── повтор задуман безвредным ────────────────────────────────────
  {
    file: 'client-brief/client-brief.service.ts', method: 'ensureConfig', model: 'InterviewPoolConfig', key: 'projectId',
    cure: 'upsert', shows: 'interviewPoolConfig.upsert(',
    why: 'метод так и называется — «убедиться, что есть»; окна в нём быть не должно вовсе',
  },
  {
    file: 'employer-hiring/employer-hiring.service.ts', method: 'updateConfig', model: 'InterviewPoolConfig', key: 'projectId',
    cure: 'upsert', shows: 'interviewPoolConfig.upsert(',
    why: 'кроме гонки, лечит и РАЗНЫЙ ОТВЕТ на одно действие: ветка создания возвращала конфиг без вопросов и стадий, ветка обновления — с ними',
  },
  {
    file: 'employer-hiring/engagement.service.ts', method: 'copyItems', model: 'InterviewPoolConfig', key: 'projectId',
    cure: 'upsert', shows: 'interviewPoolConfig.upsert(',
    why: 'в этом же методе соседнее копирование объявления уже было `upsert`-ом — правило было, просто не везде; мера первой сверки этого не увидела, потому что искала лекарство по методу',
  },
  {
    file: 'evaluation/evaluation.service.ts', method: 'findOrCreateMetric', model: 'EvaluationMetric', key: 'name',
    cure: 'upsert', shows: 'evaluationMetric.upsert(',
    why: 'два прогона оценки заводят метрики параллельно, и падение на уже существующей метрике роняло ВЕСЬ прогон',
  },
  {
    file: 'interview-pool/interview-pool-team.service.ts', method: 'joinTeam', model: 'RecruitingTeamMember', key: 'teamId+userId',
    cure: 'upsert', shows: 'recruitingTeamMember.upsert(',
    why: 'вступить туда, где уже состоишь, — повтор, а не ошибка; роль вступившего раньше повтором не переписывается (первая сверка)',
  },
  {
    file: 'investment/investment-group.service.ts', method: 'joinGroup', model: 'InvestmentGroupMember', key: 'groupId+userId',
    cure: 'upsert', shows: 'investmentGroupMember.upsert(',
    why: 'то же вступление в инвест-группу: повтор перехода по ссылке — не ошибка, и роль вступившего раньше им не переписывается (первая сверка)',
  },

  // ── пакетная вставка ─────────────────────────────────────────────
  {
    file: 'live-argument-tracking/live-argument-tracking.service.ts', method: 'initialize', model: 'LiveArgumentTrackingStatus', key: 'argumentId',
    cure: 'skip-duplicates', shows: 'skipDuplicates',
    why: 'самый нагруженный экран продукта: было по два запроса на каждый аргумент проекта, стало один на всё, и повтор безвреден по определению (первая сверка)',
  },

  // ── дубль не нужен вовсе ─────────────────────────────────────────
  {
    file: 'text-to-speech/text-to-speech.service.ts', method: 'synthesize', model: 'TtsCache', key: 'textHash',
    cure: 'ignore-duplicate', shows: 'isUniqueViolation',
    why: 'аудио уже сгенерировано и возвращается человеку, вторая запись в кэш не нужна. Но голый `catch {}` глотал ЛЮБОЙ отказ: перестань кэш писаться вовсе — продукт платил бы за каждый повтор синтеза и не сказал бы об этом никому',
  },

  // ── пересчитать номер ────────────────────────────────────────────
  {
    file: 'working-materials/working-materials.service.ts', method: 'insertVersion', model: 'MaterialVersion', key: 'workingMaterialId+versionNumber',
    cure: 'renumber', shows: 'isUniqueViolation',
    why: 'окно здесь — весь вызов модели, десятки секунд, и падение приходило ПОСЛЕ оплаченного разбора: человек терял готовую работу. `upsert` перезаписал бы чужую версию, то есть потерял бы уже сохранённый разбор молча',
  },
];

/** Модели, у которых уникального ограничения нет ВОВСЕ. Там повтор даёт
 * тихий дубль, и лечится это только индексом в базе.
 *
 * Список перенесён сюда из документации первой сверки намеренно: пока он
 * жил только в тексте, его нечем было сверить с кодом. Решение остаётся
 * владельца, и причина та же, что записана 2026-09-04: чтобы написать
 * миграцию, надо решить, ЧТО СЧИТАТЬ ОДИНАКОВЫМ. */
export const RACES_WITHOUT_CONSTRAINT: readonly { model: string; why: string }[] = [
  { model: 'Person', why: 'двух людей с именем «Иван» человек может завести намеренно — уникальность по имени была бы неправдой о его записной книжке' },
  { model: 'PersonFact', why: 'два одинаковых факта об одном человеке почти наверняка ошибка, но «одинаковый» здесь — вопрос о тексте, а не о ключе' },
  { model: 'TermsClause', why: 'два пункта с одним текстом в одном листе бывают законно — например одно требование к двум сторонам' },
  { model: 'TranscriptSegment', why: 'две одинаковые реплики в расшифровке — обычное дело: люди повторяются' },
  { model: 'WorkingMaterial', why: 'два материала с одним названием в проекте человек может завести намеренно' },
  { model: 'ConsentRecord', why: 'история согласий НАКОПИТЕЛЬНАЯ по замыслу: уникальность стёрла бы разницу между «дал снова после отзыва» и «дал один раз»' },
  { model: 'ComplianceFlag', why: 'один и тот же флаг по двум разным цитатам законен, а по одной — дубль; различить это ключом нельзя, не решив, что считать цитатой' },
  {
    model: 'DtpParticipant',
    why: 'двух участников ДТП с одинаковым описанием бывает двое на самом деле — поэтому ограничения по (configId, role) в схеме нет. ПОПРАВКА, Пункт [the-first-row-was-whichever] 2026-10-05: у роли SELF единственность всё-таки обязана быть (§3.1 ТЗ), и держат её теперь замок в createParticipant и ЧАСТИЧНЫЙ уникальный индекс из manual-migrations/one_active_row_2026_10_05.sql. Этот реестр читает только schema.prisma, то есть частичных индексов не видит — значит «без ограничения» здесь означает «без ограничения, выразимого в схеме», и это ограничение самого реестра, а не свойство модели',
  },
  {
    model: 'FamilyLawParty',
    why: 'то же в семейном деле: двух сторон с одинаковым описанием в деле бывает двое на самом деле. И та же поправка, что у DtpParticipant: у роли SELF единственность держат замок и частичный уникальный индекс из той же миграции, которого этот реестр по построению не видит',
  },
];

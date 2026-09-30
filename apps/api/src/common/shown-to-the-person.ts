// Пункт [computed-for-the-person-never-shown] 2026-09-30 — продукт
// посчитал для человека и никуда не показал.
//
// ПОВОД. Обзорный аудит незавершённого назвал одну такую вещь
// (`companyChoice`). Замер показал, что она не одна — и, что важнее, что
// все найденные завели ПРЕДЫДУЩИЕ сверки, каждая ради того, чтобы
// продукт не молчал там, где молчание читается как «всё в порядке».
// Текст доезжал до JSON и останавливался.
//
// ЧЕМ ЭТО ХУЖЕ ОБЫЧНОЙ НЕДОДЕЛКИ. Сверка, закрывшая дефект «продукт
// выбрал за человека», считается закрытой: правило в коде, тест зелёный.
// Но человек по-прежнему видит прочерк. То есть зелёный тест защищает
// ПОЛОВИНУ пути, а отчёт сверки говорит про весь.
//
// КАК ИЗМЕРЕНО. Контроллеров — 99, все. Методы сервисов, которые они
// вызывают, — 478. Ключей верхнего уровня в их ответах, НЕ
// ВСТРЕЧАЮЩИХСЯ ни в одном файле `apps/tma`, `apps/admin`,
// `apps/landing`, — 51, в 23 точках. Реестр ниже разбирает все 23 плюс
// три, которые этот пункт ПОКАЗАЛ и которые из замера поэтому ушли:
// итого 26 точек, 54 ключа.
//
// Отделить маршруты вебхуков не вышло, и это стоит сказать: по имени
// файла находятся только пробы живости, а вебхуки живут ВНУТРИ обычных
// контроллеров (разговоры, спарринг, чат по материалам). Фильтр,
// который это якобы делал, убран — мутация показала, что на результат
// он не влияет.
//
// ЧЕСТНАЯ ГРАНИЦА, И ОНА БОЛЬШАЯ. «Имени нет у клиента» и «человеку не
// показано» — РАЗНЫЕ вещи, и замер их не различает:
//
//   • `JsonView` рисует ответ ЦЕЛИКОМ, не называя полей. Такой ответ
//     человек видит, а имена его полей в коде клиента не встречаются
//     никогда. Это самый частый ложный след замера.
//   • И наоборот: поле с ОБЩИМ именем (`note`, `consentRevoked`) у
//     клиентов встречается — в другом месте и по другому поводу, — и
//     замер считает его показанным. Так он и пропустил третью находку
//     этого пункта: пустую строку матрицы покрытия. Её нашли ЧТЕНИЕМ
//     кода, на который замер указал, а не самим замером.
//
// Поэтому реестр — не «список дефектов», а разбор: у каждой точки
// записано, ЧТО с её ответом происходит на экране. Сторож держит
// замкнутость списка, а не приговор по каждой строке.

export type Fate =
  /** Ответ уходит в общий рисовальщик (`JsonView`) целиком: человек
   *  видит его, имена полей в коде клиента не появляются. */
  | 'рисуется-целиком'
  /** Уезжает человеку файлом выгрузки, не на экран. */
  | 'уезжает-файлом'
  /** Читает библиотека, а не наш код (SDK загрузки). */
  | 'читает-библиотека'
  /** Экрана у точки нет вовсе: диагностика, которую оператор запрашивает
   *  напрямую. */
  | 'нет-экрана'
  /** Значение — основание фильтра или машинная ссылка; человек видит
   *  результат, а не признак. */
  | 'не-для-человека'
  /** Было не показано; этим пунктом показано. */
  | 'ПОКАЗАНО-ЭТИМ-ПУНКТОМ';

export interface ResponseSite {
  /** `файл#метод` — точка, где ответ собирается. */
  readonly at: string;
  /** Ключи верхнего уровня, не встречающиеся ни у одного клиента. */
  readonly keys: readonly string[];
  readonly fate: Fate;
  readonly why: string;
}

export const RESPONSE_SITES: readonly ResponseSite[] = [
  {
    at: 'ai-router/ai-router.service.ts#getJobForUser',
    keys: ['aiInferenceId'],
    fate: 'не-для-человека',
    why: 'идентификатор вывода для последующих запросов, не текст',
  },
  {
    at: 'candidate-self-share/candidate-self-share.service.ts#accept',
    keys: ['profileId'],
    fate: 'не-для-человека',
    why: 'идентификатор созданного профиля — по нему клиент переходит дальше',
  },
  {
    at: 'conversations/audio-blob.service.ts#issueUploadToken',
    keys: ['allowOverwrite', 'allowedContentTypes', 'maximumSizeInBytes', 'tokenPayload', 'validUntil'],
    fate: 'читает-библиотека',
    why: 'формат токена загрузки Vercel Blob: его разбирает клиентский SDK, а не наш код',
  },
  {
    at: 'employer-dossier/employer-dossier.service.ts#get',
    keys: ['registries'],
    fate: 'рисуется-целиком',
    why: 'досье компании показывается панелью через общий рисовальщик',
  },
  {
    at: 'employer-dossier/employer-dossier.service.ts#shipmentChecklist',
    keys: ['closable'],
    fate: 'рисуется-целиком',
    why: 'чеклист отдаётся в общий рисовальщик кнопкой «Чеклист»',
  },
  {
    at: 'employer-hiring/employer-hiring.service.ts#getState',
    keys: ['companyChoice'],
    fate: 'ПОКАЗАНО-ЭТИМ-ПУНКТОМ',
    why: 'текст «компаний несколько» завёл Пункт [one-of-several-spoke-for-all] 2026-09-25 и никуда не показывал: в поле «Компания» стоял прочерк без единого слова о причине',
  },
  {
    at: 'employer-hiring/offer-exchange.service.ts#shareToCandidate',
    keys: ['recordedInRevisions'],
    fate: 'рисуется-целиком',
    why: 'результат передачи оффера показывается общим рисовальщиком',
  },
  {
    at: 'employer-hiring/offer-exchange.service.ts#withdraw',
    keys: ['copiesMarked'],
    fate: 'рисуется-целиком',
    why: 'то же: число помеченных копий видно в ответе на экране отзыва',
  },
  {
    at: 'hiring-extras/hiring-extras.service.ts#biasExport',
    keys: ['excluded'],
    fate: 'рисуется-целиком',
    why: 'выгрузка для внешнего bias-аудита показывается целиком кнопкой',
  },
  {
    at: 'hiring-extras/hiring-extras.service.ts#coverageMatrix',
    keys: ['revokedRows'],
    fate: 'ПОКАЗАНО-ЭТИМ-ПУНКТОМ',
    why: 'число пустующих строк завёл Пункт [revocation-not-one-rule] 2026-09-06 именно затем, чтобы матрица не выглядела полной; экран его не рисовал, а сами пустые строки показывал прочерками без объяснения',
  },
  {
    at: 'hiring-extras/hiring-extras.service.ts#markStatusLetterSent',
    keys: ['selfReported'],
    fate: 'рисуется-целиком',
    why: 'текст «отмечено с ваших слов» едет соседним полем `note`, которое экран показывает',
  },
  {
    at: 'hiring-extras/hiring-extras.service.ts#recordAiNoticeShown',
    keys: ['selfReported'],
    fate: 'рисуется-целиком',
    why: 'то же самое про показ AI-уведомления: признак машинный, а человеку едет `note` — «продукт показ уведомления не проверяет и проверить не может»',
  },
  {
    at: 'hiring-extras/hiring-extras.service.ts#positionsFromRehearsal',
    keys: ['closedByWords', 'floating'],
    fate: 'нет-экрана',
    why: 'маршрут есть, экрана в TMA нет ни одного — разбор репетиции доступен только запросом; названо здесь, а не изображено закрытым',
  },
  {
    at: 'interview-pool/interview-pool.service.ts#addCandidate',
    keys: ['historyDisclaimer'],
    fate: 'ПОКАЗАНО-ЭТИМ-ПУНКТОМ',
    why: 'ответ добавления кандидата выбрасывался клиентом ЦЕЛИКОМ; предупреждение «история с другой вакансии» не видел никто, и написано оно было по-украински внутри русского интерфейса',
  },
  {
    at: 'privacy-center/privacy-center.service.ts#exportData',
    keys: [
      'candidateProfiles',
      'exportedAt',
      'libraryEntries',
      'mediaReviewQueues',
      'notIncluded',
      'safeShareActions',
      'sentCandidateShares',
      'venueApplications',
      'venueBookingConfirmations',
      'voicePrint',
    ],
    fate: 'уезжает-файлом',
    why: 'разделы выгрузки данных: человек читает их в скачанном файле, экран их не называет и не должен',
  },
  {
    at: 'telegram-bot/telegram-bot.service.ts#webhookInfo',
    keys: ['allowed_updates', 'has_custom_certificate', 'last_error_date', 'last_error_message', 'pending_update_count'],
    fate: 'нет-экрана',
    why: 'эхо ответа Telegram для диагностики: имена полей чужие, запрашивает оператор напрямую',
  },
  {
    at: 'terms-sheet/terms-matching.service.ts#proposeCounterparts',
    keys: ['pairs'],
    fate: 'рисуется-целиком',
    why: 'предложенные пары показываются панелью листа; рядом едет `note` с причиной, когда пар нет',
  },
  {
    at: 'terms-sheet/terms-sheet.service.ts#proposeCounterparts',
    keys: ['pairs'],
    fate: 'рисуется-целиком',
    why: 'обёртка над предыдущей точкой: тот же ответ плюс пункты листа — их и рисует панель',
  },
  {
    at: 'terms-sheet/terms-sheet.service.ts#offerDraft',
    keys: ['agreedCount', 'declinedCount', 'openCount'],
    fate: 'рисуется-целиком',
    why: 'черновик оффера рисуется как `text`, а при его отсутствии — целиком',
  },
  {
    at: 'vacancy-intake/job-search-tools.service.ts#coverLetter',
    keys: ['skillsUsed'],
    fate: 'рисуется-целиком',
    why: 'сопроводительное письмо показывается вместе с разбором',
  },
  {
    at: 'vacancy-intake/job-search-tools.service.ts#gapMap',
    keys: ['sheetsAnalyzed', 'totalVacancies'],
    fate: 'рисуется-целиком',
    why: 'карта пробелов отдаётся в общий рисовальщик (`frame` из неё вынут отдельно)',
  },
  {
    at: 'vacancy-intake/job-search-tools.service.ts#matrix',
    keys: ['coveredRequired', 'hasNotCovered', 'hasUnknown', 'requiredTotal'],
    fate: 'не-для-человека',
    why: 'признаки, по которым фильтрует сам сервер; человек выбирает фильтр и видит результат',
  },
  {
    at: 'vacancy-intake/job-search-tools.service.ts#queryBuilder',
    keys: ['boards', 'skillQueries', 'synonymsNotChecked'],
    fate: 'рисуется-целиком',
    why: 'запросы под площадки показываются общим рисовальщиком целиком',
  },
  {
    at: 'vacancy-intake/job-search-tools.service.ts#similar',
    keys: ['anchorId', 'overlap', 'sharedTerms'],
    fate: 'рисуется-целиком',
    why: 'похожие вакансии показываются вместе с оговоркой `frame` о том, что это не рекомендация',
  },
  {
    at: 'vacancy-intake/vacancy-intake.service.ts#importResponses',
    keys: ['unmatched'],
    fate: 'рисуется-целиком',
    why: 'итог импорта откликов показывается целиком',
  },
  {
    at: 'vacancy-posting/vacancy-posting.service.ts#publishChecklist',
    keys: ['blocks'],
    fate: 'рисуется-целиком',
    why: 'чеклист публикации показывается кнопкой «Чеклист» через общий рисовальщик',
  },
];

/** Чего этот реестр НЕ делает. */
export const SHOWN_NOT_CHECKED_HERE: readonly string[] = [
  'Что «рисуется-целиком» и правда нарисовано — не проверяется: общий рисовальщик показывает ответ, каким он пришёл, и доказать это можно только рисуя каждый экран с настоящими данными.',
  'Поля с ОБЩИМ именем (`note`, `consentRevoked`, `text`) в замер не попадают вовсе: имя встречается у клиентов в другом месте. Третья находка этого пункта найдена чтением, а не замером, и следующая такая же найдётся так же.',
  'Вложенные поля (внутри строк таблиц, внутри массивов) не разбираются: замер смотрит верхний уровень ответа.',
  'Правильность самих текстов — не проверяется: сторож видит, что значение доезжает до разметки, а не что оно верное.',
];

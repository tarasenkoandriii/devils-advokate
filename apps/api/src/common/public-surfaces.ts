// Пункт [outside-input] 2026-09-04 — полный список маршрутов, до которых
// можно дотянуться БЕЗ гварда, и что именно проверяет каждый из них
// вместо гварда.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. В шапке `public-discussion.public-controller.ts`
// стояло: «единственный контроллер за весь проект без Telegram-
// аутентификации». В шапке `library.public-controller.ts` — «второй
// (после public-discussion) публичный контроллер проекта». Оба
// утверждения были написаны честно и оба к моменту этой сверки
// оказались неверны: контроллеров с маршрутами без гварда пятнадцать,
// маршрутов — тридцать два. Каждый в своё время объяснил себя в
// собственной шапке; ни один не знал об остальных, и общей картины «что
// у нас торчит наружу» не существовало нигде.
//
// Хуже того, три из них названы `*.public-controller.ts`, а не
// `*.controller.ts` — то есть любая сверка, перебирающая контроллеры по
// обычному шаблону `*.controller.ts`, проходит мимо ровно тех файлов,
// которые важнее прочих. Так и вышло: разметка DTO валидаторами дошла
// до 63 классов в защищённых контроллерах и не дошла до шести публичных
// эндпоинтов записи — при том, что Пункт [validation] называл
// «публичные POST» среди первых приоритетов.
//
// Список ведётся здесь, а тест (audit-2026-09-04-outside-input.spec.ts)
// перебирает ВСЕ файлы `*controller.ts` — с точкой в имени и без — и
// требует: каждый маршрут без гварда принадлежит контроллеру, который
// перечислен ниже. Новая поверхность наружу не может появиться молча.
//
// ВАЖНО ПРО ТЕСТ: он снимает комментарии перед разбором. Без этого
// строка «НАМЕРЕННО БЕЗ @UseGuards(TelegramAuthGuard)» в комментарии
// читалась бы как наличие гварда — и два публичных контроллера
// оказались бы невидимы именно из-за фразы, объясняющей, что они
// публичные. Эта ловушка сработала при написании сверки.

/** Чем маршрут защищён, если не гвардом. */
export type SurfaceProtection =
  /** Ничем: доступ по факту знания непредсказуемого токена в URL, либо
   * витрина, открытая по замыслу. */
  | 'token-or-open'
  /** Общий секрет в заголовке, вызывающая сторона — не человек
   * (pg_cron/pg_net, вебхук провайдера). Без секрета — 401. */
  | 'shared-secret'
  /** Открыт по необходимости самой функции: проверка живости, вход. */
  | 'by-necessity';

export interface UnguardedSurface {
  controller: string;
  /** Файл относительно apps/api/src. */
  file: string;
  protection: SurfaceProtection;
  /** Почему здесь нет гварда — решение, а не «так исторически». */
  reason: string;
  /** Принимает ли поверхность запись от неаутентифицированной стороны.
   * Читающая витрина и форма, принимающая текст, — разный разговор про
   * риск, и разметка DTO обязательна именно для второй. */
  acceptsPublicWrites: boolean;
}

export const UNGUARDED_SURFACES: UnguardedSurface[] = [
  // ── Открытые по замыслу ──
  {
    controller: 'PublicDiscussionPublicController',
    file: 'public-discussion/public-discussion.public-controller.ts',
    protection: 'token-or-open',
    reason:
      'Обсуждение решения по ссылке: знание непредсказуемого publicShareToken и есть доступ. Требовать Telegram-аутентификацию значило бы, что позвать в обсуждение можно только пользователя приложения. ' +
      'Пункт [public-name] 2026-09-05 добавил сюда два маршрута удаления: участник может забрать свой комментарий и свою нерассмотренную заявку, опознаваясь по собственному participantId — другого удостоверения у пришедшего по ссылке нет, и заводить аккаунт ради права забрать своё значило бы поставить условие вместо права.',
    acceptsPublicWrites: true,
  },
  {
    controller: 'LibraryPublicController',
    file: 'library/library.public-controller.ts',
    protection: 'token-or-open',
    reason:
      'Публичная библиотека разборов (§3.5 ТЗ): цель фичи — «SEO-трафик, вирусность и социальное доказательство», то есть индексируемость поисковиками, что несовместимо с гейтом по аутентификации.',
    acceptsPublicWrites: true,
  },
  {
    controller: 'VenueApplicationPublicController',
    file: 'venue-application/venue-application.public-controller.ts',
    protection: 'token-or-open',
    reason: 'Публичная витрина одобренных заведений (§3.23 ТЗ). Только чтение, только прошедшие модерацию заявки.',
    acceptsPublicWrites: false,
  },
  {
    controller: 'InterviewPoolShareController',
    file: 'interview-pool/interview-pool.controller.ts',
    protection: 'token-or-open',
    reason:
      'Предпросмотр карточки кандидата по ссылке (§4 ТЗ interview-pool): знание токена и есть авторизация. Приём ссылки (accept) уже требует гварда — он создаёт запись владельцу.',
    acceptsPublicWrites: false,
  },
  {
    controller: 'PreQuestionnairePublicController',
    file: 'hiring-extras/hiring-extras.controller.ts',
    protection: 'token-or-open',
    reason:
      'Предварительная анкета кандидата по ссылке: кандидат не пользователь приложения и не должен им становиться, чтобы ответить на вопросы. Пункт [candidate-rights] 2026-09-04: по тому же токену он ОТЗЫВАЕТ согласие — право, которое текст согласия обещал, а продукт давал только рекрутеру. Отзыв за авторизацией был бы обещанием без способа им воспользоваться; токен здесь и есть подтверждение, что перед нами тот, кому эту ссылку прислали.',
    acceptsPublicWrites: true,
  },
  {
    controller: 'PostingReviewPublicController',
    file: 'vacancy-posting/vacancy-posting.controller.ts',
    protection: 'token-or-open',
    reason:
      'Ревью текста вакансии по ссылке: приглашённый коллега читает черновик и оставляет комментарий, не заводя аккаунт.',
    acceptsPublicWrites: true,
  },
  {
    controller: 'CandidateSelfSharePublicController',
    file: 'candidate-self-share/candidate-self-share.controller.ts',
    protection: 'token-or-open',
    reason:
      'Предпросмотр того, чем кандидат делится сам: получатель ссылки видит ровно выбранные кандидатом пункты. Только чтение.',
    acceptsPublicWrites: false,
  },

  // ── Общий секрет в заголовке ──
  {
    controller: 'SchedulerDispatchController',
    file: 'scheduler/scheduler.controller.ts',
    protection: 'shared-secret',
    reason: 'Тик pg_cron: SCHEDULER_DISPATCH_SECRET сверяется в контроллере. Вызывающая сторона — pg_net, не человек.',
    acceptsPublicWrites: false,
  },
  {
    controller: 'AIJobsDispatchController',
    file: 'ai-router/ai-jobs.controller.ts',
    protection: 'shared-secret',
    reason: 'Воркер асинхронной полосы: AI_JOB_DISPATCH_SECRET через safeSecretEqual.',
    acceptsPublicWrites: false,
  },
  {
    controller: 'CalibrationDispatchController',
    file: 'calibration/calibration.controller.ts',
    protection: 'shared-secret',
    reason: 'Плановый пересчёт калибровки: тот же SCHEDULER_DISPATCH_SECRET.',
    acceptsPublicWrites: false,
  },
  {
    controller: 'JobSearchInternalController',
    file: 'vacancy-intake/vacancy-intake.controller.ts',
    protection: 'shared-secret',
    reason: 'Тик повторной загрузки вакансий и приём пересланного письма: тот же SCHEDULER_DISPATCH_SECRET.',
    acceptsPublicWrites: false,
  },
  {
    controller: 'IntakeController',
    file: 'intake/intake.controller.ts',
    protection: 'shared-secret',
    reason:
      'Класс смешанный: обычные маршруты квиза под TelegramAuthGuard на уровне метода, без гварда только abandon-stale — тик pg_cron с SCHEDULER_DISPATCH_SECRET.',
    acceptsPublicWrites: false,
  },
  {
    controller: 'TelegramBotController',
    file: 'telegram-bot/telegram-bot.controller.ts',
    protection: 'shared-secret',
    reason:
      'Вебхук Telegram сверяет X-Telegram-Bot-Api-Secret-Token, служебные маршруты — x-dispatch-secret. Оба — через safeSecretEqual.',
    acceptsPublicWrites: false,
  },

  // ── Открыты по необходимости ──
  {
    controller: 'HealthzController',
    file: 'healthz/healthz.controller.ts',
    protection: 'by-necessity',
    reason: 'Проверка живости: должна отвечать даже при неработающей БД, иначе бесполезна как диагностика.',
    acceptsPublicWrites: false,
  },
  {
    controller: 'AdminAuthController',
    file: 'admin-auth/admin-auth.controller.ts',
    protection: 'by-necessity',
    reason: 'Вход в админку: маршруты, которые и выдают сессию. Гвард на них означал бы, что войти можно только уже войдя.',
    acceptsPublicWrites: false,
  },
];

/** Контроллеры, чьи маршруты записи доступны неаутентифицированной
 * стороне. Именно у них DTO обязаны быть размечены class-validator: тип
 * TypeScript исчезает при компиляции и снаружи не проверяет ничего. */
export function surfacesAcceptingPublicWrites(): string[] {
  return UNGUARDED_SURFACES.filter((s) => s.acceptsPublicWrites).map((s) => s.controller);
}

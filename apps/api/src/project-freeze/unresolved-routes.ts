// Пункт [audit-note-went-stale] 2026-09-24 — заметка о проверке разошлась
// с проверкой.
//
// ЧТО ЗДЕСЬ ЗАПИСАНО. `ProjectFrozenGuard` находит проект ПО URL и
// ОТКАЗЫВАЕТ В ЗАМОРОЗКЕ ТОЛЬКО ТОГДА, КОГДА НАШЁЛ. Не нашёл — пропускает
// (`parseDomainRoute` вернул null → `return true`). Это правильное
// решение: guard не знает, есть ли у маршрута проект вообще, и запрещать
// на всякий случай значило бы ломать создание проектов и сущности без
// них. Но у правильного решения есть цена: КАЖДЫЙ маршрут, который guard
// не резолвит, проходит мимо заморозки, и знать о них надо поимённо.
//
// НАЙДЕННОЕ. Шапка самого guard'а говорит: «сверены все 154 мутирующих
// маршрута доменов… три маршрута он не резолвит в принципе». Сегодня
// мутирующих маршрутов под guard'ом 161, а не резолвится ШЕСТНАДЦАТЬ.
// Ни одного живого обхода при этом нет — все шестнадцать объяснимы, и
// объяснения перечислены ниже. Дефект не в поведении, а в том, что
// УТВЕРЖДЕНИЕ О ПРОВЕРКЕ, записанное внутри самой проверки, перестало
// быть правдой, и ничто этого не заметило.
//
// ПОЧЕМУ ЭТО НЕ МЕЛОЧЬ ДЛЯ ЭТОГО ПРОЕКТА. Заметка в шапке guard'а — это
// ровно то, что читает следующий человек, решая, надо ли ему что-то
// проверять. «Сверены все 154, не резолвятся три» отвечает: «за тебя уже
// посмотрели». Устаревшая заметка внутри защитного механизма работает не
// как отсутствие документации, а хуже — как ложное свидетельство о
// проверке. Это тот же класс, что разбирался в [log-says-we-saw-it]:
// утверждение, которого никто не наблюдал.
//
// И ОДИН РАЗ ЭТО УЖЕ ЗАМЕТИЛИ. В `hiring-extras.service.ts` стоит
// комментарий: «Прошлая сверка заморозки перебирала маршруты С guard'ом
// и этот контроллер не увидела вовсе: у публичного контроллера guard'а
// нет по определению». То есть изъян МЕТОДА был найден — и залатан в
// одном месте, а метод остался ручным.
//
// ЧТО ИЗМЕНИЛОСЬ ТЕПЕРЬ. Список ниже машинный: сверка
// `audit-2026-09-24-audit-note-went-stale.spec.ts` перечисляет маршруты
// сама и требует, чтобы множество совпало с этим файлом. Новый
// нерезолвящийся маршрут уронит её до того, как о нём напишут заметку.

/** Почему маршрут не резолвится guard'ом — и почему это законно. */
export type UnresolvedReason =
  /** Создание проекта: проекта ещё нет, замораживать нечего. */
  | 'project-being-created'
  /** Сущность без проекта (профиль кандидата, группа, согласие). */
  | 'no-project'
  /** Проект приходит ТЕЛОМ запроса или вычисляется из токена — guard
   * про него не узнает никогда. Заморозка проверяется в сервисе. */
  | 'checked-in-service'
  /** Осознанно вне заморозки: отзыв согласия и отзыв своей ссылки
   * обязаны работать всегда, иначе заморозка превращается в наказание,
   * которого никто не объявлял. */
  | 'revocation-always-allowed'
  /** Системный маршрут: не действие человека, а тик планировщика или
   * приёмник бота, за секретом рассылки. */
  | 'system-dispatch';

export interface UnresolvedRoute {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  reason: UnresolvedReason;
  /** Где заморозка проверяется вместо guard'а — обязательно для
   * `checked-in-service`, пусто для остальных. */
  checkedIn?: string;
}

/** Все мутирующие маршруты под `ProjectFrozenGuard`, которые guard НЕ
 * резолвит. Список полон — это держится сверкой, а не обещанием. */
export const UNRESOLVED_ROUTES: UnresolvedRoute[] = [
  // ── проект ещё не существует ──
  { method: 'POST', path: '/dtp/projects', reason: 'project-being-created' },
  { method: 'POST', path: '/family-law/projects', reason: 'project-being-created' },
  { method: 'POST', path: '/health/projects', reason: 'project-being-created' },
  { method: 'POST', path: '/investment/projects', reason: 'project-being-created' },
  { method: 'POST', path: '/job-search/projects', reason: 'project-being-created' },
  { method: 'POST', path: '/major-purchase/projects', reason: 'project-being-created' },
  { method: 'POST', path: '/employer-hiring/projects', reason: 'project-being-created' },

  { method: 'POST', path: '/investment/projects', reason: 'project-being-created' },
  { method: 'POST', path: '/interview-pool/projects', reason: 'project-being-created' },

  // ── сущность без проекта ──
  //
  // Три семейства названы в шапке guard'а ПОИМЁННО — «candidate-profiles,
  // recruiting-teams, investment-groups, location-consent под guard не
  // попадают: там нечего замораживать», — то есть они были ИЗВЕСТНЫ, но
  // никогда не перечислены. Разница существенная: известно «такое
  // бывает», а проверено «вот эти четырнадцать и больше ничего». Пока
  // список не перечислен, новый маршрут в том же семействе, у которого
  // проект как раз ЕСТЬ, войдёт в него незаметно.
  //
  // Принятие ссылки создаёт ПРОФИЛЬ КАНДИДАТА у принимающего — запись
  // без проекта. Замораживать нечего; доступ и согласие проверяет сервис.
  { method: 'POST', path: '/candidate-shares/:shareId/accept', reason: 'no-project' },
  { method: 'POST', path: '/candidate-profiles', reason: 'no-project' },
  { method: 'POST', path: '/candidate-profiles/:id/share', reason: 'no-project' },
  { method: 'POST', path: '/recruiting-teams', reason: 'no-project' },
  { method: 'POST', path: '/recruiting-teams/:id/invite-link', reason: 'no-project' },
  { method: 'POST', path: '/recruiting-teams/:id/join', reason: 'no-project' },
  { method: 'POST', path: '/investment-groups', reason: 'no-project' },
  { method: 'POST', path: '/investment-groups/:id/invite-link', reason: 'no-project' },
  { method: 'POST', path: '/investment-groups/:id/join', reason: 'no-project' },
  // Обязательство участника — поле у членства в группе, не данные
  // проекта: `setPledge` пишет в `InvestmentGroupMember`. Проверено, а
  // не предположено: «деньги» в названии легко принять за данные проекта.
  { method: 'POST', path: '/investment-groups/:id/pledge', reason: 'no-project' },

  // ── проект известен только сервису ──
  { method: 'POST', path: '/engagements/accept', reason: 'checked-in-service', checkedIn: 'EngagementService.accept' },
  { method: 'POST', path: '/candidate-shares/accept', reason: 'checked-in-service', checkedIn: 'CandidateSelfShareService.accept' },
  { method: 'POST', path: '/posting-review/:token/comments', reason: 'checked-in-service', checkedIn: 'VacancyPostingService.publicComment' },
  { method: 'POST', path: '/pre-questionnaire/:token', reason: 'checked-in-service', checkedIn: 'HiringExtrasService.submitPreQuestionnaire' },

  // ── отзыв обязан работать всегда ──
  { method: 'POST', path: '/job-search/self-shares/:id/revoke', reason: 'revocation-always-allowed' },
  { method: 'POST', path: '/pre-questionnaire/:token/revoke-consent', reason: 'revocation-always-allowed' },
  { method: 'POST', path: '/candidate-profiles/:id/revoke-consent', reason: 'revocation-always-allowed' },
  { method: 'POST', path: '/recruiting-teams/:id/invites/:inviteId/revoke', reason: 'revocation-always-allowed' },
  { method: 'POST', path: '/investment-groups/:id/invites/:inviteId/revoke', reason: 'revocation-always-allowed' },

  // ── не действие человека ──
  { method: 'POST', path: '/internal/job-search/refetch', reason: 'system-dispatch' },
  { method: 'POST', path: '/internal/job-search/forwarded', reason: 'system-dispatch' },

  // ── согласие, а не данные проекта ──
  { method: 'POST', path: '/major-purchase/location-consent', reason: 'no-project' },
];

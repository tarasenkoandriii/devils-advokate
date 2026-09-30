// Пункт [door-opened-onto-a-corner] 2026-09-25 — дверь открыли в угол
// комнаты.
//
// НАЙДЕНО, И ЭТО ПОПРАВКА К СОБСТВЕННОЙ ПРЕДЫДУЩЕЙ СВЕРКЕ. Пункт
// [right-with-no-door] вывел решения, принятые о человеке, на экран. Но
// запрос отбирал строки журнала по двум признакам: `resource: 'User'` с
// его идентификатором и `resource: 'Project'` среди его проектов. А
// реестр подписей `DECISION_LABELS` к тому моменту уже знал, как
// назвать словами 34 действия.
//
// МЕРА. Из 34 расшифрованных действий экран дотягивался до ДЕВЯТИ.
// Остальные лежат в журнале под другими `resource`, и среди них —
// настоящие решения о человеке: его заявку в библиотеку рассмотрели,
// его заявку заведения отклонили, рекрутер отозвал согласие на передачу
// его данных, оффер ему отозвали, принятую им ссылку на профиль
// отозвали, этап его карточки в воронке изменили.
//
// ЧЕМ ЭТО ХУЖЕ ОТСУТСТВИЯ ЭКРАНА. Пустой раздел говорит словами:
// «Решений о вашем аккаунте не принималось». Человек, чью заявку
// отклонили вчера, читает это как факт. Экран без данных молчал бы;
// экран с частью данных УТВЕРЖДАЕТ — и утверждает неправду. Это ровно
// та форма дефекта, вокруг которой построен продукт: пробел, который
// выглядит как полнота, и сделал его я, закрывая соседний пробел.
//
// РЕШЕНИЕ. Область журнала описана реестром, а не выражением в запросе:
// для каждого вида записи сказано, КАК найти строки этого человека, и
// отдельно перечислено, что в область НЕ входит и почему. Новая подпись
// в `DECISION_LABELS` без записи здесь роняет проверку — иначе
// следующее действие так же тихо выпадет с экрана.
//
// ЧЕСТНАЯ ГРАНИЦА. «Решение о вас» — это то, что сделала ДРУГАЯ
// сторона. Собственные действия человека (запрошена расшифровка,
// озвучен текст, построена выгрузка) в журнале тоже есть, и их здесь
// намеренно нет: это не решения о нём, а его же работа, и при потолке в
// 200 строк они вытеснили бы с экрана то, ради чего экран заведён.

import type { PrismaService } from '../prisma/prisma.service';

/** Вид записи в журнале и способ найти строки ЭТОГО человека. */
export interface DecisionScope {
  /** `resource`, как он записан в журнале. */
  resource: string;
  /** В какую группу на экране попадает. */
  group: 'account' | 'project' | 'belongings';
  /** Почему решение об этой записи — решение о человеке. */
  why: string;
  /** Идентификаторы записей этого человека. */
  ownIds(prisma: PrismaService, userId: string): Promise<string[]>;
}

/** Вид записи, которого в области НЕТ, и причина. Список существует,
 * чтобы «не показываем» было решением, а не упущением. */
export interface DecisionOutOfScope {
  resource: string;
  why: string;
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

export const DECISION_SCOPES: readonly DecisionScope[] = [
  {
    resource: 'User',
    group: 'account',
    why: 'ограничение доступа, блокировка, удаление — решения о самом человеке',
    ownIds: async (_prisma, userId) => [userId],
  },
  {
    resource: 'Project',
    group: 'project',
    why: 'заморозка, разморозка, открытие карточки оператором — решения о его работе',
    ownIds: async (prisma, userId) =>
      ids(await prisma.project.findMany({ where: { ownerId: userId }, select: { id: true } })),
  },
  {
    resource: 'LibraryEntry',
    group: 'belongings',
    why: 'его заявку в библиотеку разборов рассмотрел оператор',
    ownIds: async (prisma, userId) =>
      ids(await prisma.libraryEntry.findMany({ where: { submittedByUserId: userId }, select: { id: true } })),
  },
  {
    resource: 'VenueApplication',
    group: 'belongings',
    why: 'его заявку заведения одобрили или отклонили',
    ownIds: async (prisma, userId) =>
      ids(await prisma.venueApplication.findMany({ where: { submittedByUserId: userId }, select: { id: true } })),
  },
  {
    resource: 'CandidateProfile',
    group: 'belongings',
    why: 'согласие на передачу его данных отозвано, уведомление о применении AI отмечено показанным',
    ownIds: async (prisma, userId) =>
      ids(await prisma.candidateProfile.findMany({ where: { ownerUserId: userId }, select: { id: true } })),
  },
  {
    resource: 'CandidatePipelineStatus',
    group: 'belongings',
    why: 'его карточку добавили в проект найма, объединили с другой, сменили этап',
    ownIds: async (prisma, userId) =>
      ids(
        await prisma.candidatePipelineStatus.findMany({
          where: { candidateProfile: { ownerUserId: userId } },
          select: { id: true },
        }),
      ),
  },
  {
    resource: 'CandidateShare',
    group: 'belongings',
    why: 'переданную им ссылку на профиль приняли или отозвали',
    ownIds: async (prisma, userId) =>
      ids(await prisma.candidateShare.findMany({ where: { sharedByUserId: userId }, select: { id: true } })),
  },
  {
    resource: 'TermsSheet',
    group: 'belongings',
    why: 'рекрутер отметил, что отправил письмо-статус по его листу условий',
    ownIds: async (prisma, userId) =>
      ids(await prisma.termsSheet.findMany({ where: { project: { ownerId: userId } }, select: { id: true } })),
  },
  {
    resource: 'OfferDocument',
    group: 'belongings',
    why: 'оффер по его листу условий отправлен или отозван',
    ownIds: async (prisma, userId) =>
      ids(
        await prisma.offerDocument.findMany({
          where: { sheet: { project: { ownerId: userId } } },
          select: { id: true },
        }),
      ),
  },
  {
    resource: 'EmployerAgencyEngagement',
    group: 'belongings',
    why: 'заказ по его проекту найма принят агентством или отозван',
    ownIds: async (prisma, userId) =>
      ids(
        await prisma.employerAgencyEngagement.findMany({
          where: { employerProject: { ownerId: userId } },
          select: { id: true },
        }),
      ),
  },
];

export const DECISIONS_OUT_OF_SCOPE: readonly DecisionOutOfScope[] = [
  {
    resource: 'ApprovedVenue',
    why: 'запись принадлежит заведению, а не человеку: связи с пользователем у неё в схеме нет, и приписать её кому-то по догадке значило бы показать человеку чужое решение как решение о нём',
  },
  {
    resource: 'PromptVersion',
    why: 'внутреннее изменение продукта (какая версия промпта активна), а не решение о человеке; в журнал пишется ради воспроизводимости разборов',
  },
  {
    resource: 'AIJob',
    why: 'единственная запись этого вида появляется В МОМЕНТ удаления аккаунта, когда показывать её уже некому; она остаётся в журнале намеренно и видна в выгрузке того, кто запросит её у поддержки',
  },
  {
    resource: 'Conversation',
    why: 'запрошенная расшифровка — собственное действие человека, а не решение о нём; при потолке в 200 строк такие записи вытеснили бы с экрана решения, ради которых он заведён',
  },
  {
    resource: 'TtsCache',
    why: 'озвучка текста — тоже собственное действие; вдобавок строка кэша адресуется хэшом текста, а не человеком',
  },
];

/** Виды записей одной группы и все идентификаторы человека в них.
 *
 * Один запрос к журналу на группу, а не на вид: у группы один потолок и
 * один честный признак «есть ещё». */
export async function ownScopeIds(
  prisma: PrismaService,
  userId: string,
  group: DecisionScope['group'],
): Promise<Array<{ resource: string; resourceId: { in: string[] } }>> {
  const scopes = DECISION_SCOPES.filter((s) => s.group === group);
  const resolved = await Promise.all(scopes.map((s) => s.ownIds(prisma, userId)));
  return scopes
    .map((s, i) => ({ resource: s.resource, resourceId: { in: resolved[i] } }))
    .filter((w) => w.resourceId.in.length > 0);
}

// ── Пункт [operator-left-a-trace-unsaid] 2026-09-25 ──
//
// Вид записи журнала для каждого действия. Карта жила в спеке, и это было
// не то место: по ней считается, УВИДИТ ЛИ ЧЕЛОВЕК решение оператора, а
// такой ответ нужен самому продукту — экрану оператора, — а не только
// проверке. Догадываться о виде по имени действия нельзя:
// `candidate.merged` пишется на `CandidatePipelineStatus`, а не на
// `Candidate`. Полнота карты проверяется против реестра подписей.
export const DECISION_RESOURCE: Record<string, string> = {
  'user.restricted': 'User',
  'user.unrestricted': 'User',
  'user.blocked': 'User',
  'user.unblocked': 'User',
  'user.deleted': 'User',
  'user.deleted.ai_scrub_failed': 'AIJob',
  'project.frozen': 'Project',
  'project.unfrozen': 'Project',
  'admin.project_card.viewed': 'Project',
  'bias_export.generated': 'Project',
  'library_entry.moderated': 'LibraryEntry',
  'venue_application.approved': 'VenueApplication',
  'venue_application.rejected': 'VenueApplication',
  'approved_venue.priority_partner_set': 'ApprovedVenue',
  'approved_venue.referral_fee_set': 'ApprovedVenue',
  'candidate.added_to_project': 'CandidatePipelineStatus',
  'candidate.merged': 'CandidatePipelineStatus',
  'candidate_pipeline_status.stage_changed': 'CandidatePipelineStatus',
  'candidate_consent.revoked_by_candidate': 'CandidateProfile',
  'candidate_consent.revoked_by_recruiter': 'CandidateProfile',
  'candidate_self_share.accepted': 'CandidateShare',
  'candidate_self_share.revoked': 'CandidateShare',
  'engagement.accepted': 'EmployerAgencyEngagement',
  'engagement.revoked': 'EmployerAgencyEngagement',
  'offer.shared_to_candidate': 'OfferDocument',
  'offer.withdrawn': 'OfferDocument',
  'status_letter.marked_sent_by_recruiter': 'TermsSheet',
  'status_letter.sent': 'TermsSheet',
  'ai_notice.marked_shown_by_recruiter': 'CandidateProfile',
  'ai_notice.shown': 'CandidateProfile',
  'prompt_version.promoted_to_active': 'PromptVersion',
  'prompt_version.rolled_back': 'PromptVersion',
  'transcription.requested': 'Conversation',
  'tts.synthesized': 'TtsCache',
  'places.request': 'GooglePlaces',
  'photo_verification.requested': 'PersonFact',
  'stt.realtime_token': 'SttRealtimeToken',
  'geocoding.request': 'Nominatim',
  'weather.forecast': 'WeatherForecast',
  'fact_check.request': 'FactCheck',
};

/** Увидит ли человек это решение в Центре приватности.
 *
 * Не «есть ли подпись» и не «пишется ли в журнал» — именно доходит ли
 * запись до его экрана. Ответ считается из тех же двух реестров, что
 * питают сам экран, поэтому разойтись с ним он не может. */
export function visibleToPerson(action: string): boolean {
  const resource = DECISION_RESOURCE[action];
  if (!resource) return false;
  return DECISION_SCOPES.some((s) => s.resource === resource);
}

/** Почему не видно — словами из реестра невходящего, или null. */
export function whyNotVisible(action: string): string | null {
  const resource = DECISION_RESOURCE[action];
  if (!resource) return 'вид записи для этого действия не описан — считаем, что человеку оно не показывается, и это повод описать его';
  if (DECISION_SCOPES.some((s) => s.resource === resource)) return null;
  const named = DECISIONS_OUT_OF_SCOPE.find((s) => s.resource === resource);
  return named ? named.why : 'вид записи не назван ни входящим, ни невходящим — пробел в реестре';
}

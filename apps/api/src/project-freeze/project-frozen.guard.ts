// ТЗ domain-ui-and-voice-intake §1.4 — заморозка проекта оператором.
//
// Почему guard, а не проверка в сервисах: у шести доменов ~30 своих
// assertOwned*-хелперов, которыми пользуются и чтения; вносить в каждый
// мутирующий метод отдельную проверку — ровно тот класс «забыли одно
// место», который ловят аудиты. Один guard на мутирующих роутах доменных
// контроллеров: HTTP-метод ≠ GET → находим проект по параметру маршрута
// по таблице ниже → 423 Locked, если Project.frozenAt установлен.
//
// Честная граница: сущности БЕЗ привязки к проекту (candidate-profiles,
// recruiting-teams, investment-groups, location-consent) под guard не
// попадают — там нечего замораживать. Чтения остаются доступны:
// пользователь видит свои данные, но не может их менять.
//
// АУДИТ ЗАМОРОЗКИ 2026-09-03 — сверены все 154 мутирующих маршрута доменов.
//
// ═══ ПОПРАВКА, Пункт [audit-note-went-stale] 2026-09-24 ═══
//
// АБЗАЦ НИЖЕ БЫЛ НЕПРАВДОЙ К ЭТОЙ ДАТЕ, и это важнее, чем звучит.
// Он говорил: «три маршрута он не резолвит в принципе». Машинный перебор
// показал: мутирующих маршрутов под guard'ом 161, не резолвится ТРИДЦАТЬ.
//
// Живого обхода заморозки при этом НЕТ — все тридцать объяснимы, и
// объяснения теперь перечислены поимённо в `unresolved-routes.ts`.
// Семнадцать из них — семейства, названные в абзаце про «сущности без
// проекта» тут же выше: они были ИЗВЕСТНЫ, но не перечислены, а разница
// существенная — известно «такое бывает», проверено «вот эти и больше
// ничего».
//
// Дефект был не в поведении, а в том, что УТВЕРЖДЕНИЕ О ПРОВЕРКЕ,
// записанное внутри самой проверки, перестало быть правдой и ничто этого
// не заметило. Для следующего человека «сверены все 154, не резолвятся
// три» читается как «за тебя уже посмотрели»: устаревшая заметка в
// защитном механизме работает хуже, чем её отсутствие.
//
// Теперь список держит сверка `audit-2026-09-24-audit-note-went-stale`:
// новый нерезолвящийся маршрут уронит её ДО того, как о нём напишут
// заметку. Числа из абзаца ниже намеренно оставлены как были — это
// запись о том, что видели тогда, а не утверждение о сегодняшнем дне.
//
// ═══ конец поправки ═══
//
// ═══ ПОПРАВКА, Пункт [freeze-stopped-only-the-hands] 2026-09-25 ═══
//
// ГРАНИЦА ЭТОГО GUARD'А — HTTP, И ЭТО НЕ ВСЯ ЗАМОРОЗКА. Ответ, который
// читает человек, говорит: «Проект заморожен оператором… ИЗМЕНЕНИЯ
// НЕДОСТУПНЫ, просмотр — да». Это утверждение о ПРОЕКТЕ, а guard
// отвечает только за маршруты. Фоновая работа (pg_cron) про заморозку не
// знала ничего: задача к модели, поставленная в очередь до заморозки,
// уходила провайдеру после неё, и вакансии под слежением продолжали
// перечитываться. То есть изменения шли — просто не человеческой рукой.
//
// Решение по каждой фоновой задаче и обе стороны границы —
// `frozen-background.ts`; список держится тестом против реестра
// cron-задач, иначе новая фоновая задача появится без решения.
//
// ═══ конец поправки ═══
//
// Guard стоит на каждом контроллере; три маршрута он не резолвит в принципе,
// и вот что с каждым:
//   • POST /engagements/accept и POST /job-search/accept — проект-получатель
//     приходит ТЕЛОМ запроса, в адресе его нет. Проверка перенесена в
//     сервисы (assert-not-frozen.ts): писать в замороженный проект нельзя
//     ни его владельцу, ни второй стороне.
//   • POST /major-purchase/location-consent — согласие, а не данные проекта;
//     сознательно вне заморозки (см. абзац выше про сущности без проекта).
//   • POST /job-search/self-shares/:id/revoke — ОТЗЫВ собственного шеринга.
//     Раньше он проходил при заморозке случайно (маршрут не резолвился);
//     теперь это решение: отзыв согласия и отзыв ссылки на свои данные
//     обязаны работать всегда. Заморозка запрещает менять проект, а не
//     запирает человека в уже сделанной передаче — иначе она превращается
//     в наказание, которого никто не объявлял. Держится тестом.
import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export class ProjectFrozenException extends HttpException {
  /** overrideMessage — для второй стороны (аудит 2026-09-03): она узнаёт,
   * что передача не состоялась, но не узнаёт про модерационный статус
   * чужого проекта. См. assert-not-frozen.ts. */
  constructor(note: string | null, overrideMessage?: string) {
    super(
      {
        message: overrideMessage ?? `Проект заморожен оператором${note ? `: ${note}` : ''}. Изменения недоступны, просмотр — да.`,
        code: 'PROJECT_FROZEN',
      },
      423 /* Locked — нет в HttpStatus этой версии Nest */,
    );
  }
}

type Resolver = (prisma: PrismaService, id: string) => Promise<string | null>;

const viaConfig = (model: string): Resolver => async (p, id) => {
  const row = await (p as any)[model].findUnique({ where: { id }, select: { projectId: true } });
  return row?.projectId ?? null;
};
const viaParentConfig = (model: string, parent: string): Resolver => async (p, id) => {
  const row = await (p as any)[model].findUnique({ where: { id }, select: { [parent]: { select: { config: { select: { projectId: true } } } } } });
  return row?.[parent]?.config?.projectId ?? null;
};
const viaEntityConfig = (model: string): Resolver => async (p, id) => {
  const row = await (p as any)[model].findUnique({ where: { id }, select: { config: { select: { projectId: true } } } });
  return row?.config?.projectId ?? null;
};
const viaProjectId = (model: string): Resolver => viaConfig(model);
const conversation: Resolver = async (p, id) => {
  const row = await p.conversation.findUnique({ where: { id }, select: { projectId: true } });
  return row?.projectId ?? null;
};

/** prefix (первый сегмент пути после домена) → как из :id получить projectId. */
const RESOLVERS: Record<string, Record<string, Resolver>> = {
  dtp: {
    'onboarding-conversations': conversation,
    configs: viaConfig('dtpConfig'),
    advisors: viaEntityConfig('dtpAdvisor'),
    consultations: viaParentConfig('dtpConsultation', 'advisor'),
    participants: viaEntityConfig('dtpParticipant'),
    evidence: viaEntityConfig('dtpEvidenceItem'),
  },
  'family-law': {
    'onboarding-conversations': conversation,
    configs: viaConfig('familyLawConfig'),
    advisors: viaEntityConfig('familyLawAdvisor'),
    consultations: viaParentConfig('familyLawConsultation', 'advisor'),
  },
  health: {
    'onboarding-conversations': conversation,
    configs: viaConfig('healthConfig'),
    providers: viaEntityConfig('healthProvider'),
    consultations: viaParentConfig('healthConsultation', 'provider'),
    'lab-documents': viaEntityConfig('healthLabDocumentDraft'),
  },
  investment: {
    'onboarding-conversations': conversation,
    configs: viaConfig('investmentConfig'),
    opportunities: viaEntityConfig('investmentOpportunity'),
    meetings: viaParentConfig('investmentMeeting', 'opportunity'),
  },
  'major-purchase': {
    'onboarding-conversations': conversation,
    configs: viaConfig('majorPurchaseConfig'),
    variants: viaEntityConfig('purchaseVariant'),
    meetings: viaParentConfig('purchaseMeeting', 'variant'),
  },
  'interview-pool': {
    'onboarding-conversations': conversation,
    'pipeline-statuses': viaProjectId('candidatePipelineStatus'),
  },
  // Пункт [job-search] 2026-09-01 — домен кандидата.
  'job-search': {
    'onboarding-conversations': conversation,
    configs: viaConfig('jobSearchConfig'),
    vacancies: viaEntityConfig('jobVacancy'),
    'terms-sheets': viaProjectId('termsSheet'), // [job-domain-v2] самошеринг
    'vacancy-candidates': viaEntityConfig('vacancyCandidate'),
  },
  // Пункт [job-domain-v2] §7 — поддомен работодателя (тот же общий слой).
  'employer-hiring': {
    'onboarding-conversations': conversation,
  },
  'client-reports': {
    '': viaProjectId('clientReport'), // /client-reports/:id/...
  },
  // Пункт [job-domain-v2] — лист условий и связки трёх поддоменов найма.
  // Плоские маршруты /<domain>/:id/... (как client-reports) плюс
  // вложенные /<domain>/<kind>/:id/....
  'terms-sheets': {
    '': viaProjectId('termsSheet'),
    'from-vacancy': viaEntityConfig('jobVacancy'),
    'from-candidate': viaProjectId('candidatePipelineStatus'),
  },
  'cv-variants': {
    '': async (p, id) => {
      const row = await p.cvVariant.findUnique({ where: { id }, select: { sheet: { select: { projectId: true } } } });
      return row?.sheet?.projectId ?? null;
    },
  },
  offers: {
    '': async (p, id) => {
      const row = await p.offerDocument.findUnique({ where: { id }, select: { sheet: { select: { projectId: true } } } });
      return row?.sheet?.projectId ?? null;
    },
  },
  'vacancy-postings': {
    '': viaProjectId('vacancyPosting'),
    revisions: async (p, id) => {
      const row = await p.vacancyPostingRevision.findUnique({ where: { id }, select: { posting: { select: { projectId: true } } } });
      return row?.posting?.projectId ?? null;
    },
    variants: async (p, id) => {
      const row = await p.vacancyPostingVariant.findUnique({ where: { id }, select: { posting: { select: { projectId: true } } } });
      return row?.posting?.projectId ?? null;
    },
  },
  'client-briefs': {
    '': viaProjectId('clientBrief'),
  },
  'employer-dossiers': {
    '': viaProjectId('employerDossier'),
    representatives: async (p, id) => {
      const row = await p.employerRepresentativeClaim.findUnique({ where: { id }, select: { dossier: { select: { projectId: true } } } });
      return row?.dossier?.projectId ?? null;
    },
  },
  engagements: {
    '': async (p, id) => {
      const row = await p.employerAgencyEngagement.findUnique({ where: { id }, select: { employerProjectId: true } });
      return row?.employerProjectId ?? null;
    },
  },
};

/** Домены с плоским маршрутом /<domain>/:id/... — второй сегмент — это id,
 * если он не «projects» и не зарегистрированный kind. */
const FLAT_DOMAINS = new Set(Object.keys(RESOLVERS).filter((d) => '' in RESOLVERS[d]));

/** Чистая функция — по URL находит (domain, kind, id) для таблицы выше.
 * Экспортирована ради тестов. */
export function parseDomainRoute(path: string): { domain: string; kind: string; id: string } | null {
  const segs = path.split('?')[0].split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const domain = segs[0];
  if (!RESOLVERS[domain]) return null;
  // /<domain>/projects/:projectId/... → сам проект
  if (segs[1] === 'projects' && segs[2]) return { domain, kind: 'projects', id: segs[2] };
  if (segs[2] && RESOLVERS[domain][segs[1]]) return { domain, kind: segs[1], id: segs[2] };
  // /client-reports/:id/..., /terms-sheets/:id/..., /offers/:id/... — плоские домены
  if (FLAT_DOMAINS.has(domain)) return segs[1] && segs[1] !== 'projects' && segs[1] !== 'accept' ? { domain, kind: '', id: segs[1] } : null;
  return null;
}

@Injectable()
export class ProjectFrozenGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ method: string; url: string; originalUrl?: string }>();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
    const parsed = parseDomainRoute(req.originalUrl ?? req.url);
    if (!parsed) return true; // сущность без проекта или создание проекта — нечего замораживать
    const projectId = parsed.kind === 'projects' ? parsed.id : await RESOLVERS[parsed.domain][parsed.kind](this.prisma, parsed.id);
    if (!projectId) return true; // владение/существование проверит сервис (404), не guard
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { frozenAt: true, frozenNote: true } });
    if (project?.frozenAt) throw new ProjectFrozenException(project.frozenNote);
    return true;
  }
}

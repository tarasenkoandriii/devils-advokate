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
import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export class ProjectFrozenException extends HttpException {
  constructor(note: string | null) {
    super({ message: `Проект заморожен оператором${note ? `: ${note}` : ''}. Изменения недоступны, просмотр — да.`, code: 'PROJECT_FROZEN' }, 423 /* Locked — нет в HttpStatus этой версии Nest */);
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
  'client-reports': {
    '': viaProjectId('clientReport'), // /client-reports/:id/...
  },
};

/** Чистая функция — по URL находит (domain, kind, id) для таблицы выше.
 * Экспортирована ради тестов. */
export function parseDomainRoute(path: string): { domain: string; kind: string; id: string } | null {
  const segs = path.split('?')[0].split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const domain = segs[0];
  if (!RESOLVERS[domain]) return null;
  // /<domain>/projects/:projectId/... → сам проект
  if (segs[1] === 'projects' && segs[2]) return { domain, kind: 'projects', id: segs[2] };
  // /client-reports/:id/...
  if (domain === 'client-reports') return segs[1] && segs[1] !== 'projects' ? { domain, kind: '', id: segs[1] } : null;
  if (segs[2] && RESOLVERS[domain][segs[1]]) return { domain, kind: segs[1], id: segs[2] };
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

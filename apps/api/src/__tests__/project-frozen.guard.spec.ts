// ТЗ domain-ui-and-voice-intake §1.4 — заморозка проекта: guard на
// мутирующих роутах доменных контроллеров.
import { ProjectFrozenGuard, ProjectFrozenException, parseDomainRoute } from '../project-freeze/project-frozen.guard';

function ctx(method: string, url: string) {
  return { switchToHttp: () => ({ getRequest: () => ({ method, url, originalUrl: url }) }) } as any;
}

function createFakePrisma(frozenProjects: Record<string, string | null>) {
  const project = (id: string) => (id in frozenProjects ? { frozenAt: frozenProjects[id] ? new Date() : null, frozenNote: frozenProjects[id] } : null);
  return {
    project: { findUnique: async ({ where }: any) => project(where.id) },
    conversation: { findUnique: async ({ where }: any) => (where.id === 'conv-frozen' ? { projectId: 'p-frozen' } : where.id === 'conv-ok' ? { projectId: 'p-ok' } : null) },
    dtpConfig: { findUnique: async ({ where }: any) => (where.id === 'cfg-frozen' ? { projectId: 'p-frozen' } : null) },
    dtpAdvisor: { findUnique: async ({ where }: any) => (where.id === 'adv-frozen' ? { config: { projectId: 'p-frozen' } } : null) },
    dtpConsultation: { findUnique: async ({ where }: any) => (where.id === 'cons-frozen' ? { advisor: { config: { projectId: 'p-frozen' } } } : null) },
    clientReport: { findUnique: async ({ where }: any) => (where.id === 'rep-frozen' ? { projectId: 'p-frozen' } : null) },
  };
}

describe('parseDomainRoute (чистая функция)', () => {
  it('разбирает projects/:id, configs/:id, вложенные сущности и client-reports/:id', () => {
    expect(parseDomainRoute('/dtp/projects/p1/config')).toEqual({ domain: 'dtp', kind: 'projects', id: 'p1' });
    expect(parseDomainRoute('/dtp/configs/c1/advisors')).toEqual({ domain: 'dtp', kind: 'configs', id: 'c1' });
    expect(parseDomainRoute('/health/consultations/x/review?y=1')).toEqual({ domain: 'health', kind: 'consultations', id: 'x' });
    expect(parseDomainRoute('/client-reports/r1/send')).toEqual({ domain: 'client-reports', kind: '', id: 'r1' });
    expect(parseDomainRoute('/client-reports/projects/p1/summary')).toEqual({ domain: 'client-reports', kind: 'projects', id: 'p1' }); // создание отчёта тоже блокируется
    expect(parseDomainRoute('/interview-pool/pipeline-statuses/s1/stage-progress')).toEqual({ domain: 'interview-pool', kind: 'pipeline-statuses', id: 's1' });
  });
  it('возвращает null для создания проекта, сущностей без проекта и чужих доменов', () => {
    expect(parseDomainRoute('/dtp/projects')).toBeNull();
    expect(parseDomainRoute('/candidate-profiles')).toBeNull();
    expect(parseDomainRoute('/recruiting-teams/t1/join')).toBeNull();
    expect(parseDomainRoute('/major-purchase/location-consent')).toBeNull();
    expect(parseDomainRoute('/projects/p1/arguments')).toBeNull(); // универсальный сценарий — не под guard
  });
});

describe('ProjectFrozenGuard', () => {
  const prisma = createFakePrisma({ 'p-frozen': 'спор в суде', 'p-ok': null });
  const guard = new ProjectFrozenGuard(prisma as any);

  it('GET всегда пропускается, даже для замороженного проекта', async () => {
    await expect(guard.canActivate(ctx('GET', '/dtp/projects/p-frozen/config'))).resolves.toBe(true);
  });

  it('POST на замороженный проект — 423 с заметкой оператора; на обычный — пропуск', async () => {
    await expect(guard.canActivate(ctx('POST', '/dtp/projects/p-frozen/config'))).rejects.toThrow(ProjectFrozenException);
    await expect(guard.canActivate(ctx('POST', '/dtp/projects/p-frozen/config'))).rejects.toMatchObject({ status: 423 });
    await expect(guard.canActivate(ctx('POST', '/dtp/projects/p-ok/config'))).resolves.toBe(true);
  });

  it('резолвит проект через конфиг, сущность, вложенную сессию и отчёт', async () => {
    for (const url of ['/dtp/configs/cfg-frozen/advisors', '/dtp/advisors/adv-frozen/consultations', '/dtp/consultations/cons-frozen/review', '/dtp/onboarding-conversations/conv-frozen/answers', '/client-reports/rep-frozen/send']) {
      await expect(guard.canActivate(ctx('POST', url))).rejects.toThrow(ProjectFrozenException);
    }
    await expect(guard.canActivate(ctx('POST', '/dtp/onboarding-conversations/conv-ok/answers'))).resolves.toBe(true);
  });

  it('несуществующая сущность — пропуск (404 отдаст сервис, guard не подменяет владение)', async () => {
    await expect(guard.canActivate(ctx('PATCH', '/dtp/configs/nope/goal'))).resolves.toBe(true);
  });
});

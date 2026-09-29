// Пункт [job-domain-v2] — песочница найма v2: те же продовые сервисы, от имени
// оператора, без обходов проверок; подтверждение черновиков — отдельный шаг.
import { ForbiddenException } from '@nestjs/common';
import { AdminSandboxHiringService } from '../admin-sandbox/admin-sandbox-hiring.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService, TERMS_CLAUSES_EXTRACT_TASK_TYPE, TERMS_MATCH_TASK_TYPE } from '../terms-sheet/terms-matching.service';
import { HiringExtrasService } from '../hiring-extras/hiring-extras.service';
import { EmployerHiringService } from '../employer-hiring/employer-hiring.service';
import { EmployerDossierService } from '../employer-dossier/employer-dossier.service';
import { ClientBriefService } from '../client-brief/client-brief.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';

jest.mock('../common/safe-url-fetch', () => ({ fetchUrlText: jest.fn(async () => ({ text: '', finalUrl: '' })) }));

const VACANCY_TEXT = 'Ищем Backend-разработчика. Нужен опыт с Node.js от 3 лет. Формат: удалённо.';

function setup() {
  const prisma = createHiringFakePrisma();
  const router = createFakeRouter((req) => {
    if (req.taskType === TERMS_CLAUSES_EXTRACT_TASK_TYPE) {
      return JSON.stringify({ clauses: [{ kind: 'REQUIREMENT', text: 'Опыт Node.js от 3 лет', category: 'роль', isRequired: true, quote: 'опыт с Node.js от 3 лет' }, { kind: 'CONDITION', text: 'Удалённо', category: 'условия', isRequired: false, quote: 'Формат: удалённо' }] });
    }
    if (req.taskType === TERMS_MATCH_TASK_TYPE) {
      const ids = [...req.userPrompt.matchAll(/\[id=([^\]]+)\] \((EMPLOYER|CANDIDATE), (REQUIREMENT|CONDITION)/g)].map((m: any) => [m[1], m[3]]);
      return JSON.stringify({ positions: ids.map(([id, kind]: any) => ({ clauseId: id, coverage: kind === 'REQUIREMENT' ? 'covered' : null, stance: kind === 'CONDITION' ? 'accepted' : null, note: 'n', evidenceRef: null, evidenceQuote: 'Node.js' })) });
    }
    return '{}';
  });
  const matching = new TermsMatchingService(prisma as any, router as any);
  const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
  const briefs = new ClientBriefService(prisma as any, router as any, sheets, matching);
  const dossiers = new EmployerDossierService(prisma as any, router as any, fakeAudit as any);
  const employer = new EmployerHiringService(prisma as any, briefs);
  const extras = new HiringExtrasService(prisma as any, router as any, fakeAudit as any, sheets, matching);
  const svc = new AdminSandboxHiringService(prisma as any, sheets, matching, {} as any, employer, dossiers, briefs, {} as any, extras, {} as any, {} as any);
  prisma.seed('user', { id: 'op', isOperator: true });
  prisma.seed('user', { id: 'u1', isOperator: false });
  return { prisma, svc, sheets };
}

describe('AdminSandboxHiringService', () => {
  it('не оператор → 403 на любом шаге', async () => {
    const { svc } = setup();
    await expect(svc.openForVacancy('u1', 'v')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.ehCreateProject('u1', 'x')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('лист по вакансии: открытие → сводка с черновиками; подтверждение — отдельным шагом; повтор возобновляет тот же лист', async () => {
    const { prisma, svc } = setup();
    const project = prisma.seed('project', { ownerId: 'op', mode: 'JOB_SEARCH' });
    const config = prisma.seed('jobSearchConfig', { projectId: project.id, desiredRole: 'Backend', cvDraft: null });
    prisma.seed('jobSearchCriterion', { configId: config.id, text: 'Удалённая работа', category: 'LOCATION', isRequired: true, orderIndex: 0 });
    const vacancy = prisma.seed('jobVacancy', { configId: config.id, sourceUrl: 'https://work.ua/1', siteHost: 'work.ua', rawText: VACANCY_TEXT, title: 'Backend', duplicateOfId: null });

    const opened = await svc.openForVacancy('op', vacancy.id);
    expect(opened.resumed).toBe(false);
    expect(opened.kind).toBe('VACANCY_RESPONSE');
    expect(opened.clauses).toEqual({ employer: 0, candidate: 1, drafts: 2, rejected: 0 });

    const again = await svc.openForVacancy('op', vacancy.id);
    expect(again.resumed).toBe(true);
    expect(again.sheetId).toBe(opened.sheetId);

    const confirmed = await svc.confirmAllDrafts('op', opened.sheetId);
    expect(confirmed.clausesConfirmed).toBe(2);
    expect(confirmed.clauses.employer).toBe(2);
    expect(confirmed.clauses.drafts).toBe(0);

    const proposed = await svc.propose('op', opened.sheetId, 'Оффер: Node.js от 3 лет подтверждаем, удалённо', 'OFFER_TEXT' as any, 'EMPLOYER' as any);
    expect(proposed.proposed).toBeGreaterThan(0);
    expect(proposed.positions.drafts).toBe(proposed.proposed);
    // ни одного числа по человеку в сводке
    expect(Object.keys(proposed)).not.toEqual(expect.arrayContaining(['score', 'rank', 'fit']));
  });

  it('работодатель: проект-черновик → бриф до компании 409 COMPANY_REQUIRED → компания → бриф даёт черновики пунктов листа вакансии', async () => {
    const { svc } = setup();
    const created = await svc.ehCreateProject('op', 'нанимаем backend');
    expect(created.draft).toBe(true);
    await expect(svc.ehBrief('op', created.projectId, VACANCY_TEXT)).rejects.toMatchObject({ response: { code: 'COMPANY_REQUIRED' } });
    const company = await svc.ehIdentifyCompany('op', created.projectId, { legalName: 'ТОВ Ромашка', registryCode: '12345678' });
    expect(company.draft).toBe(false);
    const brief = await svc.ehBrief('op', created.projectId, VACANCY_TEXT);
    expect(brief.proposedClauses).toBe(2);
    expect(brief.kind).toBe('VACANCY');
    expect(brief.clauses.drafts).toBe(2);
    const state = await svc.ehState('op', created.projectId);
    expect(state.briefs).toBe(1);
  });
});

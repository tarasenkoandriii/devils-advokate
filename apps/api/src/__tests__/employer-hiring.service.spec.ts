// Пункт [job-domain-v2] — приёмка 17–28 (ядро работодателя и передачи между проектами).
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EmployerHiringService } from '../employer-hiring/employer-hiring.service';
import { EngagementService } from '../employer-hiring/engagement.service';
import { OfferExchangeService } from '../employer-hiring/offer-exchange.service';
import { CandidateSelfShareService, CONSENT_TEXT_VERSION } from '../candidate-self-share/candidate-self-share.service';
import { ClientBriefService } from '../client-brief/client-brief.service';
import { EmployerDossierService } from '../employer-dossier/employer-dossier.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService } from '../terms-sheet/terms-matching.service';
import { assertInterviewPoolProjectAccess } from '../interview-pool/interview-pool-access';
import { createHiringFakePrisma, createFakeRouter } from './fake-prisma';

process.env.TELEGRAM_BOT_USERNAME = 'devils_advocate_test_bot';

function setup(handler: (req: any) => string = () => JSON.stringify({ clauses: [], positions: [] })) {
  const prisma = createHiringFakePrisma();
  const router = createFakeRouter(handler);
  const audit = { records: [] as any[], record: async (r: any) => { audit.records.push(r); return r; } };
  const matching = new TermsMatchingService(prisma as any, router as any);
  const sheets = new TermsSheetService(prisma as any, matching, audit as any);
  const briefs = new ClientBriefService(prisma as any, router as any, sheets, matching);
  const dossiers = new EmployerDossierService(prisma as any, router as any, audit as any);
  const employer = new EmployerHiringService(prisma as any, briefs);
  const engagements = new EngagementService(prisma as any, audit as any);
  const offers = new OfferExchangeService(prisma as any, audit as any);
  const selfShare = new CandidateSelfShareService(prisma as any, audit as any, sheets);
  return { prisma, router, audit, sheets, briefs, dossiers, employer, engagements, offers, selfShare };
}

function seedTeam(prisma: any, userId: string, teamType: 'AGENCY' | 'EMPLOYER') {
  const team = prisma.seed('recruitingTeam', { name: teamType, teamType });
  prisma.seed('recruitingTeamMember', { teamId: team.id, userId, role: 'OWNER' });
  return team;
}

describe('EmployerHiringService — Р-0…Р-5', () => {
  it('приёмка 17: проект создаётся черновиком с пустым конфигом; extract/config до компании → 409 COMPANY_REQUIRED; после identify — бриф INTERNAL и пункты', async () => {
    const s = setup((req) => (req.taskType === 'terms-clauses-extract' ? JSON.stringify({ clauses: [{ kind: 'REQUIREMENT', text: 'Опыт продаж', category: 'роль', isRequired: true, quote: 'нужен продажник' }] }) : '{}'));
    const project = await s.employer.createProject('emp', 'нанимаем продажника');
    expect(project.mode).toBe('EMPLOYER_HIRING');
    expect(s.prisma.rows('interviewPoolConfig').find((c) => c.projectId === project.id)).toMatchObject({ jobTitle: '' });
    const state0 = await s.employer.getState('emp', project.id);
    expect(state0.draft).toBe(true);

    const conv = await s.employer.createOnboardingConversation('emp', project.id);
    await s.employer.appendAnswer('emp', conv.conversation.id, 'нужен продажник в B2B');
    await expect(s.employer.extract('emp', conv.conversation.id)).rejects.toMatchObject({ response: { code: 'COMPANY_REQUIRED' } });
    await expect(s.employer.updateConfig('emp', project.id, { jobTitle: 'Sales' })).rejects.toBeInstanceOf(ConflictException);

    await s.dossiers.identify('emp', project.id, { registryCode: '12345678', legalName: 'ТОВ Ромашка' });
    const res = await s.employer.extract('emp', conv.conversation.id);
    expect(res.proposedClauses).toHaveLength(1);
    expect(s.prisma.rows('clientBrief')[0]).toMatchObject({ origin: 'INTERNAL', projectId: project.id });
    const cfg = await s.employer.updateConfig('emp', project.id, { jobTitle: 'Sales', salaryRange: '1000-1500' });
    expect(cfg.jobTitle).toBe('Sales');
    const state1 = await s.employer.getState('emp', project.id);
    expect(state1.draft).toBe(false);
    expect(state1.briefs).toBe(1);
    expect(state1.vacancySheet).not.toBeNull();
  });

  it('приёмка 18: доступ по режиму — команда EMPLOYER видит проект, команда агентства к проекту работодателя не подходит, JOB_SEARCH — 404', async () => {
    const s = setup();
    const agencyTeam = seedTeam(s.prisma, 'agent', 'AGENCY');
    const employerTeam = seedTeam(s.prisma, 'hr', 'EMPLOYER');
    await expect(s.employer.createProject('agent', 'x', agencyTeam.id)).rejects.toBeInstanceOf(BadRequestException);
    const project = await s.employer.createProject('hr', 'нанимаем', employerTeam.id);
    s.prisma.seed('recruitingTeamMember', { teamId: employerTeam.id, userId: 'interviewer', role: 'MEMBER' });
    expect((await assertInterviewPoolProjectAccess(s.prisma as any, 'interviewer', project.id)).id).toBe(project.id);
    await expect(assertInterviewPoolProjectAccess(s.prisma as any, 'stranger', project.id)).rejects.toBeInstanceOf(NotFoundException);
    const js = s.prisma.seed('project', { ownerId: 'hr', mode: 'JOB_SEARCH' });
    await expect(assertInterviewPoolProjectAccess(s.prisma as any, 'hr', js.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('EngagementService — Р-15 / Р-4', () => {
  async function employerWithVacancy(s: ReturnType<typeof setup>) {
    const project = await s.employer.createProject('emp', 'нанимаем продажника');
    await s.dossiers.identify('emp', project.id, { registryCode: '12345678', legalName: 'ТОВ Ромашка' });
    await s.employer.updateConfig('emp', project.id, { jobTitle: 'Sales', salaryRange: '1000' });
    const config = s.prisma.rows('interviewPoolConfig').find((c) => c.projectId === project.id)!;
    s.prisma.seed('questionnaireItem', { configId: config.id, text: 'Опыт B2B?', orderIndex: 0, isRequired: true });
    await s.briefs.ingest('emp', project.id, { rawText: 'нужен продажник', origin: 'INTERNAL' as any });
    s.prisma.seed('complianceFlag', { configId: config.id, category: 'x', quotedText: 'до 35' });
    s.prisma.seed('conversation', { projectId: project.id, sourceType: 'AUDIO_UPLOAD' });
    const posting = s.prisma.seed('vacancyPosting', { projectId: project.id });
    s.prisma.seed('vacancyPostingRevision', { postingId: posting.id, text: 'Ищем продажника', reviewedAt: new Date() });
    return project;
  }

  it('приёмка 20/21: sharedItems — только четыре; копируются ровно они с sourceProjectId; собеседования/досье/флаги — никогда; accept без проекта создаёт пул; REVOKED останавливает новое', async () => {
    const s = setup();
    const employerProject = await employerWithVacancy(s);
    await expect(s.engagements.invite('emp', employerProject.id, { sharedItems: ['brief', 'secrets'] })).rejects.toBeInstanceOf(BadRequestException);
    const inv = await s.engagements.invite('emp', employerProject.id, { sharedItems: ['brief', 'config', 'questionnaire', 'posting'] });
    expect(inv.deepLink).toContain('eng_');

    const agencyTeam = seedTeam(s.prisma, 'agent', 'AGENCY');
    const employerTeam = seedTeam(s.prisma, 'emp2', 'EMPLOYER');
    await expect(s.engagements.accept('emp2', { token: inv.token, teamId: employerTeam.id })).rejects.toBeInstanceOf(BadRequestException);
    const accepted = await s.engagements.accept('agent', { token: inv.token, teamId: agencyTeam.id });
    expect(accepted.status).toBe('ACTIVE');
    const agencyProject = s.prisma.rows('project').find((p) => p.id === accepted.agencyProjectId)!;
    expect(agencyProject).toMatchObject({ mode: 'INTERVIEW_POOL', recruitingTeamId: agencyTeam.id });

    // что скопировано
    expect(s.prisma.rows('clientBrief').filter((b) => b.projectId === agencyProject.id)).toHaveLength(1);
    expect(s.prisma.rows('clientBrief').find((b) => b.projectId === agencyProject.id)).toMatchObject({ origin: 'FROM_EMPLOYER_PROJECT', sourceProjectId: employerProject.id });
    const agencyConfig = s.prisma.rows('interviewPoolConfig').find((c) => c.projectId === agencyProject.id)!;
    expect(agencyConfig).toMatchObject({ jobTitle: 'Sales', salaryRange: '1000' });
    expect(s.prisma.rows('questionnaireItem').filter((q) => q.configId === agencyConfig.id)).toHaveLength(1);
    expect(s.prisma.rows('vacancyPostingRevision').filter((r) => s.prisma.rows('vacancyPosting').find((p) => p.id === r.postingId)!.projectId === agencyProject.id)).toHaveLength(1);
    // что не скопировано никогда
    expect(s.prisma.rows('complianceFlag').filter((f) => f.configId === agencyConfig.id)).toHaveLength(0);
    expect(s.prisma.rows('conversation').filter((c) => c.projectId === agencyProject.id)).toHaveLength(0);
    expect(s.prisma.rows('employerDossier').filter((d) => d.projectId === agencyProject.id)).toHaveLength(0);

    // повторный accept невозможен; отзыв останавливает новое
    await expect(s.engagements.accept('agent', { token: inv.token, teamId: agencyTeam.id })).rejects.toBeInstanceOf(BadRequestException);
    await s.engagements.revoke('emp', inv.id);
    await expect(s.engagements.forwardFollowUp('emp', inv.id, { candidateProfileId: 'x', text: 'y' })).rejects.toBeInstanceOf(ForbiddenException);
    // полученное остаётся
    expect(s.prisma.rows('clientBrief').filter((b) => b.projectId === agencyProject.id)).toHaveLength(1);
  });

  it('приёмка 19/21: отчёт агентства доставляется в проект работодателя только после ревью; follow-up и комментарий к тексту идут через engagement', async () => {
    const s = setup();
    const employerProject = await employerWithVacancy(s);
    const inv = await s.engagements.invite('emp', employerProject.id, { sharedItems: ['brief'] });
    const agencyTeam = seedTeam(s.prisma, 'agent', 'AGENCY');
    const acc = await s.engagements.accept('agent', { token: inv.token, teamId: agencyTeam.id });
    const agencyProjectId = acc.agencyProjectId!;
    const candidate = s.prisma.seed('candidateProfile', { recruitingTeamId: agencyTeam.id, displayName: 'Иван' });
    s.prisma.seed('candidatePipelineStatus', { projectId: agencyProjectId, candidateProfileId: candidate.id, stage: 'INTERVIEWED' });
    const report = s.prisma.seed('clientReport', { projectId: agencyProjectId, type: 'PER_CANDIDATE', candidateProfileId: candidate.id, content: { conclusion: 'x' }, reviewedAt: null });

    await expect(s.engagements.deliverReport('agent', report.id, inv.id)).rejects.toThrow(/ревью/);
    report.reviewedAt = new Date();
    const delivered = await s.engagements.deliverReport('agent', report.id, inv.id);
    expect(delivered.deliveredToProjectId).toBe(employerProject.id);
    const seen = await s.engagements.deliveredReports('emp', employerProject.id);
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0])).not.toContain('complianceFlags');

    const fu = await s.engagements.forwardFollowUp('emp', inv.id, { candidateProfileId: candidate.id, text: 'Есть ли опыт с CRM?' });
    expect(fu.requestText).toMatch(/^\[от работодателя\]/);
    const agencyPosting = s.prisma.seed('vacancyPosting', { projectId: agencyProjectId });
    const rev = s.prisma.seed('vacancyPostingRevision', { postingId: agencyPosting.id, text: 'Текст агентства' });
    const review = await s.engagements.postingReview('emp', inv.id, { revisionId: rev.id, text: 'Уберите «молодой коллектив»' });
    expect((review.comments as any[])[0]).toMatchObject({ text: 'Уберите «молодой коллектив»', from: 'employer' });
    const view = await s.engagements.agencyPosting('emp', inv.id);
    expect(view!.revisions[0].text).toBe('Текст агентства');

    // ── Пункт [term-never-ends] 2026-09-06 ──
    //
    // `assertActive()` принимала `{ status, expiresAt }` и `expiresAt` НЕ
    // ЧИТАЛА: намерение проверить срок было записано прямо в сигнатуре,
    // проверки не было. Все три передачи через заказ шли после срока.
    const заказ = s.prisma.rows('employerAgencyEngagement').find((x: any) => x.id === inv.id)!;
    заказ.expiresAt = new Date(Date.now() - 1000);
    const report2 = s.prisma.seed('clientReport', { projectId: agencyProjectId, type: 'PER_CANDIDATE', candidateProfileId: candidate.id, content: { conclusion: 'y' }, reviewedAt: new Date() });
    await expect(s.engagements.deliverReport('agent', report2.id, inv.id)).rejects.toThrow(/Срок заказа/);
    await expect(s.engagements.forwardFollowUp('emp', inv.id, { candidateProfileId: candidate.id, text: 'ещё вопрос' })).rejects.toThrow(/Срок заказа/);
    await expect(s.engagements.postingReview('emp', inv.id, { revisionId: rev.id, text: 'ещё правка' })).rejects.toThrow(/Срок заказа/);
    // Полученное РАНЬШЕ остаётся — истечение срока не отменяет
    // доставленное, ровно как отзыв согласия не отзывает переданное.
    expect(await s.engagements.deliveredReports('emp', employerProject.id)).toHaveLength(1);
  });
});

describe('Самошеринг (К-8) и оффер копией (Р-3/Р-9)', () => {
  const vacancyText = 'Ищем Sales. Удалённо. Зарплата до 1500.';

  async function candidateWithSheet(s: ReturnType<typeof setup>) {
    const project = s.prisma.seed('project', { ownerId: 'cand', mode: 'JOB_SEARCH' });
    const config = s.prisma.seed('jobSearchConfig', { projectId: project.id, desiredRole: 'Sales', cvDraft: { headline: 'Sales-менеджер', summary: 's', skills: ['CRM'], experience: [], education: [] } });
    s.prisma.seed('jobSearchCriterion', { configId: config.id, text: 'Удалёнка', category: 'LOCATION', isRequired: true, orderIndex: 0 });
    const vacancy = s.prisma.seed('jobVacancy', { configId: config.id, sourceUrl: 'https://x', siteHost: 'x', rawText: vacancyText });
    const sheet = await s.sheets.openForVacancy('cand', vacancy.id);
    const variant = s.prisma.seed('cvVariant', { sheetId: sheet.id, lang: 'ru', highlightMap: [], cvText: 'CV под вакансию' });
    return { project, sheet, variant };
  }

  it('приёмка 26/28: первая передача по ребру требует consentVersion v3 (ConsentRecord с purpose), повторная — нет; уходит только cvText и отмеченные пункты', async () => {
    const s = setup(() => JSON.stringify({ clauses: [{ kind: 'CONDITION', text: 'Удалённо', category: 'условия', isRequired: false, quote: 'Удалённо' }] }));
    const c = await candidateWithSheet(s);
    const mine = c.sheet.clauses.find((x) => x.side === 'CANDIDATE')!;
    await expect(s.selfShare.create('cand', c.sheet.id, { cvVariantId: c.variant.id, visibleClauseIds: [mine.id], edge: 'to_agency' })).rejects.toMatchObject({ response: { code: 'CONSENT_REQUIRED' } });
    // старая запись другого типа/версии не засчитывается
    s.prisma.seed('consentRecord', { userId: 'cand', consentType: 'PUBLIC_SHARING', version: 'v2', granted: true, revokedAt: null, purposes: [] });
    await expect(s.selfShare.create('cand', c.sheet.id, { cvVariantId: c.variant.id, visibleClauseIds: [mine.id], edge: 'to_agency', consentVersion: 'v2' })).rejects.toBeInstanceOf(ForbiddenException);
    const share = await s.selfShare.create('cand', c.sheet.id, { cvVariantId: c.variant.id, visibleClauseIds: [mine.id], edge: 'to_agency', consentVersion: CONSENT_TEXT_VERSION });
    expect(s.prisma.rows('consentRecord').find((r) => r.consentType === 'CANDIDATE_DATA_TRANSFER')).toMatchObject({ version: 'v3', purposes: ['to_agency'] });
    // второй раз по тому же ребру — без consentVersion; другое ребро — снова нужно
    await s.selfShare.create('cand', c.sheet.id, { cvVariantId: c.variant.id, visibleClauseIds: [mine.id], edge: 'to_agency' });
    await expect(s.selfShare.create('cand', c.sheet.id, { cvVariantId: c.variant.id, visibleClauseIds: [mine.id], edge: 'to_employer' })).rejects.toBeInstanceOf(ForbiddenException);
    const row = s.prisma.rows('candidateShare').find((x) => x.id === share.shareId)!;
    expect(row).toMatchObject({ consentSource: 'CANDIDATE_SELF', consentTextVersion: 'v3', sourceCandidateId: null });
    const preview = await s.selfShare.preview(row.shareToken);
    expect(preview.cvText).toBe('CV под вакансию');
    expect(preview.clauses.map((x: any) => x.text)).toEqual(['Удалёнка']);
    expect(JSON.stringify(preview)).not.toMatch(/transcript|segment|sparring/i);
  });

  it('приёмка 27: приём агентством → CandidateProfile с sharedFromProjectId и acceptedIntoMode; отзыв → revokedAt + consentRevokedAt; принять отозванное нельзя', async () => {
    const s = setup(() => JSON.stringify({ clauses: [] }));
    const c = await candidateWithSheet(s);
    const mine = c.sheet.clauses.find((x) => x.side === 'CANDIDATE')!;
    const share = await s.selfShare.create('cand', c.sheet.id, { cvVariantId: c.variant.id, visibleClauseIds: [mine.id], edge: 'to_agency', consentVersion: 'v3' });
    const token = s.prisma.rows('candidateShare').find((x) => x.id === share.shareId)!.shareToken;
    const agencyTeam = seedTeam(s.prisma, 'agent', 'AGENCY');
    const pool = s.prisma.seed('project', { ownerId: 'agent', mode: 'INTERVIEW_POOL', recruitingTeamId: agencyTeam.id });
    s.prisma.seed('interviewPoolConfig', { projectId: pool.id, jobTitle: 'Sales' });
    const js = s.prisma.seed('project', { ownerId: 'agent', mode: 'JOB_SEARCH' });
    await expect(s.selfShare.accept('agent', { token, projectId: js.id })).rejects.toBeInstanceOf(NotFoundException);

    const accepted = await s.selfShare.accept('agent', { token, projectId: pool.id });
    const profile = s.prisma.rows('candidateProfile').find((p) => p.id === accepted.profileId)!;
    expect(profile).toMatchObject({ sharedFromProjectId: c.project.id, recruitingTeamId: agencyTeam.id, resumeText: 'CV под вакансию', consentTextVersion: 'v3' });
    expect(s.prisma.rows('candidateShare').find((x) => x.id === share.shareId)).toMatchObject({ acceptedIntoMode: 'INTERVIEW_POOL', createdCandidateProfileId: profile.id });
    // пункт соискателя лёг в INTERVIEW-лист получателя как USER_STATED
    const interviewSheet = s.prisma.rows('termsSheet').find((x) => x.kind === 'INTERVIEW' && x.projectId === pool.id)!;
    expect(s.prisma.rows('termsClause').filter((cl) => cl.sheetId === interviewSheet.id && cl.side === 'CANDIDATE').map((cl) => cl.text)).toEqual(['Удалёнка']);

    await expect(s.selfShare.accept('agent', { token, projectId: pool.id })).rejects.toBeInstanceOf(BadRequestException);
    await s.selfShare.revoke('cand', share.shareId);
    expect(profile.consentRevokedAt).toBeInstanceOf(Date);
    await expect(s.selfShare.preview(token)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('приёмка 22/23: оффер копией — только после ревью, адресат по самошерингу этого кандидата; копия помечена sharedFromProjectId, правки оригинала её не меняют; withdraw → withdrawnAt; расхождения Р-9 в аудите', async () => {
    const s = setup(() => JSON.stringify({ clauses: [], positions: [] }));
    const c = await candidateWithSheet(s);
    const mine = c.sheet.clauses.find((x) => x.side === 'CANDIDATE')!;
    const share = await s.selfShare.create('cand', c.sheet.id, { cvVariantId: c.variant.id, visibleClauseIds: [mine.id], edge: 'to_employer', consentVersion: 'v3' });
    const token = s.prisma.rows('candidateShare').find((x) => x.id === share.shareId)!.shareToken;

    const employerProject = await s.employer.createProject('emp', 'нанимаем Sales');
    await s.dossiers.identify('emp', employerProject.id, { registryCode: '12345678', legalName: 'ТОВ Ромашка' });
    await s.employer.updateConfig('emp', employerProject.id, { jobTitle: 'Sales', workArrangement: 'REMOTE' as any });
    const accepted = await s.selfShare.accept('emp', { token, projectId: employerProject.id });
    const status = s.prisma.rows('candidatePipelineStatus').find((st) => st.candidateProfileId === accepted.profileId)!;
    const interview = s.prisma.rows('termsSheet').find((x) => x.kind === 'INTERVIEW' && x.pipelineStatusId === status.id)!;

    // обещание на собеседовании: удалённо (offered), оффер: офис (countered) → расхождение
    const remote = s.prisma.rows('termsClause').find((cl) => cl.sheetId === interview.id && cl.text === 'Формат работы: REMOTE')!;
    s.prisma.seed('clausePosition', { clauseId: remote.id, bySide: 'EMPLOYER', stance: 'offered', evidenceKind: 'TRANSCRIPT_SEGMENT', evidenceRef: 'seg-1', evidenceQuote: 'работаем удалённо', confirmedAt: new Date('2026-09-01') });
    const offer = s.prisma.seed('offerDocument', { sheetId: interview.id, rawText: 'Оффер: офис 5 дней', source: 'черновик' });
    s.prisma.seed('clausePosition', { clauseId: remote.id, bySide: 'EMPLOYER', stance: 'countered', evidenceKind: 'OFFER_TEXT', evidenceRef: offer.id, evidenceQuote: 'офис 5 дней', confirmedAt: new Date('2026-09-02') });

    await expect(s.offers.shareToCandidate('emp', offer.id, { token })).rejects.toThrow(/ревью/);
    await s.offers.review('emp', offer.id);
    const check = await s.offers.promisesCheck('emp', offer.id);
    expect(check.discrepancies).toHaveLength(1);
    expect(check.discrepancies[0]).toMatchObject({ promised: { stance: 'offered' }, offered: { stance: 'countered' } });

    const result = await s.offers.shareToCandidate('emp', offer.id, { token });
    expect(result.copy).toMatchObject({ sheetId: c.sheet.id, sharedFromProjectId: employerProject.id, rawText: 'Оффер: офис 5 дней' });
    expect(result.copy.sharedAt).toBeInstanceOf(Date);
    expect(result.discrepancies).toHaveLength(1);
    expect(s.audit.records.find((r) => r.action === 'offer.shared_to_candidate')!.after.discrepancies).toHaveLength(1);
    // Р-9 / приёмка 23 (исправлено аудитом 2026-09-03): расхождение видно НЕ
    // только в AuditLog, куда пользователь не смотрит, а в редакциях самого
    // пункта — там, где обе стороны читают, о чём договаривались.
    expect(result.recordedInRevisions).toBe(1);
    const recorded = s.prisma.rows('clausePosition').filter((p: any) => p.evidenceKind === 'OFFER_TEXT' && (p.note ?? '').includes('Расхождение с обещанным'));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ clauseId: check.discrepancies[0].clauseId, bySide: 'EMPLOYER', evidenceRef: offer.id });
    expect(recorded[0].confirmedAt).toBeInstanceOf(Date);

    // ── Пункт [term-never-ends] 2026-09-06 ──
    //
    // Пять входов по `CandidateShare`, четыре проверяли срок, этот — нет.
    // Соискатель ставит ссылке срок сам; после срока в его лист всё
    // равно ложилась копия оффера.
    const самошеринг = s.prisma.rows('candidateShare').find((x: any) => x.shareToken === token)!;
    const былоКопий = s.prisma.rows('offerDocument').length;
    самошеринг.expiresAt = new Date(Date.now() - 1000);
    await expect(s.offers.shareToCandidate('emp', offer.id, { token })).rejects.toThrow(/просрочен/);
    // И ничего не записалось — отказ, а не «отказали, но положили».
    expect(s.prisma.rows('offerDocument')).toHaveLength(былоКопий);
    // Через внутренний id — тот же отказ: обходного пути нет.
    await expect(s.offers.shareToCandidate('emp', offer.id, { candidateShareId: самошеринг.id })).rejects.toThrow(/просрочен/);
    самошеринг.expiresAt = new Date(Date.now() + 86_400_000);

    // правка оригинала копию не меняет
    offer.rawText = 'Оффер: офис 3 дня';
    expect(s.prisma.rows('offerDocument').find((o) => o.id === result.copy.id)!.rawText).toBe('Оффер: офис 5 дней');
    const w = await s.offers.withdraw('emp', offer.id);
    expect(w.copiesMarked).toBe(1);
    const copy = s.prisma.rows('offerDocument').find((o) => o.id === result.copy.id)!;
    expect(copy.withdrawnAt).toBeInstanceOf(Date);
    expect(s.prisma.rows('offerDocument').includes(copy)).toBe(true); // не удалена

    /** КЛЮЧЕВОЙ ТЕСТ [withdraw-no-trace] 2026-09-06 — отзыв обязан
     * оставить след У ТОГО, КТО ЕГО СДЕЛАЛ. Раньше помечались только
     * копии в проекте кандидата, а оригинал — строка, которую читает
     * экран работодателя, — оставался нетронутым: бейдж и после
     * отзыва говорил «передан кандидату», кнопка «Отозвать» никуда не
     * девалась, и второе нажатие выглядело как первое. */
    const original = s.prisma.rows('offerDocument').find((o) => o.id === offer.id)!;
    expect(original.withdrawnAt).toBeInstanceOf(Date);
    expect(original.withdrawnAt).toEqual(copy.withdrawnAt);

    // Повторный отзыв больше не выглядит как первый.
    await expect(s.offers.withdraw('emp', offer.id)).rejects.toBeInstanceOf(BadRequestException);

    // И отправить отозванный документ снова нельзя — замена делается
    // новым оффером, а не отменой собственного отзыва без следа.
    await expect(s.offers.shareToCandidate('emp', offer.id, { token })).rejects.toBeInstanceOf(BadRequestException);
  });

  /** Пункт [withdraw-no-trace] 2026-09-06: ноль помеченных копий — не
   * мелочь и не успех по умолчанию. Копии у кандидата может не быть
   * вовсе, и работодатель обязан это прочитать, а не решить, что отзыв
   * дошёл до адресата. */
  it('[withdraw-no-trace]: отзыв без единой копии сообщает об этом прямым текстом, а не молча возвращает ноль', async () => {
    const s = setup();
    const emp = s.prisma.seed('project', { ownerId: 'emp', mode: 'EMPLOYER_HIRING', question: 'найм' });
    const status = s.prisma.seed('candidatePipelineStatus', { projectId: emp.id, candidateProfileId: 'cp-1' });
    const interview = s.prisma.seed('termsSheet', { projectId: emp.id, kind: 'INTERVIEW', pipelineStatusId: status.id, title: 'Кандидат' });
    const offer = s.prisma.seed('offerDocument', { sheetId: interview.id, rawText: 'Оффер', source: 'черновик', reviewedAt: new Date() });

    const w = await s.offers.withdraw('emp', offer.id);
    expect(w.copiesMarked).toBe(0);
    expect(w.note).toContain('не нашлось');
    expect(w.note).not.toMatch(/^Копий у кандидата помечено/);
    expect(s.prisma.rows('offerDocument').find((o) => o.id === offer.id)!.withdrawnAt).toBeInstanceOf(Date);
  });
});

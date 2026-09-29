// Пункт [job-domain-v2] §9.1 — песочница оператора для найма v2: лист условий
// у соискателя (продолжение цепочки job-search) и цепочка работодателя
// (Р-0…Р-5 + Т + матрица). Отдельный сервис, чтобы не удлинять конструктор
// AdminSandboxService ещё на десяток зависимостей; принципы те же
// (см. admin-sandbox.service.ts): всё от имени оператора, никаких обходов
// проверок (409 COMPANY_REQUIRED до идентификации компании — РЕЗУЛЬТАТ
// прогона, не сбой), «AI предлагает — человек утверждает» — подтверждение
// черновиков отдельной кнопкой, а не слито с извлечением.
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { EvidenceKind, TermsSide } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService, emptySkips } from '../terms-sheet/terms-matching.service';
import { CvVariantService } from '../terms-sheet/cv-variant.service';
import { EmployerHiringService } from '../employer-hiring/employer-hiring.service';
import { EmployerDossierService } from '../employer-dossier/employer-dossier.service';
import { ClientBriefService } from '../client-brief/client-brief.service';
import { VacancyPostingService } from '../vacancy-posting/vacancy-posting.service';
import { HiringExtrasService } from '../hiring-extras/hiring-extras.service';
import { InterviewPoolService } from '../interview-pool/interview-pool.service';
import { InterviewPoolCandidateService } from '../interview-pool/interview-pool-candidate.service';

export interface SandboxSheetSummary {
  sheetId: string;
  kind: string;
  status: string;
  title: string;
  clauses: { employer: number; candidate: number; drafts: number; rejected: number };
  positions: { confirmed: number; drafts: number };
  counters: Record<string, number>;
  agenda: number;
}

@Injectable()
export class AdminSandboxHiringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sheets: TermsSheetService,
    private readonly matching: TermsMatchingService,
    private readonly cv: CvVariantService,
    private readonly employer: EmployerHiringService,
    private readonly dossiers: EmployerDossierService,
    private readonly briefs: ClientBriefService,
    private readonly postings: VacancyPostingService,
    private readonly extras: HiringExtrasService,
    private readonly pool: InterviewPoolService,
    private readonly poolCandidates: InterviewPoolCandidateService,
  ) {}

  private async assertOperator(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isOperator: true } });
    if (!user?.isOperator) throw new ForbiddenException('Требуется роль оператора');
  }

  /** Сводка листа для стенда: числа, не содержимое (позиции с цитатами — в TMA). */
  async summary(operatorUserId: string, sheetId: string): Promise<SandboxSheetSummary> {
    await this.assertOperator(operatorUserId);
    const sheet = await this.sheets.get(operatorUserId, sheetId);
    const agenda = await this.sheets.agenda(operatorUserId, sheetId);
    let confirmed = 0;
    let drafts = 0;
    for (const c of sheet.clauses) {
      if (c.current.EMPLOYER) confirmed++;
      if (c.current.CANDIDATE) confirmed++;
      drafts += c.drafts.length;
    }
    return {
      sheetId: sheet.id,
      kind: sheet.kind,
      status: sheet.status,
      title: sheet.title,
      clauses: {
        employer: sheet.clauses.filter((c) => c.side === TermsSide.EMPLOYER && c.confirmedAt && !c.rejectedAt).length,
        candidate: sheet.clauses.filter((c) => c.side === TermsSide.CANDIDATE && c.confirmedAt && !c.rejectedAt).length,
        drafts: sheet.clauses.filter((c) => !c.confirmedAt && !c.rejectedAt).length,
        rejected: sheet.clauses.filter((c) => !!c.rejectedAt).length,
      },
      positions: { confirmed, drafts },
      counters: sheet.counters.total,
      agenda: agenda.length,
    };
  }

  // ── Соискатель: лист по вакансии (продолжение job-search) ──

  /** Открыть или возобновить лист VACANCY_RESPONSE по вакансии (AI-извлечение
   * пунктов из текста вакансии — реальный вызов). */
  async openForVacancy(operatorUserId: string, vacancyId: string) {
    await this.assertOperator(operatorUserId);
    if (!vacancyId?.trim()) throw new BadRequestException('vacancyId обязателен');
    const existing = await this.prisma.termsSheet.findUnique({ where: { vacancyId } });
    const sheet = existing ? await this.sheets.get(operatorUserId, existing.id) : await this.sheets.openForVacancy(operatorUserId, vacancyId);
    return { ...(await this.summary(operatorUserId, sheet.id)), resumed: !!existing };
  }

  /** Подтвердить ВСЕ черновики пунктов и позиций — отдельная кнопка оператора
   * («человек утверждает»); песочница не сливает её с извлечением. */
  async confirmAllDrafts(operatorUserId: string, sheetId: string) {
    await this.assertOperator(operatorUserId);
    if (!sheetId?.trim()) throw new BadRequestException('sheetId обязателен');
    const sheet = await this.sheets.get(operatorUserId, sheetId);
    const clauseIds = sheet.clauses.filter((c) => !c.confirmedAt && !c.rejectedAt).map((c) => c.id);
    if (clauseIds.length) await this.sheets.confirmClauses(operatorUserId, sheetId, clauseIds);
    const positionIds = sheet.clauses.flatMap((c) => c.drafts.map((d) => d.id));
    if (positionIds.length) await this.sheets.confirmPositions(operatorUserId, sheetId, positionIds);
    return { clausesConfirmed: clauseIds.length, positionsConfirmed: positionIds.length, ...(await this.summary(operatorUserId, sheetId)) };
  }

  /** Сверить текст (оффер / документ) с листом — черновики позиций (AI). */
  async propose(operatorUserId: string, sheetId: string, text: string, evidenceKind: EvidenceKind, bySide: TermsSide) {
    await this.assertOperator(operatorUserId);
    if (!sheetId?.trim()) throw new BadRequestException('sheetId обязателен');
    if (!text?.trim()) throw new BadRequestException('text обязателен');
    const sheet = await this.sheets.get(operatorUserId, sheetId);
    const { created: positions, skipped } = await this.matching.proposePositions({
      userId: operatorUserId,
      projectId: sheet.projectId,
      sheetId,
      bySide,
      input: { text, evidenceKind, evidenceRef: null },
      scenario: 'admin-sandbox',
    });
    return {
      proposed: positions.length,
      // Песочница нужна именно для того, чтобы видеть, как модель себя
      // ведёт на живом тексте, — молчать здесь о разобранном мимо было
      // бы отдельно нелепо.
      skipped,
      sample: positions.slice(0, 5).map((p) => ({ clauseId: p.clauseId, coverage: p.coverage, stance: p.stance, quote: p.evidenceQuote })),
      ...(await this.summary(operatorUserId, sheetId)),
    };
  }

  /** CV-вариант под вакансию: карта подсветки (AI) → компиляция (детерминированно). */
  async cvVariant(operatorUserId: string, sheetId: string) {
    await this.assertOperator(operatorUserId);
    if (!sheetId?.trim()) throw new BadRequestException('sheetId обязателен');
    const map = await this.cv.proposeHighlightMap(operatorUserId, sheetId);
    const variant = await this.cv.compile(operatorUserId, sheetId, map);
    return { variantId: variant.id, highlights: map.length, cvText: variant.cvText, note: map.length === 0 ? 'AI не связал ни один фрагмент базового CV с пунктами вакансии — вариант равен базовому порядку' : null };
  }

  /** Черновик оффера из согласованных пунктов (А-1, без AI). */
  async offerDraft(operatorUserId: string, sheetId: string) {
    await this.assertOperator(operatorUserId);
    if (!sheetId?.trim()) throw new BadRequestException('sheetId обязателен');
    return this.sheets.offerDraft(operatorUserId, sheetId);
  }

  // ── Работодатель: Р-0…Р-5, Т, матрица ──

  async ehCreateProject(operatorUserId: string, question: string) {
    await this.assertOperator(operatorUserId);
    if (!question?.trim()) throw new BadRequestException('question обязателен');
    const project = await this.employer.createProject(operatorUserId, question);
    return { projectId: project.id, mode: project.mode, draft: true, note: 'Проект — черновик до идентификации компании: конфиг и извлечение ответят 409 COMPANY_REQUIRED' };
  }

  async ehIdentifyCompany(operatorUserId: string, projectId: string, dto: { legalName?: string | null; registryCode?: string | null; domain?: string | null }) {
    await this.assertOperator(operatorUserId);
    if (!projectId?.trim()) throw new BadRequestException('projectId обязателен');
    const dossier = await this.dossiers.identify(operatorUserId, projectId, dto);
    const state = await this.employer.getState(operatorUserId, projectId);
    return { dossierId: dossier.id, legalName: dossier.legalName, registryCode: dossier.registryCode, domain: dossier.domain, draft: state.draft };
  }

  /** Внутренний бриф текстом → пункты листа вакансии (AI, черновики). */
  async ehBrief(operatorUserId: string, projectId: string, rawText: string) {
    await this.assertOperator(operatorUserId);
    if (!projectId?.trim()) throw new BadRequestException('projectId обязателен');
    if (!rawText?.trim()) throw new BadRequestException('rawText обязателен');
    const brief = await this.briefs.ingest(operatorUserId, projectId, { rawText, source: 'admin-sandbox', origin: 'INTERNAL' });
    const res = await this.briefs.extract(operatorUserId, brief.id);
    return { briefId: brief.id, proposedClauses: res.proposedClauses.length, skipped: res.draftSkips, ...(await this.summary(operatorUserId, res.sheetId)) };
  }

  async ehConfig(operatorUserId: string, projectId: string, patch: { jobTitle: string; extendedDescription?: string; salaryRange?: string | null; officeLocation?: string | null }) {
    await this.assertOperator(operatorUserId);
    if (!projectId?.trim()) throw new BadRequestException('projectId обязателен');
    if (!patch?.jobTitle?.trim()) throw new BadRequestException('jobTitle обязателен');
    const config = await this.employer.updateConfig(operatorUserId, projectId, patch);
    return { configId: config.id, jobTitle: config.jobTitle };
  }

  async ehQuestionnaire(operatorUserId: string, projectId: string) {
    await this.assertOperator(operatorUserId);
    if (!projectId?.trim()) throw new BadRequestException('projectId обязателен');
    const items = await this.pool.generateQuestionnaireDraft(operatorUserId, projectId);
    const fixed = await this.pool.fixQuestionnaire(operatorUserId, projectId, items);
    // анкета → пункты EMPLOYER/REQUIREMENT листа вакансии (детерминированно, при открытии/обновлении)
    const sheet = await this.sheets.ensureVacancySheet(operatorUserId, projectId);
    return { questions: fixed.length, sheetId: sheet?.id ?? null, ...(sheet ? await this.summary(operatorUserId, sheet.id) : {}) };
  }

  /** Текст вакансии: черновик из листа (AI-формулировки) + проверки. */
  async ehPosting(operatorUserId: string, projectId: string) {
    await this.assertOperator(operatorUserId);
    if (!projectId?.trim()) throw new BadRequestException('projectId обязателен');
    const revision = await this.postings.draftFromSheet(operatorUserId, projectId);
    const check = await this.postings.check(operatorUserId, revision.id);
    const checklist = await this.postings.publishChecklist(operatorUserId, revision.id);
    return {
      postingId: revision.postingId,
      revisionId: revision.id,
      textLength: revision.text.length,
      complianceFlags: check.complianceFlags.length,
      checklistOpen: checklist.open,
      note: 'Чеклист не блокирует публикацию — показывает открытое; решение за человеком',
    };
  }

  /** Кандидат: профиль + статус + лист кандидата (наследует пункты вакансии) +
   * позиции из текста резюме (AI, черновики). */
  async ehCandidate(operatorUserId: string, projectId: string, displayName: string, resumeText?: string) {
    await this.assertOperator(operatorUserId);
    if (!projectId?.trim()) throw new BadRequestException('projectId обязателен');
    if (!displayName?.trim()) throw new BadRequestException('displayName обязателен');
    const profile = await this.poolCandidates.createCandidate(operatorUserId, displayName, undefined, resumeText);
    const status = await this.pool.addCandidate(operatorUserId, projectId, profile.id, false);
    const sheet = await this.sheets.openForCandidate(operatorUserId, status.id);
    let proposed = 0;
    let skipped = emptySkips();
    if (resumeText?.trim()) {
      const outcome = await this.matching.proposePositions({
        userId: operatorUserId,
        projectId,
        sheetId: sheet.id,
        bySide: TermsSide.CANDIDATE,
        input: { text: resumeText, evidenceKind: EvidenceKind.OWN_DOCUMENT, evidenceRef: null },
        scenario: 'admin-sandbox-resume',
      });
      proposed = outcome.created.length;
      skipped = outcome.skipped;
    }
    return { candidateProfileId: profile.id, statusId: status.id, proposedPositions: proposed, skipped, ...(await this.summary(operatorUserId, sheet.id)) };
  }

  async ehMatrix(operatorUserId: string, projectId: string) {
    await this.assertOperator(operatorUserId);
    if (!projectId?.trim()) throw new BadRequestException('projectId обязателен');
    const m = await this.extras.coverageMatrix(operatorUserId, projectId);
    return {
      columns: m.columns.length,
      rows: m.rows.map((r) => ({ displayName: r.displayName, covered: Object.values(r.cells).filter((c) => c.coverage === 'covered').length, unknown: r.openQuestions.length })),
      note: m.note,
    };
  }

  async ehState(operatorUserId: string, projectId: string) {
    await this.assertOperator(operatorUserId);
    if (!projectId?.trim()) throw new BadRequestException('projectId обязателен');
    return this.employer.getState(operatorUserId, projectId);
  }
}

// Пункт [job-domain-v2] Р-15 / Р-4 (§6.4, §7.2) — заказ агентству из проекта
// работодателя: EmployerAgencyEngagement.
//
// Работодатель делится вакансией одним действием: бриф, конфиг, анкета,
// текст — по выбору (ровно эти четыре). Агентство принимает по токену:
// в СВОЙ новый проект-пул (создаётся при accept) или в указанный —
// копиями с sourceProjectId. Никогда не копируются: собеседования
// работодателя, его досье на себя, его ComplianceFlag (приёмка 20).
//
// Обратно по тому же engagement идут: отчёт агентства (deliver →
// ClientReport.deliveredToProjectId), follow-up-вопросы работодателя по
// кандидату (→ CandidateFollowUpRequest в проекте агентства), комментарии
// работодателя к тексту вакансии агентства (внутри продукта — замена А-30
// для этого ребра). REVOKED останавливает всё новое; полученное остаётся у
// обеих сторон (приёмка 21). Границу проектов каскад не пересекает —
// связи между проектами без FK.

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { termIsCurrent } from '../common/term-validity';
import { ClientBriefOrigin, EngagementStatus, ProjectMode, RecruitingTeamType } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { assertInterviewPoolProjectAccess } from '../interview-pool/interview-pool-access';
import { assertProjectNotFrozen, assertCounterpartyProjectNotFrozen } from '../project-freeze/assert-not-frozen';
import { candidateIdsInReport, CONSENT_REVOKED_MESSAGE } from '../interview-pool/consent-revocation';
import { buildStartDeepLink } from '../common/telegram-deep-link';

export const ENGAGEMENT_SHARED_ITEMS = ['brief', 'config', 'questionnaire', 'posting'] as const;
export type EngagementSharedItem = (typeof ENGAGEMENT_SHARED_ITEMS)[number];
export const ENGAGEMENT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class EngagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Работодатель → токен приглашения агентству. */
  async invite(userId: string, employerProjectId: string, dto: { sharedItems: string[]; expiresAt?: string | Date | null }) {
    const project = await assertInterviewPoolProjectAccess(this.prisma, userId, employerProjectId);
    if (project.mode !== ProjectMode.EMPLOYER_HIRING) throw new BadRequestException('Передать вакансию агентству может только проект работодателя');
    const items = [...new Set(dto.sharedItems)];
    if (items.length === 0 || items.some((i) => !ENGAGEMENT_SHARED_ITEMS.includes(i as EngagementSharedItem))) {
      throw new BadRequestException(`sharedItems — непустое подмножество: ${ENGAGEMENT_SHARED_ITEMS.join(', ')}`);
    }
    const dossier = await this.prisma.employerDossier.findFirst({ where: { projectId: employerProjectId } });
    if (!dossier) throw new ConflictException({ message: 'Укажите компанию: до идентификации компании вакансия агентству не передаётся', code: 'COMPANY_REQUIRED' });
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : new Date(Date.now() + ENGAGEMENT_TOKEN_TTL_MS);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new BadRequestException('expiresAt — дата в будущем');
    const token = randomBytes(24).toString('base64url');
    const engagement = await this.prisma.employerAgencyEngagement.create({
      data: { employerProjectId, token, sharedItems: items, expiresAt },
    });
    return { ...engagement, deepLink: buildStartDeepLink(`eng_${token}`) };
  }

  /** Агентство принимает: свой проект-пул создаётся (или указан). */
  async accept(userId: string, dto: { token: string; teamId: string; agencyProjectId?: string | null }) {
    const engagement = await this.prisma.employerAgencyEngagement.findUnique({ where: { token: dto.token } });
    if (!engagement || engagement.expiresAt < new Date()) throw new NotFoundException('Приглашение недействительно или просрочено');
    if (engagement.status !== EngagementStatus.PENDING) throw new BadRequestException('Приглашение уже принято или отозвано');

    const membership = await this.prisma.recruitingTeamMember.findUnique({
      where: { teamId_userId: { teamId: dto.teamId, userId } },
      include: { team: { select: { teamType: true, name: true } } },
    });
    if (!membership) throw new NotFoundException(`RecruitingTeam ${dto.teamId} not found`);
    if (membership.team.teamType !== RecruitingTeamType.AGENCY) throw new BadRequestException('Принять заказ может команда агентства (teamType AGENCY)');

    const employerProject = await this.prisma.project.findUnique({ where: { id: engagement.employerProjectId }, select: { id: true, question: true } });
    if (!employerProject) throw new NotFoundException('Проект работодателя удалён');
    // Аудит заморозки 2026-09-03: принятие копирует данные ИЗ проекта
    // работодателя и переводит заказ в ACTIVE — то есть меняет мир вокруг
    // проекта, который оператор заморозил. Формулировка нейтральная: агентству
    // незачем знать модерационный статус чужого проекта.
    await assertCounterpartyProjectNotFrozen(this.prisma, employerProject.id);

    let agencyProjectId = dto.agencyProjectId ?? null;
    if (agencyProjectId) {
      const p = await assertInterviewPoolProjectAccess(this.prisma, userId, agencyProjectId);
      if (p.mode !== ProjectMode.INTERVIEW_POOL || p.recruitingTeamId !== dto.teamId) throw new BadRequestException('Проект агентства должен быть пулом этой команды');
      // Свой проект — причину и заметку оператора называем прямо.
      await assertProjectNotFrozen(this.prisma, p.id);
    } else {
      const created = await this.prisma.project.create({
        data: { ownerId: userId, mode: ProjectMode.INTERVIEW_POOL, recruitingTeamId: dto.teamId, question: `Заказ работодателя: ${employerProject.question}`.slice(0, 500) },
      });
      agencyProjectId = created.id;
    }

    await this.copyItems(engagement.sharedItems as EngagementSharedItem[], engagement.employerProjectId, agencyProjectId);

    const updated = await this.prisma.employerAgencyEngagement.update({
      where: { id: engagement.id },
      data: { status: EngagementStatus.ACTIVE, agencyProjectId, agencyTeamId: dto.teamId, acceptedAt: new Date() },
    });
    await this.audit.record({ actorId: userId, action: 'engagement.accepted', resource: 'EmployerAgencyEngagement', resourceId: engagement.id, after: { agencyProjectId, sharedItems: engagement.sharedItems } });
    return updated;
  }

  /** Таблицы-источники копирования — ровно по sharedItems (приёмка 20). */
  private async copyItems(items: EngagementSharedItem[], fromProjectId: string, toProjectId: string) {
    const srcConfig = await this.prisma.interviewPoolConfig.findUnique({ where: { projectId: fromProjectId }, include: { questions: { orderBy: { orderIndex: 'asc' } } } });
    let dstConfig = await this.prisma.interviewPoolConfig.findUnique({ where: { projectId: toProjectId } });

    if (items.includes('config') && srcConfig) {
      const fields = {
        jobTitle: srcConfig.jobTitle,
        extendedDescription: srcConfig.extendedDescription,
        salaryRange: srcConfig.salaryRange,
        employmentLoad: srcConfig.employmentLoad,
        workArrangement: srcConfig.workArrangement,
        officeLocation: srcConfig.officeLocation,
        employmentFormat: srcConfig.employmentFormat,
        perks: srcConfig.perks,
        // genderRequirement/ageRequirement/isPhysicallyDemanding — как у источника: это структурные поля v1 с их дефолтами
      };
      // Пункт [check-then-create-2] 2026-09-27: `projectId` уникален, и
      // «есть — обновить, нет — создать» оставляло окно. В этом же методе
      // соседнее копирование объявления уже сделано `upsert`-ом — правило
      // было, просто не везде.
      dstConfig = await this.prisma.interviewPoolConfig.upsert({
        where: { projectId: toProjectId },
        update: fields,
        create: { projectId: toProjectId, ...fields },
      });
    }
    if (items.includes('questionnaire') && srcConfig) {
      // Пункт [check-then-create-2] 2026-09-27: то же и здесь. `??=`
      // читается как «создать, если ещё нет», и это ровно та пара
      // «прочитал — и создал», только записанная короче.
      dstConfig ??= await this.prisma.interviewPoolConfig.upsert({
        where: { projectId: toProjectId },
        update: {},
        create: { projectId: toProjectId, jobTitle: srcConfig.jobTitle, extendedDescription: srcConfig.extendedDescription },
      });
      const existing = await this.prisma.questionnaireItem.count({ where: { configId: dstConfig.id } });
      if (existing === 0 && srcConfig.questions.length > 0) {
        await this.prisma.questionnaireItem.createMany({
          data: srcConfig.questions.map((q) => ({ configId: dstConfig!.id, text: q.text, category: q.category, orderIndex: q.orderIndex, isRequired: q.isRequired })),
        });
      }
    }
    if (items.includes('brief')) {
      const briefs = await this.prisma.clientBrief.findMany({ where: { projectId: fromProjectId }, orderBy: { receivedAt: 'asc' } });
      for (const b of briefs) {
        await this.prisma.clientBrief.create({
          data: { projectId: toProjectId, rawText: b.rawText, source: b.source, origin: ClientBriefOrigin.FROM_EMPLOYER_PROJECT, sourceProjectId: fromProjectId },
        });
      }
    }
    if (items.includes('posting')) {
      const posting = await this.prisma.vacancyPosting.findUnique({ where: { projectId: fromProjectId }, include: { revisions: { orderBy: { createdAt: 'desc' } } } });
      const rev = posting?.revisions.find((r) => r.reviewedAt) ?? posting?.revisions[0];
      if (rev) {
        const dst = await this.prisma.vacancyPosting.upsert({ where: { projectId: toProjectId }, create: { projectId: toProjectId }, update: {} });
        await this.prisma.vacancyPostingRevision.create({ data: { postingId: dst.id, text: rev.text } });
      }
    }
    // ComplianceFlag, собеседования (Conversation), EmployerDossier — не копируются никогда.
  }

  async revoke(userId: string, engagementId: string) {
    const engagement = await this.getForEmployer(userId, engagementId);
    if (engagement.status === EngagementStatus.REVOKED) return engagement;
    const updated = await this.prisma.employerAgencyEngagement.update({ where: { id: engagementId }, data: { status: EngagementStatus.REVOKED, revokedAt: new Date() } });
    await this.audit.record({ actorId: userId, action: 'engagement.revoked', resource: 'EmployerAgencyEngagement', resourceId: engagementId });
    return updated;
  }

  /** Агентство доставляет отчёт в проект работодателя (Р-4). */
  async deliverReport(userId: string, reportId: string, engagementId: string) {
    const report = await this.prisma.clientReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException(`ClientReport ${reportId} not found`);
    await assertInterviewPoolProjectAccess(this.prisma, userId, report.projectId);
    const engagement = await this.prisma.employerAgencyEngagement.findUnique({ where: { id: engagementId } });
    if (!engagement || engagement.agencyProjectId !== report.projectId) throw new NotFoundException(`Engagement ${engagementId} not found`);
    this.assertActive(engagement);
    if (!report.reviewedAt) throw new BadRequestException('Отчёт не прошёл ревью — reviewedAt обязателен перед доставкой');
    // А-6 / приёмка 27 (аудит 2026-09-03): отзыв согласия останавливает и
    // доставку уже готового отчёта — иначе отозванное согласие переживало
    // бы себя в проекте работодателя.
    const mentioned = candidateIdsInReport(report);
    if (mentioned.length > 0) {
      const revokedCount = await this.prisma.candidateProfile.count({ where: { id: { in: mentioned }, consentRevokedAt: { not: null } } });
      if (revokedCount > 0) throw new ForbiddenException(CONSENT_REVOKED_MESSAGE);
    }
    return this.prisma.clientReport.update({
      where: { id: reportId },
      data: { deliveredToProjectId: engagement.employerProjectId, sentAt: report.sentAt ?? new Date(), sentViaShare: report.sentViaShare ?? `engagement:${engagement.id}` },
    });
  }

  /** Отчёты, доставленные в проект работодателя — без ComplianceFlag и
   * внутренних заметок агентства (в content их нет по построению v1). */
  async deliveredReports(userId: string, employerProjectId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, employerProjectId);
    return this.prisma.clientReport.findMany({
      where: { deliveredToProjectId: employerProjectId },
      orderBy: { sentAt: 'desc' },
      select: { id: true, type: true, content: true, sentAt: true, candidateProfileId: true, projectId: true },
    });
  }

  /** Работодатель → follow-up-вопрос по кандидату в проект агентства. */
  async forwardFollowUp(userId: string, engagementId: string, dto: { candidateProfileId: string; text: string }) {
    const engagement = await this.getForEmployer(userId, engagementId);
    this.assertActive(engagement);
    if (!dto.text?.trim()) throw new BadRequestException('text не может быть пустым');
    if (!engagement.agencyProjectId) throw new BadRequestException('Агентство ещё не приняло заказ');
    const status = await this.prisma.candidatePipelineStatus.findFirst({ where: { projectId: engagement.agencyProjectId, candidateProfileId: dto.candidateProfileId } });
    if (!status) throw new NotFoundException('Кандидат не найден в проекте агентства по этому заказу');
    return this.prisma.candidateFollowUpRequest.create({
      data: { statusId: status.id, requestText: `[от работодателя] ${dto.text.trim()}`.slice(0, 2000) },
    });
  }

  /** Работодатель комментирует текст вакансии агентства — внутри продукта. */
  async postingReview(userId: string, engagementId: string, dto: { revisionId: string; text: string }) {
    const engagement = await this.getForEmployer(userId, engagementId);
    this.assertActive(engagement);
    if (!dto.text?.trim()) throw new BadRequestException('text не может быть пустым');
    if (!engagement.agencyProjectId) throw new BadRequestException('Агентство ещё не приняло заказ');
    const revision = await this.prisma.vacancyPostingRevision.findFirst({ where: { id: dto.revisionId, posting: { projectId: engagement.agencyProjectId } }, include: { posting: true } });
    if (!revision) throw new NotFoundException(`VacancyPostingRevision ${dto.revisionId} not found`);
    const token = `eng-internal-${engagement.id}`;
    const share = await this.prisma.postingReviewShare.upsert({
      where: { token },
      create: { postingId: revision.postingId, revisionId: revision.id, token, expiresAt: engagement.expiresAt, comments: [] },
      update: { revisionId: revision.id },
    });
    const comments = [...(((share.comments as unknown) as Array<{ at: string; text: string }>) ?? []), { at: new Date().toISOString(), text: dto.text.trim().slice(0, 2000), from: 'employer' }];
    return this.prisma.postingReviewShare.update({ where: { id: share.id }, data: { comments: comments as never } });
  }

  /** Текст вакансии агентства, видимый работодателю по engagement (без ComplianceFlag). */
  async agencyPosting(userId: string, engagementId: string) {
    const engagement = await this.getForEmployer(userId, engagementId);
    if (!engagement.agencyProjectId) return null;
    const posting = await this.prisma.vacancyPosting.findUnique({
      where: { projectId: engagement.agencyProjectId },
      include: { revisions: { orderBy: { createdAt: 'desc' }, select: { id: true, text: true, reviewedAt: true, createdAt: true } } },
    });
    const comments = await this.prisma.postingReviewShare.findUnique({ where: { token: `eng-internal-${engagement.id}` }, select: { comments: true, revisionId: true } });
    return posting ? { postingId: posting.id, revisions: posting.revisions, comments } : null;
  }

  async listForEmployer(userId: string, employerProjectId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, employerProjectId);
    return this.prisma.employerAgencyEngagement.findMany({ where: { employerProjectId }, orderBy: { createdAt: 'desc' } });
  }

  async listForAgency(userId: string, agencyProjectId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, agencyProjectId);
    return this.prisma.employerAgencyEngagement.findMany({ where: { agencyProjectId }, orderBy: { createdAt: 'desc' } });
  }

  /** Пункт [term-never-ends] 2026-09-06 — функция принимала `expiresAt`
   * и НЕ ЧИТАЛА его. Намерение проверить срок было записано прямо в
   * сигнатуре, проверки не было; три места зовут её, и все три —
   * передачи данных между работодателем и агентством (доставка отчёта,
   * запрос по кандидату, ревью текста вакансии). Заказ с истёкшим сроком
   * считался действующим.
   *
   * Две причины отказа названы ПОРОЗНЬ, в отличие от публичных ссылок:
   * здесь обе стороны известны и аутентифицированы, скрывать от них,
   * закончился срок или заказ отозвали, незачем — а вот перепутать эти
   * два случая при продлении легко. */
  private assertActive(engagement: { status: EngagementStatus; expiresAt: Date }) {
    if (engagement.status !== EngagementStatus.ACTIVE) throw new ForbiddenException('Заказ не активен: отозван, закрыт или ещё не принят — новых передач нет, полученное остаётся');
    if (!termIsCurrent(engagement)) throw new ForbiddenException('Срок заказа истёк — новых передач нет, полученное остаётся. Продлите заказ или создайте новый.');
  }

  private async getForEmployer(userId: string, engagementId: string) {
    const engagement = await this.prisma.employerAgencyEngagement.findUnique({ where: { id: engagementId } });
    if (!engagement) throw new NotFoundException(`Engagement ${engagementId} not found`);
    await assertInterviewPoolProjectAccess(this.prisma, userId, engagement.employerProjectId);
    return engagement;
  }
}

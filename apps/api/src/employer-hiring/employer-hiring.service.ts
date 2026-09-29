// Пункт [job-domain-v2] §7 / Р-0…Р-5 — поддомен «Работодатель»: ProjectMode
// EMPLOYER_HIRING поверх общего слоя найма (лист условий, конфиг, анкета,
// стадии, движок). Работодатель — всегда компания: проект остаётся
// ЧЕРНОВИКОМ до идентификации компании (досье на себя, §3.9); до этого
// операции с брифом, листом и текстом отвечают 409 «укажите компанию».
//
// Что здесь своего: создание проекта (с пустым конфигом — бриф разбирается
// до онбординга), онбординг-разговор как внутренний бриф (голосом или
// текстом → ClientBrief INTERNAL), правка конфига руками, состояние проекта
// для экрана. Всё остальное — общие сервисы с доступом по режиму.
//
// Что работодатель НЕ получает по построению (§10.3): ранг кандидатов,
// «вероятность принять оффер», сравнение ожиданий кандидатов числом,
// данные кандидата, которые тот не передал сам или через агентство.

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ClientBriefOrigin, EmploymentLoad, ProjectMode, RecruitingTeamType, WorkArrangement } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ensureOnboardingConversation } from '../common/onboarding-conversation';
import { assertInterviewPoolProjectAccess } from '../interview-pool/interview-pool-access';
import { ClientBriefService } from '../client-brief/client-brief.service';
import { manyCompaniesMessage } from '../employer-dossier/single-dossier';

export const EMPLOYER_ONBOARDING_CHECKLIST = [
  'Какая компания нанимает (название, код реестра или домен сайта)?',
  'Кого ищете и зачем — своими словами, как объяснили бы коллеге?',
  'Что обязательно, а что желательно у кандидата?',
  'Условия: оплата или вилка, формат (офис/гибрид/удалёнка), занятость, оформление?',
  'Как устроен отбор: этапы, кто собеседует, есть ли тестовое?',
  'Сроки: когда человек должен выйти?',
];

export interface EmployerConfigPatch {
  jobTitle?: string;
  extendedDescription?: string;
  salaryRange?: string | null;
  employmentLoad?: EmploymentLoad | null;
  workArrangement?: WorkArrangement | null;
  officeLocation?: string | null;
  employmentFormat?: string | null;
  perks?: string[];
}

@Injectable()
export class EmployerHiringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly briefs: ClientBriefService,
  ) {}

  /** Проект-вакансия. Конфиг создаётся сразу и пустым (§5.4). Команда —
   * только teamType EMPLOYER: смешать с командой агентства нельзя. */
  async createProject(userId: string, question: string, recruitingTeamId?: string) {
    if (!question.trim()) throw new BadRequestException('question не может быть пустым');
    if (recruitingTeamId) {
      const membership = await this.prisma.recruitingTeamMember.findUnique({
        where: { teamId_userId: { teamId: recruitingTeamId, userId } },
        include: { team: { select: { teamType: true } } },
      });
      if (!membership) throw new NotFoundException(`RecruitingTeam ${recruitingTeamId} not found`);
      if (membership.team.teamType !== RecruitingTeamType.EMPLOYER) {
        throw new BadRequestException('Проект работодателя ведёт команда компании (teamType EMPLOYER), не команда агентства');
      }
    }
    const project = await this.prisma.project.create({
      data: { ownerId: userId, question: question.trim(), mode: ProjectMode.EMPLOYER_HIRING, recruitingTeamId },
    });
    await this.prisma.interviewPoolConfig.create({ data: { projectId: project.id, jobTitle: '', extendedDescription: '' } });
    return project;
  }

  getChecklist(): string[] {
    return EMPLOYER_ONBOARDING_CHECKLIST;
  }

  async createOnboardingConversation(userId: string, projectId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    return ensureOnboardingConversation(this.prisma, projectId);
  }

  async appendAnswer(userId: string, conversationId: string, text: string) {
    if (!text.trim()) throw new BadRequestException('text не может быть пустым');
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, projectId: true } });
    if (!conversation) throw new NotFoundException(`Conversation ${conversationId} not found`);
    await assertInterviewPoolProjectAccess(this.prisma, userId, conversation.projectId);
    const transcript = await this.prisma.transcript.findUnique({ where: { conversationId } });
    if (!transcript) throw new NotFoundException(`Transcript for conversation ${conversationId} not found`);
    const participant = await this.prisma.conversationParticipant.findFirst({ where: { conversationId, isSelf: true } });
    const last = await this.prisma.transcriptSegment.findFirst({ where: { transcriptId: transcript.id }, orderBy: { endMs: 'desc' } });
    const startMs = (last?.endMs ?? 0) + 1;
    return this.prisma.transcriptSegment.create({
      data: { transcriptId: transcript.id, participantId: participant?.id ?? null, text: text.trim(), startMs, endMs: startMs },
    });
  }

  /** «Extract» работодателя — это внутренний бриф: ответы онбординга
   * (голосом или текстом) становятся ClientBrief INTERNAL дословно и
   * разбираются в черновики пунктов VACANCY-листа. Требует компании (409). */
  async extract(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, projectId: true } });
    if (!conversation) throw new NotFoundException(`Conversation ${conversationId} not found`);
    await assertInterviewPoolProjectAccess(this.prisma, userId, conversation.projectId);
    const segments = await this.prisma.transcriptSegment.findMany({
      where: { transcript: { conversationId } },
      orderBy: { startMs: 'asc' },
      select: { text: true },
    });
    if (segments.length === 0) throw new BadRequestException('В онбординге пока нет ответов — нечего извлекать');
    const brief = await this.briefs.ingest(userId, conversation.projectId, {
      rawText: segments.map((s) => s.text).join('\n'),
      source: 'внутренний бриф — онбординг голосом/текстом',
      origin: ClientBriefOrigin.INTERNAL,
    });
    return this.briefs.extract(userId, brief.id);
  }

  /** Конфиг правится руками (у агентства его пишет extract; у работодателя
   * источник истины — бриф и подтверждённые пункты). */
  async updateConfig(userId: string, projectId: string, patch: EmployerConfigPatch) {
    await this.assertEmployerProject(userId, projectId);
    await this.assertCompanyIdentified(projectId);
    const data = {
      jobTitle: patch.jobTitle?.trim(),
      extendedDescription: patch.extendedDescription?.trim(),
      salaryRange: patch.salaryRange === undefined ? undefined : patch.salaryRange,
      employmentLoad: patch.employmentLoad === undefined ? undefined : patch.employmentLoad,
      workArrangement: patch.workArrangement === undefined ? undefined : patch.workArrangement,
      officeLocation: patch.officeLocation === undefined ? undefined : patch.officeLocation,
      employmentFormat: patch.employmentFormat === undefined ? undefined : patch.employmentFormat,
      perks: patch.perks,
    };
    // Пункт [check-then-create-2] 2026-09-27. Было «прочитать конфиг;
    // нет — создать, есть — обновить», и это давало сразу два дефекта.
    // Гонка: `projectId` уникален, и второй одновременный вызов падал бы
    // с P2002 — внутренняя ошибка на действии, которое уже удалось. И
    // РАЗНЫЙ ОТВЕТ на одно и то же действие: ветка создания возвращала
    // конфиг БЕЗ вопросов и стадий, ветка обновления — с ними, то есть
    // форма ответа зависела от того, первый это вызов или второй (тот же
    // дефект, что разбирался в [same-answer-either-way]).
    return this.prisma.interviewPoolConfig.upsert({
      where: { projectId },
      update: data,
      create: { projectId, ...data, jobTitle: data.jobTitle ?? '', extendedDescription: data.extendedDescription ?? '' },
      include: { questions: { orderBy: { orderIndex: 'asc' } }, interviewStages: { orderBy: { orderIndex: 'asc' } } },
    });
  }

  async getConfig(userId: string, projectId: string) {
    await this.assertEmployerProject(userId, projectId);
    const config = await this.prisma.interviewPoolConfig.findUnique({
      where: { projectId },
      include: { questions: { orderBy: { orderIndex: 'asc' } }, interviewStages: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!config) throw new NotFoundException(`InterviewPoolConfig for project ${projectId} not found`);
    return config;
  }

  /** Состояние проекта для хаба (§8.3): черновик до компании, что уже есть. */
  async getState(userId: string, projectId: string) {
    const project = await this.assertEmployerProject(userId, projectId);
    // Пункт [one-of-several-spoke-for-all] 2026-09-25: здесь стоял
    // `findFirst` С СОРТИРОВКОЙ — то есть выбор был воспроизводимым, но
    // от этого не переставал быть произвольным: хаб показывал одну из
    // компаний как ЕДИНСТВЕННУЮ. Сортировка лечит недетерминизм, а не
    // подмену; когда компаний несколько, продукт обязан это сказать.
    const dossiers = await this.prisma.employerDossier.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { representatives: true },
      take: 25,
    });
    const dossier = dossiers.length === 1 ? dossiers[0] : null;
    const companyChoice =
      dossiers.length > 1
        ? manyCompaniesMessage(dossiers.map((d: { legalName: string | null; domain: string | null; registryCode: string | null; id: string }) => d.legalName ?? d.domain ?? d.registryCode ?? d.id))
        : null;
    const config = await this.prisma.interviewPoolConfig.findUnique({ where: { projectId }, include: { questions: { select: { id: true } } } });
    const [briefs, vacancySheet, candidates, engagements, offers] = await Promise.all([
      this.prisma.clientBrief.count({ where: { projectId } }),
      this.prisma.termsSheet.findFirst({ where: { projectId, kind: 'VACANCY' }, select: { id: true, status: true } }),
      this.prisma.candidatePipelineStatus.count({ where: { projectId } }),
      this.prisma.employerAgencyEngagement.findMany({ where: { employerProjectId: projectId }, select: { id: true, status: true, agencyProjectId: true, sharedItems: true, expiresAt: true } }),
      this.prisma.offerDocument.count({ where: { sheet: { projectId }, reviewedAt: { not: null } } }),
    ]);
    return {
      projectId,
      question: project.question,
      // Черновик — это «компании нет». «Компаний несколько» — другое
      // состояние, и называется оно отдельно, а не сводится к первому.
      draft: dossiers.length === 0,
      draftReason: dossiers.length === 0 ? 'Укажите компанию: проект работодателя остаётся черновиком до идентификации компании' : null,
      company: dossier,
      companyChoice,
      config: config ? { id: config.id, jobTitle: config.jobTitle, questions: config.questions.length } : null,
      briefs,
      vacancySheet,
      candidates,
      engagements,
      reviewedOffers: offers,
    };
  }

  private async assertEmployerProject(userId: string, projectId: string) {
    const project = await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    if (project.mode !== ProjectMode.EMPLOYER_HIRING) throw new NotFoundException(`Project ${projectId} not found`);
    return project;
  }

  private async assertCompanyIdentified(projectId: string) {
    const dossier = await this.prisma.employerDossier.findFirst({ where: { projectId } });
    if (!dossier) throw new ConflictException({ message: 'Укажите компанию: проект работодателя остаётся черновиком до идентификации компании (досье на себя)', code: 'COMPANY_REQUIRED' });
  }
}

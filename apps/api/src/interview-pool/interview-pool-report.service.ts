// Пункт [interview-pool] (devils-advocate-interview-pool-tz.md §4.9):
// звіти для замовника — по кандидату й зведений по всьому пулу.

import { BadRequestException, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ClientReportType, CandidateStage } from '@prisma/client';
import { assertInterviewPoolProjectAccess } from './interview-pool-access';
import { assertConsentActive, consentRevoked } from './consent-revocation';
import { daysAgo } from '../common/server-time';
import { hasPersonVerdict } from '../common/no-person-verdict';

const CONCLUSION_TASK_TYPE = 'interview-pool-client-report-conclusion';

interface RawConclusion {
  conclusion: string;
}

function isValidConclusion(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    // Пункт [the-second-line-skipped-the-hiring-side] 2026-10-01: здесь
    // проверялась только непустота строки, а строка эта — СВОБОДНЫЙ
    // ВЫВОД ПО НАЗВАННОМУ ЧЕЛОВЕКУ, который читает решающий. Вторая
    // линия та же, что у остальных разборов уровня человека.
    if (hasPersonVerdict(text)) return false;
    return typeof parsed?.conclusion === 'string' && parsed.conclusion.trim().length > 0;
  } catch {
    return false;
  }
}

@Injectable()
export class InterviewPoolReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  /** §4.9 ТЗ, PER_CANDIDATE — processDescription з CandidateStageProgress,
   * criteriaBreakdown ЧИТАЄТЬСЯ з уже наявного PoolRelevanceEntry (не
   * рахується заново), conclusion — окремий AI-виклик narrative-
   * висновку, без вердикта. */
  /** Пункт [job-domain-v2]: список отчётов проекта — экрану TMA нужен для
   * доставки заказчику (Р-4: только проверенные). Раньше списка не было —
   * отчёты жили только в состоянии экрана, который их создал. */
  async list(userId: string, projectId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    return this.prisma.clientReport.findMany({ where: { projectId }, orderBy: { draftedAt: 'desc' } });
  }

  async generateCandidateReport(userId: string, projectId: string, candidateProfileId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    // А-6: отзыв согласия останавливает разбор по этому человеку (аудит 2026-09-03)
    await assertConsentActive(this.prisma, candidateProfileId);

    const status = await this.prisma.candidatePipelineStatus.findUnique({
      where: { projectId_candidateProfileId: { projectId, candidateProfileId } },
      include: {
        candidateProfile: true,
        stageProgress: { include: { stageDefinition: true }, orderBy: { stageDefinition: { orderIndex: 'asc' } } },
      },
    });
    if (!status) {
      throw new NotFoundException(`Candidate ${candidateProfileId} not found in pool ${projectId}`);
    }

    const latestSnapshot = await this.prisma.poolRelevanceSnapshot.findFirst({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { entries: { where: { candidateProfileId } } },
    });
    const relevanceEntry = latestSnapshot?.entries[0];

    const processDescription = status.stageProgress
      .map(
        (p: any) =>
          // Пункт [server-said-which-day] 2026-09-24: число по UTC
          // заменено расстоянием во времени — для описания процесса
          // важно «когда относительно сейчас», а не календарь.
          `${p.stageDefinition.name}: ${p.completedAt ? `завершено ${daysAgo(p.completedAt)}` : 'ще не завершено'}`,
      )
      .join('; ');

    const config = await this.prisma.interviewPoolConfig.findUnique({ where: { projectId } });
    const conclusionDraft = await this.draftConclusion(
      userId,
      projectId,
      config?.jobTitle ?? '',
      status.candidateProfile.displayName,
      processDescription,
      relevanceEntry?.attentionPoints ?? [],
    );

    return this.prisma.clientReport.create({
      data: {
        projectId,
        type: ClientReportType.PER_CANDIDATE,
        candidateProfileId,
        content: {
          processDescription,
          criteriaBreakdown: relevanceEntry?.criteriaBreakdown ?? null,
          conclusion: conclusionDraft,
        } as any,
      },
    });
  }

  /** §4.9 ТЗ, SUMMARY — funnel рахується напряму з CandidatePipelineStatus,
   * entries впорядковані за прозорою coverage-метрикою (частка
   * isRequired-пунктів з coverage="covered"), НЕ прихованим AI-балом. */
  async generateSummaryReport(userId: string, projectId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);

    // А-6: кандидаты с отозванным согласием не попадают в отчёт заказчику —
    // ни в воронку, ни в список (аудит 2026-09-03). Их число называется явно:
    // молча уменьшившаяся воронка выглядела бы как потеря данных.
    const allStatuses = await this.prisma.candidatePipelineStatus.findMany({
      where: { projectId },
      include: { candidateProfile: true },
    });
    const statuses = allStatuses.filter((s: any) => !consentRevoked(s));

    const funnel: { totalCandidates: number; byStage: Record<string, number> } = {
      totalCandidates: statuses.length,
      byStage: {},
    };
    for (const stage of Object.values(CandidateStage)) {
      funnel.byStage[stage as string] = statuses.filter((s: any) => s.stage === stage).length;
    }

    const latestSnapshot = await this.prisma.poolRelevanceSnapshot.findFirst({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { entries: true },
    });
    const config = await this.prisma.interviewPoolConfig.findUnique({
      where: { projectId },
      include: { questions: { where: { isRequired: true } } },
    });
    const requiredCount = config?.questions.length ?? 0;

    const entries = statuses.map((status: any) => {
      const entry = latestSnapshot?.entries.find((e: any) => e.candidateProfileId === status.candidateProfileId);
      const breakdown = (entry?.criteriaBreakdown as any[] | undefined) ?? [];
      const requiredIds = new Set(config?.questions.map((q) => q.id) ?? []);
      // Set, а не length (аудит 2026-09-02): дубль questionnaireItemId
      // в ответе модели давал coverageScore > 1 и искажал сортировку
      // «релевантнее сверху» — метрику, которую лендинг обещает как
      // прозрачную.
      const coveredRequired = new Set(
        breakdown.filter((b: any) => requiredIds.has(b.questionnaireItemId) && b.coverage === 'covered').map((b: any) => b.questionnaireItemId),
      ).size;
      const coverageScore = requiredCount > 0 ? coveredRequired / requiredCount : 0;
      return {
        candidateProfileId: status.candidateProfileId,
        displayName: status.candidateProfile.displayName,
        stage: status.stage,
        coverageScore,
      };
    });
    // "релевантніші зверху" (§4.9 ТЗ) — сортування за прозорою,
    // порахованою метрикою, не прихованим AI-балом.
    entries.sort((a, b) => b.coverageScore - a.coverageScore);

    return this.prisma.clientReport.create({
      data: {
        projectId,
        type: ClientReportType.SUMMARY,
        content: {
          funnel,
          entries,
          // Отозвавшие согласие не в отчёте, но их число названо — иначе
          // расхождение с пулом читается как потеря данных (А-6).
          excludedByRevokedConsent: allStatuses.length - statuses.length,
        } as any,
      },
    });
  }

  async updateContent(userId: string, reportId: string, content: unknown) {
    const report = await this.assertOwnedReport(userId, reportId);
    if (report.sentAt) {
      throw new BadRequestException('Отчёт уже отправлен — редактирование недоступно');
    }
    return this.prisma.clientReport.update({ where: { id: reportId }, data: { content: content as any } });
  }

  async review(userId: string, reportId: string) {
    await this.assertOwnedReport(userId, reportId);
    return this.prisma.clientReport.update({
      where: { id: reportId },
      data: { reviewedAt: new Date(), reviewedByUserId: userId },
    });
  }

  /** §4.9 ТЗ — reviewedAt обов'язковий перед sentAt, технічний гейт,
   * не тільки процесна рекомендація в UI. */
  async send(userId: string, reportId: string, sentViaShare: string) {
    const report = await this.assertOwnedReport(userId, reportId);
    if (!report.reviewedAt) {
      throw new BadRequestException('Отчёт не прошёл ревью — reviewedAt обязателен перед отправкой');
    }
    return this.prisma.clientReport.update({
      where: { id: reportId },
      data: { sentAt: new Date(), sentViaShare },
    });
  }

  private async draftConclusion(
    userId: string,
    projectId: string,
    jobTitle: string,
    candidateName: string,
    processDescription: string,
    attentionPoints: string[],
  ): Promise<string> {
    try {
      const result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: CONCLUSION_TASK_TYPE,
        systemPrompt:
          'На основе данных о кандидате и процессе собеседований сформулируй краткий связный narrative-вывод для клиента-заказчика — что стоит взять на заметку по этому кандидату, БЕЗ вердикта "нанять/отклонить" (это решение заказчика, не системы). Ответь СТРОГО валидным JSON вида {"conclusion": string}. Без пояснений вне JSON.',
        userPrompt: `Вакансія: ${jobTitle}\nКандидат: ${candidateName}\nПроцес: ${processDescription || 'ще не розпочато'}\nСигнали до уваги: ${attentionPoints.join('; ') || 'немає'}`,
        jsonMode: true,
        maxTokens: 600,
        validateOutput: isValidConclusion,
      });
      const parsed: RawConclusion = JSON.parse(result.text);
      return parsed.conclusion;
    } catch (err) {
      // [ai-errors] 2026-09-02: здесь ОСОЗНАННО НЕ общий шлюз
      // rethrowClientVisibleAiError. Это точка ЧЕСТНОЙ ДЕГРАДАЦИИ:
      // отсутствие модели (не засеяна база, нет ключа) обязано
      // деградировать, как и любой другой сбой AI, а не ронять фичу
      // целиком — иначе шлюз, задуманный как «конфигурация не должна
      // выглядеть отказом», сам превратил бы конфигурацию в отказ.
      // Наружу уходит только отсутствие прав.
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Генерация вывода отклонена проверкой безопасности содержимого.');
      }
      // Чесна деградація — звіт усе одно створюється, просто без
      // готового narrative-тексту, рекрутер допише вручну перед review.
      return '';
    }
  }

  private async assertOwnedReport(userId: string, reportId: string) {
    const report = await this.prisma.clientReport.findUnique({ where: { id: reportId } });
    if (!report) {
      throw new NotFoundException(`ClientReport ${reportId} not found`);
    }
    await assertInterviewPoolProjectAccess(this.prisma, userId, report.projectId);
    return report;
  }
}

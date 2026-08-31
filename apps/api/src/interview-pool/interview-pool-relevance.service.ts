// Пункт [interview-pool] (devils-advocate-interview-pool-tz.md §4.3/§4.4):
// порівняльне ранжування по всьому пулу — "радник, не суддя"
// реалізовано технічно тут, не тільки продекларовано (§2.3 ТЗ).

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { CandidateStage } from '@prisma/client';
import { assertInterviewPoolProjectAccess } from './interview-pool-access';

const TASK_TYPE = 'interview-pool-relevance';

interface RawCriterionResult {
  questionnaireItemId: string;
  coverage: 'covered' | 'partial' | 'not_covered';
  note: string;
  sourceSegmentId?: string | null;
}

interface RawCandidateAssessment {
  criteriaBreakdown: RawCriterionResult[];
  attentionPoints: string[];
  followUpRequests: string[];
}

function isValidAssessment(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.criteriaBreakdown)) return false;
    if (!Array.isArray(parsed?.attentionPoints)) return false;
    if (!Array.isArray(parsed?.followUpRequests)) return false;
    return parsed.criteriaBreakdown.every(
      (c: any) =>
        typeof c?.questionnaireItemId === 'string' &&
        ['covered', 'partial', 'not_covered'].includes(c?.coverage) &&
        typeof c?.note === 'string',
    );
  } catch {
    return false;
  }
}

// §2.4 ТЗ, наскрізна вимога — жорстка заборона в system prompt, не
// тільки сподівання, що модель сама здогадається. §2.6 ТЗ —
// genderRequirement/ageRequirement/isPhysicallyDemanding НІКОЛИ не
// потрапляють у контекст цього виклику (перевіряється тестом на
// побудові запиту, не тільки постфактум на виводі).
const SYSTEM_PROMPT =
  'Тебе дано транскрипт(и) співбесіди(конкретного кандидата з переліком питань анкети вакансії. ' +
  'Для КОЖНОГО питання анкети визнач coverage: "covered" (відповідь явно й повністю розкрила питання), ' +
  '"partial" (торкнулись, але не повністю), "not_covered" (питання взагалі не піднімалось) — з note (коротке обґрунтування) ' +
  'і sourceSegmentId (id репліки-джерела, якщо covered/partial). ' +
  'Також сформуй attentionPoints — сигнали, на які варто звернути увагу людині (НЕ вердикт "цей кандидат поганий", формулюй як "потребує перевірки", не як висновок), ' +
  'і followUpRequests — конкретні прогалини, які закриваються документом/прикладом роботи (не загальні побажання). ' +
  'КРИТИЧНО ВАЖЛИВО: НІКОЛИ не використовуй расу, стать, вік, релігію, інвалідність, вагітність, національність, сексуальну орієнтацію чи будь-які непрямі проксі-ознаки цих категорій (наприклад назва навчального закладу як маркер соціального класу, географія походження тощо) як підставу для жодного висновку — якщо в транскрипті це прозвучало, ІГНОРУЙ це повністю при оцінці. ' +
  'Відповідай СТРОГО валідним JSON вида {"criteriaBreakdown": [{"questionnaireItemId": string, "coverage": string, "note": string, "sourceSegmentId": string|null}], "attentionPoints": string[], "followUpRequests": string[]}. Без пояснень поза ним.';

@Injectable()
export class InterviewPoolRelevanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  /** §4.3 ТЗ — знімок формується після КОЖНОЇ завершеної співбесіди,
   * бере ВСІ завершені співбесіди пулу (не тільки щойно завершену),
   * для КОЖНОГО кандидата пулу — один AI-виклик. Новий
   * PoolRelevanceSnapshot, не перезапис попереднього — історія
   * лишається доступною. */
  async regenerate(userId: string, projectId: string, triggerConversationId?: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);

    const config = await this.prisma.interviewPoolConfig.findUnique({
      where: { projectId },
      include: { questions: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!config) {
      throw new NotFoundException(`InterviewPoolConfig for project ${projectId} not found`);
    }
    if (config.questions.length === 0) {
      throw new BadRequestException('У цього пулу ще немає зафіксованої анкети — нічого порівнювати');
    }

    const statuses = await this.prisma.candidatePipelineStatus.findMany({
      where: { projectId },
      include: {
        candidateProfile: true,
        // АУДИТ: раніше без completedAt — незавершена співбесіда
        // (conversationId вже прив'язаний через recordStageProgress,
        // але completedAt ще не проставлено) потрапляла б у оцінку
        // передчасно, з частковим транскриптом. §4.3 ТЗ буквально:
        // "після КОЖНОЇ ЗАВЕРШЕНОЇ співбесіди".
        stageProgress: { where: { conversationId: { not: null }, completedAt: { not: null } } },
      },
    });

    const snapshot = await this.prisma.poolRelevanceSnapshot.create({
      data: { projectId, triggerConversationId },
    });

    for (const status of statuses) {
      const conversationIds = status.stageProgress.map((p: { conversationId: string | null }) => p.conversationId!).filter(Boolean);
      if (conversationIds.length === 0) continue; // §4.3 ТЗ мовчазно передбачає завершені співбесіди — без жодної розшифрованої розмови просто нема що оцінювати

      const assessment = await this.assessCandidate(userId, projectId, config, conversationIds);
      if (!assessment) continue; // честная деградация — сбой AI на одном кандидате не должен ронять весь снимок

      await this.prisma.poolRelevanceEntry.create({
        data: {
          snapshotId: snapshot.id,
          candidateProfileId: status.candidateProfileId,
          criteriaBreakdown: assessment.criteriaBreakdown as any,
          attentionPoints: assessment.attentionPoints,
          followUpRequestsDraft: assessment.followUpRequests,
        },
      });

      // §4.4 ТЗ — єдиний автоматичний перехід стадії, що система
      // робить сама: організаційний трекінг "чекаємо на матеріали",
      // не рішення про найм.
      if (assessment.followUpRequests.length > 0) {
        await this.prisma.candidateFollowUpRequest.createMany({
          data: assessment.followUpRequests.map((text) => ({ statusId: status.id, requestText: text })),
        });
        await this.prisma.candidatePipelineStatus.update({
          where: { id: status.id },
          data: { stage: CandidateStage.AWAITING_FOLLOWUP },
        });
      }
    }

    return this.getSnapshot(userId, snapshot.id);
  }

  async getLatest(userId: string, projectId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    const snapshot = await this.prisma.poolRelevanceSnapshot.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { entries: { include: { candidateProfile: true } } },
    });
    if (!snapshot) {
      throw new NotFoundException(`No PoolRelevanceSnapshot for project ${projectId} yet`);
    }
    return snapshot;
  }

  async getHistory(userId: string, projectId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    return this.prisma.poolRelevanceSnapshot.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { entries: true },
    });
  }

  private async getSnapshot(userId: string, snapshotId: string) {
    return this.prisma.poolRelevanceSnapshot.findUnique({
      where: { id: snapshotId },
      include: { entries: { include: { candidateProfile: true } } },
    });
  }

  /** §2.4/§2.6 ТЗ — побудова контексту для AI НІКОЛИ не включає
   * genderRequirement/ageRequirement/isPhysicallyDemanding конфігу —
   * структурна гарантія, не постфактум-фільтр виводу. */
  private async assessCandidate(
    userId: string,
    projectId: string,
    config: { id: string; jobTitle: string; questions: Array<{ id: string; text: string; category: string | null; isRequired: boolean }> },
    conversationIds: string[],
  ): Promise<RawCandidateAssessment | null> {
    const segments = await this.prisma.transcriptSegment.findMany({
      where: { transcript: { conversationId: { in: conversationIds } } },
      orderBy: { startMs: 'asc' },
    });
    if (segments.length === 0) return null;

    const transcriptText = segments.map((s: { id: string; text: string }) => `[id=${s.id}] ${s.text}`).join('\n');
    const questionsText = config.questions
      .map((q) => `[id=${q.id}] ${q.text}${q.isRequired ? ' (обов\'язково)' : ''}`)
      .join('\n');
    const userPrompt = `Вакансія: ${config.jobTitle}\n\nПитання анкети:\n${questionsText}\n\nТранскрипт співбесіди:\n${transcriptText}`;

    try {
      const result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: TASK_TYPE,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 3000,
        validateOutput: isValidAssessment,
      });
      return JSON.parse(result.text) as RawCandidateAssessment;
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) return null;
      // Чесна деградація — збій одного AI-виклику не повинен провалити
      // весь знімок пулу (інші кандидати могли обробитись успішно).
      return null;
    }
  }
}

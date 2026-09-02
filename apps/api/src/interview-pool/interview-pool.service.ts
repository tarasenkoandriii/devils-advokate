// Пункт [interview-pool] (devils-advocate-interview-pool-tz.md §4.1/§4.7/§5).

import { BadGatewayException, BadRequestException, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { CandidateStage } from '@prisma/client';
import { ExtractedPoolConfigDraft } from './interview-pool-onboarding.service';
import { assertInterviewPoolProjectAccess } from './interview-pool-access';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const QUESTIONNAIRE_TASK_TYPE = 'interview-pool-questionnaire-draft';
const AGENDA_REUSE_TASK_TYPE = 'interview-pool-agenda-reuse-detection';

function isValidCoveredIdsPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string');
  } catch {
    return false;
  }
}

export interface DraftQuestionnaireItem {
  text: string;
  category: string | null;
  orderIndex: number;
  isRequired: boolean;
}

function isValidQuestionnaire(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every((i) => typeof i?.text === 'string' && i.text.trim().length > 0);
  } catch {
    return false;
  }
}

const QUESTIONNAIRE_SYSTEM_PROMPT =
  'Тебе дан розширений опис вакансії. Сформуй чернетку опитувальника з 20-30 конкретних питань для співбесіди — структурованих, з категоріями ' +
  '("технічні навички"/"культурна відповідність"/"мотивація" тощо, довільні, релевантні саме цій вакансії). ' +
  'Кожен пункт: text (саме питання), category (рядок або null), isRequired (true, якщо критично закрити, false — "якщо буде час"). ' +
  'Відповідай СТРОГО валідним JSON-масивом об\'єктів {"text": string, "category": string|null, "isRequired": boolean}. Без пояснень поза ним.';

@Injectable()
export class InterviewPoolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  // ── Конфіг (§4.1/§4.8 ТЗ — фіксація чернетки з онбордінгу) ──

  async createConfig(userId: string, projectId: string, draft: ExtractedPoolConfigDraft) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);

    const existing = await this.prisma.interviewPoolConfig.findUnique({ where: { projectId } });
    if (existing) {
      throw new BadRequestException(`InterviewPoolConfig for project ${projectId} already exists`);
    }

    return this.prisma.interviewPoolConfig.create({
      data: {
        projectId,
        jobTitle: draft.jobTitle,
        extendedDescription: draft.extendedDescription,
        salaryRange: draft.salaryRange ?? undefined,
        employmentLoad: draft.employmentLoad ?? undefined,
        workArrangement: draft.workArrangement ?? undefined,
        officeLocation: draft.officeLocation ?? undefined,
        employmentFormat: draft.employmentFormat ?? undefined,
        perks: draft.perks,
        genderRequirement: draft.genderRequirement,
        ageRequirement: draft.ageRequirement,
        minAge: draft.minAge ?? undefined,
        maxAge: draft.maxAge ?? undefined,
        isPhysicallyDemanding: draft.isPhysicallyDemanding,
        interviewStages: {
          create: draft.interviewStages.map((s) => ({
            name: s.name,
            orderIndex: s.orderIndex,
            isTestAssignment: s.isTestAssignment,
            interviewerRole: s.interviewerRole ?? undefined,
          })),
        },
        // §2.6a ТЗ — persist разом з конфігом (не під час самого
        // онбордінгу, того configId ще не існувало) — chicken-egg,
        // вирішений тим самим способом, що major-purchase.
        complianceFlags: {
          create: draft.complianceFlags.map((c) => ({ category: c.category, quotedText: c.quotedText })),
        },
      },
      include: { interviewStages: { orderBy: { orderIndex: 'asc' } }, complianceFlags: true },
    });
  }

  async getConfig(userId: string, projectId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    const config = await this.prisma.interviewPoolConfig.findUnique({
      where: { projectId },
      include: { interviewStages: { orderBy: { orderIndex: 'asc' } }, questions: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!config) {
      throw new NotFoundException(`InterviewPoolConfig for project ${projectId} not found`);
    }
    return config;
  }

  /** §2.6/2.6a ТЗ — видиме тільки агенції/власнику, ніколи в ClientReport. */
  async getComplianceFlags(userId: string, projectId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    const config = await this.prisma.interviewPoolConfig.findUnique({ where: { projectId } });
    if (!config) {
      throw new NotFoundException(`InterviewPoolConfig for project ${projectId} not found`);
    }
    return this.prisma.complianceFlag.findMany({ where: { configId: config.id }, orderBy: { createdAt: 'asc' } });
  }

  // ── Квіз (§4.1 ТЗ) ──

  async generateQuestionnaireDraft(userId: string, projectId: string): Promise<DraftQuestionnaireItem[]> {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    const config = await this.prisma.interviewPoolConfig.findUnique({ where: { projectId } });
    if (!config) {
      throw new NotFoundException(`InterviewPoolConfig for project ${projectId} not found`);
    }

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: QUESTIONNAIRE_TASK_TYPE,
        systemPrompt: QUESTIONNAIRE_SYSTEM_PROMPT,
        userPrompt: `${config.jobTitle}\n\n${config.extendedDescription}`,
        jsonMode: true,
        maxTokens: 3000,
        validateOutput: isValidQuestionnaire,
      });
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
        throw new BadRequestException('Генерация опросника отклонена проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось сгенерировать опросник — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const parsed = JSON.parse(result.text) as Array<{ text: string; category: string | null; isRequired: boolean }>;
    return parsed.map((p, i) => ({ text: p.text, category: p.category ?? null, orderIndex: i, isRequired: p.isRequired ?? true }));
  }

  /** §4.1 ТЗ — "AI пропонує, людина стверджує": фіксація чернетки,
   * викликається один раз, замінює будь-які попередні QuestionnaireItem
   * цього конфігу (той самий пул не повинен мати дві паралельні бази
   * питань — порівнюваність між кандидатами вимагає однакового набору). */
  async fixQuestionnaire(userId: string, projectId: string, items: DraftQuestionnaireItem[]) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    const config = await this.prisma.interviewPoolConfig.findUnique({ where: { projectId } });
    if (!config) {
      throw new NotFoundException(`InterviewPoolConfig for project ${projectId} not found`);
    }
    if (items.length === 0) {
      throw new BadRequestException('items не может быть пустым');
    }

    // АУДИТ: раніше deleteMany+createMany були двома окремими await
    // поза транзакцією — збій між ними (наприклад падіння процесу)
    // міг лишити пул БЕЗ жодного питання анкети. Обгорнуто в
    // $transaction, той самий принцип, що вже застосований в
    // createOnboardingConversation.
    await this.prisma.$transaction([
      this.prisma.questionnaireItem.deleteMany({ where: { configId: config.id } }),
      this.prisma.questionnaireItem.createMany({
        data: items.map((i) => ({ configId: config.id, text: i.text, category: i.category, orderIndex: i.orderIndex, isRequired: i.isRequired })),
      }),
    ]);
    return this.prisma.questionnaireItem.findMany({ where: { configId: config.id }, orderBy: { orderIndex: 'asc' } });
  }

  // ── Кандидати (§4.7 ТЗ — "не з нуля") ──

  /** reuseHistory — чекбокс §4.7 ТЗ, за замовчуванням false (свідомий
   * вибір рекрутера щоразу, не тиха поведінка). Якщо true й попередній
   * пул мав іншу jobTitle — historyDisclaimer заповнюється точним
   * текстом попередньої вакансії, ДЕТЕРМІНОВАНО (порівняння рядків),
   * не AI-оцінка "наскільки вакансії схожі". */
  async addCandidate(userId: string, projectId: string, candidateProfileId: string, reuseHistory: boolean) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    await this.assertAccessibleCandidate(userId, candidateProfileId);

    const existing = await this.prisma.candidatePipelineStatus.findUnique({
      where: { projectId_candidateProfileId: { projectId, candidateProfileId } },
    });
    if (existing) {
      throw new BadRequestException(`Candidate ${candidateProfileId} already in this pool`);
    }

    const status = await this.prisma.candidatePipelineStatus.create({
      data: { projectId, candidateProfileId, stage: CandidateStage.SCHEDULED, reuseHistory },
    });

    let historyDisclaimer: string | undefined;
    if (reuseHistory) {
      const priorStatuses = await this.prisma.candidatePipelineStatus.findMany({
        where: { candidateProfileId, projectId: { not: projectId } },
        include: { project: { include: { interviewPoolConfig: true } } },
        orderBy: { createdAt: 'desc' },
      });
      const currentConfig = await this.prisma.interviewPoolConfig.findUnique({ where: { projectId } });
      const priorWithDifferentTitle = priorStatuses.find(
        (s: any) => s.project.interviewPoolConfig && s.project.interviewPoolConfig.jobTitle !== currentConfig?.jobTitle,
      );
      if (priorWithDifferentTitle) {
        const prevTitle = (priorWithDifferentTitle as any).project.interviewPoolConfig.jobTitle;
        historyDisclaimer = `Ці дані зі співбесіди на іншу вакансію («${prevTitle}») — релевантність для поточної позиції може відрізнятися, перевірте вручну`;
      }
    }

    return { ...status, historyDisclaimer };
  }

  async listCandidates(userId: string, projectId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    return this.prisma.candidatePipelineStatus.findMany({
      where: { projectId },
      include: { candidateProfile: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** §4.2/§4.7 ТЗ — план бесіди: QuestionnaireItem[] пулу, isRequired
   * спершу. Якщо reuseHistory=true було відмічено при addCandidate() —
   * питання, що вже фактично прозвучали в ПОПЕРЕДНІЙ завершеній
   * співбесіді того самого кандидата (в іншому пулі), виключаються
   * через семантичне зіставлення (AI-виклик, не точний збіг рядка).
   *
   * АУДИТ ЗНАЙШОВ: попередня версія методу мала докстрінг, що
   * ОБІЦЯВ цю фільтрацію, але код просто повертав усі питання без
   * жодної обробки — reuseHistory навіть не зберігався ніде. Обидва
   * виправлено: поле персистується (розділ схеми), фільтрація
   * реалізована тут насправді. */
  async getAgenda(userId: string, projectId: string, candidateProfileId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);
    const config = await this.prisma.interviewPoolConfig.findUnique({
      where: { projectId },
      include: { questions: { orderBy: [{ isRequired: 'desc' }, { orderIndex: 'asc' }] } },
    });
    if (!config) {
      throw new NotFoundException(`InterviewPoolConfig for project ${projectId} not found`);
    }

    const status = await this.prisma.candidatePipelineStatus.findUnique({
      where: { projectId_candidateProfileId: { projectId, candidateProfileId } },
    });
    if (!status || !status.reuseHistory) {
      return config.questions;
    }

    // Прості завершені стадії того самого кандидата в ІНШИХ пулах —
    // джерело "попередньої розмови" (§4.7 ТЗ).
    const priorStageProgress = await this.prisma.candidateStageProgress.findMany({
      where: {
        status: { candidateProfileId, projectId: { not: projectId } },
        conversationId: { not: null },
        completedAt: { not: null },
      },
      select: { conversationId: true },
    });
    const priorConversationIds = priorStageProgress.map((p: { conversationId: string | null }) => p.conversationId!).filter(Boolean);
    if (priorConversationIds.length === 0) {
      return config.questions; // reuseHistory=true, але попередньої завершеної розмови насправді немає — чесна деградація, не помилка
    }

    const segments = await this.prisma.transcriptSegment.findMany({
      where: { transcript: { conversationId: { in: priorConversationIds } } },
      orderBy: { startMs: 'asc' },
    });
    if (segments.length === 0) {
      return config.questions;
    }

    const coveredIds = await this.detectCoveredQuestions(userId, projectId, config.questions, segments);
    if (coveredIds === null) {
      // Чесна деградація — збій AI-класифікації не повинен блокувати
      // рекрутера чи мовчки показувати неповний план: повертаємо
      // ПОВНИЙ, нефільтрований список.
      return config.questions;
    }
    return config.questions.filter((q: { id: string }) => !coveredIds.has(q.id));
  }

  /** Семантичне зіставлення (§4.2 ТЗ: "не точний збіг рядка") —
   * повертає null при будь-якому збої (мережа/невалідний JSON), не
   * кидає виняток, щоб getAgenda() міг чесно деградувати до повного
   * списку. */
  private async detectCoveredQuestions(
    userId: string,
    projectId: string,
    questions: Array<{ id: string; text: string }>,
    segments: Array<{ text: string }>,
  ): Promise<Set<string> | null> {
    const questionsText = questions.map((q) => `[id=${q.id}] ${q.text}`).join('\n');
    const transcriptText = segments.map((s) => s.text).join('\n');
    try {
      const result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: AGENDA_REUSE_TASK_TYPE,
        systemPrompt:
          'Тебе дано транскрипт ПОПЕРЕДНЬОЇ співбесіди з тим самим кандидатом (на іншу вакансію) і перелік питань анкети НОВОЇ вакансії. ' +
          'Визнач, які з питань кандидат УЖЕ фактично розкрив своєю відповіддю в попередній розмові — семантично, не за точним збігом слів. ' +
          'Відповідай СТРОГО валідним JSON-масивом id тих питань, що вже покриті (порожній масив, якщо жодне). Без пояснень поза ним.',
        userPrompt: `Питання анкети:\n${questionsText}\n\nТранскрипт попередньої співбесіди:\n${transcriptText}`,
        jsonMode: true,
        maxTokens: 800,
        validateOutput: isValidCoveredIdsPayload,
      });
      const ids = JSON.parse(result.text) as string[];
      return new Set(ids);
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть // відсутність згоди на AI — реальна проблема прав, не ховається за деградацією
      return null;
    }
  }

  /** ВІДСУТНЄ В ТЗ, ЗНАЙДЕНО ПРИ РЕАЛІЗАЦІЇ: схема має
   * CandidateStageProgress.conversationId, але жоден ендпоінт §5/§6
   * не описує, як цей зв'язок взагалі створюється — тільки згадка про
   * "completedAt проставляється рекрутером вручну" (§8, останній
   * пункт "виключено"). Без цього методу PoolRelevanceSnapshot
   * (розділ 4.3) не мав би способу знайти "співбесіди кандидата" —
   * CandidateProfile НЕ пов'язаний з ConversationParticipant/Person
   * напряму (та сама причина, що й уся ревізія §3.0: не Person).
   * Саме CandidateStageProgress.conversationId — єдиний місток між
   * реальною розшифрованою розмовою й конкретним кандидатом. */
  async recordStageProgress(
    userId: string,
    statusId: string,
    stageDefinitionId: string,
    conversationId?: string,
    completedAt?: string,
  ) {
    const status = await this.prisma.candidatePipelineStatus.findUnique({
      where: { id: statusId },
      include: { project: true },
    });
    if (!status) {
      throw new NotFoundException(`CandidatePipelineStatus ${statusId} not found`);
    }
    await assertInterviewPoolProjectAccess(this.prisma, userId, status.projectId);

    // АУДИТ: раніше stageDefinitionId ніяк не перевірявся — можна
    // було прив'язати прогрес кандидата до InterviewStageDefinition
    // ІНШОГО пулу (FK на рівні БД це б не спіймав, оскільки
    // stageDefinitionId — валідний існуючий id, просто не з цього
    // конфігу). Виправлено явною перевіркою належності.
    const stageDefinition = await this.prisma.interviewStageDefinition.findUnique({
      where: { id: stageDefinitionId },
      include: { config: true },
    });
    if (!stageDefinition || stageDefinition.config.projectId !== status.projectId) {
      throw new NotFoundException(`InterviewStageDefinition ${stageDefinitionId} not found in this pool`);
    }

    if (conversationId) {
      const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
      if (!conversation || conversation.projectId !== status.projectId) {
        throw new NotFoundException(`Conversation ${conversationId} not found`);
      }
    }

    return this.prisma.candidateStageProgress.upsert({
      where: { statusId_stageDefinitionId: { statusId, stageDefinitionId } },
      create: {
        statusId,
        stageDefinitionId,
        conversationId,
        completedAt: completedAt ? new Date(completedAt) : undefined,
      },
      update: {
        conversationId: conversationId ?? undefined,
        completedAt: completedAt ? new Date(completedAt) : undefined,
      },
    });
  }

  // ── Приватні перевірки власності ──

  /** Кандидат доступний, якщо належить безпосередньо userId АБО
   * командному пулу (§4.5 ТЗ), учасником якого є userId — повний
   * спільний доступ до бази команди, не по-проектна ізоляція
   * (свідомий вибір, розділ 8 ТЗ). */
  private async assertAccessibleCandidate(userId: string, candidateProfileId: string) {
    const candidate = await this.prisma.candidateProfile.findUnique({ where: { id: candidateProfileId } });
    if (!candidate) {
      throw new NotFoundException(`CandidateProfile ${candidateProfileId} not found`);
    }
    if (candidate.ownerUserId === userId) return candidate;
    if (candidate.recruitingTeamId) {
      const membership = await this.prisma.recruitingTeamMember.findUnique({
        where: { teamId_userId: { teamId: candidate.recruitingTeamId, userId } },
      });
      if (membership) return candidate;
    }
    throw new NotFoundException(`CandidateProfile ${candidateProfileId} not found`);
  }
}

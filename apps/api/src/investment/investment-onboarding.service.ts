// Пункт [investment] (devils-advocate-investment-tz.md §5.1):
// онбординг-квіз — той самий текстовий шлях без STT, що вже двічі
// реалізований (major-purchase/interview-pool). Project створюється
// ПЕРЕД онбордінгом (та сама розбіжність ТЗ, вже двічі знайдена й
// виправлена цим самим способом).

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConversationProcessingStatus, ConversationSourceType, ProjectMode, InvestmentCriterionCategory } from '@prisma/client';
import { assertInvestmentProjectAccess } from './investment-access';

const TASK_TYPE = 'investment-onboarding-extract';

export interface ExtractedCriterion {
  text: string;
  category: InvestmentCriterionCategory;
  isRequired: boolean;
  orderIndex: number;
}

export interface ExtractedInvestmentConfigDraft {
  goalDescription: string;
  targetBudget: number | null;
  currency: string | null;
  criteria: ExtractedCriterion[];
}

interface RawExtraction {
  goalDescription: string;
  targetBudget?: number | null;
  currency?: string | null;
  criteria: Array<{ text: string; category?: string; isRequired?: boolean }>;
}

function isValidExtraction(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return false;
    if (typeof parsed.goalDescription !== 'string' || parsed.goalDescription.trim().length === 0) return false;
    if (!Array.isArray(parsed.criteria)) return false;
    return parsed.criteria.every((c: any) => typeof c?.text === 'string' && c.text.trim().length > 0);
  } catch {
    return false;
  }
}

// §2.5/5.1 ТЗ — обов'язково розподілені по трьох категоріях, якщо
// користувач НЕ сказав явно пропустити категорію. Чесна деградація —
// менше критеріїв, не вигадані з нуля.
const SYSTEM_PROMPT =
  'Тебе дано транскрипт онбордінг-розмови про пошук інвестиції. Витягни: goalDescription (короткий опис мети вільним текстом), ' +
  'targetBudget/currency (якщо названі), і criteria — масив критеріїв пошуку, КОЖЕН з категорією category: ' +
  '"RETURN_GUARANTEE" (заявлені гарантії повернення/прибутковості), "FEES_AND_LOSSES" (приховані комісії, можливі втрати), ' +
  '"TAXATION" (оподаткування прибутків), "OTHER" (інше). ' +
  'ОБОВ\'ЯЗКОВО додай принаймні по одному критерію на RETURN_GUARANTEE/FEES_AND_LOSSES/TAXATION, ЯКЩО користувач явно не сказав пропустити цю категорію — ' +
  'якщо про категорію взагалі не йшлося в розмові, чесно НЕ додавай вигаданий критерій, менше критеріїв краще за вигадані. ' +
  'Відповідай СТРОГО валідним JSON без пояснень поза ним.';

@Injectable()
export class InvestmentOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async createProject(userId: string, question: string, investmentGroupId?: string) {
    if (!question.trim()) {
      throw new BadRequestException('question не может быть пустым');
    }
    if (investmentGroupId) {
      const membership = await this.prisma.investmentGroupMember.findUnique({
        where: { groupId_userId: { groupId: investmentGroupId, userId } },
      });
      if (!membership) {
        throw new NotFoundException(`InvestmentGroup ${investmentGroupId} not found`);
      }
    }
    return this.prisma.project.create({
      data: { ownerId: userId, question: question.trim(), mode: ProjectMode.INVESTMENT, investmentGroupId },
    });
  }

  async createOnboardingConversation(userId: string, projectId: string) {
    await assertInvestmentProjectAccess(this.prisma, userId, projectId);

    return this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({
        data: {
          projectId,
          sourceType: ConversationSourceType.TEXT_IMPORT,
          status: ConversationProcessingStatus.TRANSCRIBED,
          occurredAt: new Date(),
        },
      });
      const participant = await tx.conversationParticipant.create({
        data: { conversationId: conversation.id, diarizationLabel: 'SELF', isSelf: true },
      });
      const transcript = await tx.transcript.create({ data: { conversationId: conversation.id } });
      return { conversation, participant, transcript };
    });
  }

  async appendAnswer(userId: string, conversationId: string, text: string) {
    if (!text.trim()) {
      throw new BadRequestException('text не может быть пустым');
    }
    await this.assertOwnedConversation(userId, conversationId);
    const transcript = await this.prisma.transcript.findUnique({ where: { conversationId } });
    if (!transcript) {
      throw new NotFoundException(`Transcript for conversation ${conversationId} not found`);
    }
    const participant = await this.prisma.conversationParticipant.findFirst({ where: { conversationId, isSelf: true } });
    const lastSegment = await this.prisma.transcriptSegment.findFirst({
      where: { transcriptId: transcript.id },
      orderBy: { endMs: 'desc' },
    });
    const startMs = (lastSegment?.endMs ?? 0) + 1;

    return this.prisma.transcriptSegment.create({
      data: { transcriptId: transcript.id, participantId: participant?.id ?? null, text: text.trim(), startMs, endMs: startMs },
    });
  }

  async extract(userId: string, conversationId: string): Promise<ExtractedInvestmentConfigDraft> {
    const conversation = await this.assertOwnedConversation(userId, conversationId);
    const transcript = await this.prisma.transcript.findUnique({
      where: { conversationId },
      include: { segments: { orderBy: { startMs: 'asc' } } },
    });
    if (!transcript || transcript.segments.length === 0) {
      throw new BadRequestException('В этой онбординг-разговоре пока нет ответов — нечего извлекать');
    }
    const transcriptText = transcript.segments.map((s: { text: string }) => s.text).join('\n');

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId: conversation.projectId,
        taskType: TASK_TYPE,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: transcriptText,
        jsonMode: true,
        maxTokens: 2000,
        validateOutput: isValidExtraction,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Извлечение отклонено проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось извлечь чернетку — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const parsed: RawExtraction = JSON.parse(result.text);
    const validCategories = new Set(Object.values(InvestmentCriterionCategory));
    return {
      goalDescription: parsed.goalDescription,
      targetBudget: parsed.targetBudget ?? null,
      currency: parsed.currency ?? null,
      criteria: parsed.criteria.map((c, i) => ({
        text: c.text,
        category: validCategories.has(c.category as any) ? (c.category as InvestmentCriterionCategory) : InvestmentCriterionCategory.OTHER,
        isRequired: c.isRequired ?? true,
        orderIndex: i,
      })),
    };
  }

  private async assertOwnedConversation(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { project: true },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    await assertInvestmentProjectAccess(this.prisma, userId, conversation.projectId);
    return conversation;
  }
}

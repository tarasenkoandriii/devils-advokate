// Пункт [dtp] (devils-advocate-dtp-tz.md §5.1): онбординг-квіз — той
// самий текстовий шлях без STT, що вже п'ять разів реалізований.

import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ProjectMode, DtpCriterionCategory } from '@prisma/client';
import { assertOwnedDtpProject } from './dtp-access';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { ensureOnboardingConversation } from '../common/onboarding-conversation';

const TASK_TYPE = 'dtp-onboarding-extract';

export interface ExtractedCriterion {
  text: string;
  category: DtpCriterionCategory;
  isRequired: boolean;
  orderIndex: number;
}

export interface ExtractedDtpConfigDraft {
  goalDescription: string;
  targetBudget: number | null;
  currency: string | null;
  occurredAt: string | null;
  criteria: ExtractedCriterion[];
}

interface RawExtraction {
  goalDescription: string;
  targetBudget?: number | null;
  currency?: string | null;
  occurredAt?: string | null;
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

// §5.1 ТЗ — обов'язково розподілені по трьох категоріях, якщо
// користувач не сказав явно пропустити. НІКОЛИ жодного висновку про
// винуватця від AI (§1/§3.3 ТЗ).
const SYSTEM_PROMPT =
  'Тебе дано транскрипт онбордінг-розмови про підготовку до врегулювання дорожньо-транспортної пригоди. ' +
  'Витягни: goalDescription (короткий опис мети вільним текстом), targetBudget/currency (якщо названі), occurredAt (дата/час самої ДТП, якщо названо, ISO 8601), і criteria — масив критеріїв, КОЖЕН з категорією category: ' +
  '"FAULT_DETERMINATION" (що сказано про визначення винуватця — фіксуй тільки те, що прозвучало, НІКОЛИ не формулюй власний висновок), "DAMAGE_AND_REPAIR" (оцінка пошкоджень, вартість ремонту), "INSURANCE_COVERAGE" (що покриває страховка, франшиза), "OTHER" (інше). ' +
  'ОБОВ\'ЯЗКОВО додай принаймні по одному критерію на FAULT_DETERMINATION/DAMAGE_AND_REPAIR/INSURANCE_COVERAGE, ЯКЩО користувач явно не сказав пропустити цю категорію — ' +
  'якщо про категорію взагалі не йшлося — чесно НЕ додавай вигаданий критерій. ' +
  'НІКОЛИ не формулюй власний висновок про те, хто винен у ДТП — тільки те, що прозвучало в розмові користувача. ' +
  'Відповідай СТРОГО валідним JSON без пояснень поза ним.';

@Injectable()
export class DtpOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async createProject(userId: string, question: string) {
    if (!question.trim()) {
      throw new BadRequestException('question не может быть пустым');
    }
    return this.prisma.project.create({
      data: { ownerId: userId, question: question.trim(), mode: ProjectMode.DTP },
    });
  }

  async createOnboardingConversation(userId: string, projectId: string) {
    await assertOwnedDtpProject(this.prisma, userId, projectId);

    // Пункт [onboarding-continuity] 2026-09-02: разговор ОДИН на проект.
    // Раньше каждый вызов создавал новый, и ответы голосового квиза
    // оставались в первом, недостижимом с экрана домена (см. хелпер).
    return ensureOnboardingConversation(this.prisma, projectId);
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

  async extract(userId: string, conversationId: string): Promise<ExtractedDtpConfigDraft> {
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
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Извлечение отклонено проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось извлечь чернетку — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const parsed: RawExtraction = JSON.parse(result.text);
    const validCategories = new Set(Object.values(DtpCriterionCategory));
    return {
      goalDescription: parsed.goalDescription,
      targetBudget: parsed.targetBudget ?? null,
      currency: parsed.currency ?? null,
      occurredAt: parsed.occurredAt ?? null,
      criteria: parsed.criteria.map((c, i) => ({
        text: c.text,
        category: validCategories.has(c.category as any) ? (c.category as DtpCriterionCategory) : DtpCriterionCategory.OTHER,
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
    if (!conversation || conversation.project.ownerId !== userId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }
}

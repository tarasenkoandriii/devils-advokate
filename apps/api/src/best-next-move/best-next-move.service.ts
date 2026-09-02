// Пункт 19: BestNextMoveService (§3.54 ТЗ) — шестая из 11 фич MVP v2.
//
// Новая, но небольшая Prisma-модель (BestNextMoveRecommendation) —
// см. обоснование в schema.prisma: 4 разных именованных текстовых
// поля, не однородный список, как ConversationAgenda/
// MissingInformationCheck — форма данных решает, не унифицируется
// ради похожести темы.
//
// "После постфактум-разбора" — контекст для AI собирается из уже
// готового транскрипта (тот же принцип, что Turning Points/Do Not
// Say — весь транскрипт целиком, не только реплики одного участника,
// в отличие от Do Not Say) + DecisionObjective проекта (цель
// разговора — без неё "лучшее следующее действие" было бы советом в
// вакууме, тот же довод, что уже применён к Missing Information).
// Turning Points/Do Not Say, уже найденные для этого разговора, НЕ
// подмешиваются в промпт дополнительным запросом — держит контекст
// в одном источнике (сырой транскрипт), не усложняет промпт
// цепочкой предыдущих AI-выводов поверх AI-выводов; ТЗ не требует
// именно такого обогащения явно, честно не добавлено сверх того, что
// написано.
//
// Пункт 20 (§3.55 ТЗ, "Объяснение почему не") расширил ЭТОТ сервис,
// не создал параллельный — см. обоснование в schema.prisma над
// моделью. whyNotAlternative/whatCouldChange — nullable в схеме:
// валидация ответа AI НЕ требует их обязательно (backward-совместимо
// со старым/закэшированным PromptVersion без этих полей в
// инструкции) — дефолтный промпт запрашивает их всегда, но парсинг
// не падает, если AI их не прислал.

import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConversationProcessingStatus } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'best-next-move-detection';

interface RawRecommendation {
  bestAction: string;
  alternative: string;
  avoid: string;
  why: string;
  whyNotAlternative?: string;
  whatCouldChange?: string;
}

function isValidRecommendationPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.bestAction === 'string' &&
      typeof parsed.alternative === 'string' &&
      typeof parsed.avoid === 'string' &&
      typeof parsed.why === 'string'
    );
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'После разговора, представленного транскриптом ниже (с учётом цели разговора, если она указана), сформулируй явную рекомендацию следующего действия. Структура ответа строго такая: bestAction — лучшее следующее действие, конкретное и выполнимое; alternative — альтернативный вариант действия, если первый не подходит; avoid — чего стоит избегать в следующем шаге и почему это было бы ошибкой; why — краткое обоснование, почему именно bestAction лучший вариант из всех; whyNotAlternative — явное объяснение, почему alternative НЕ была выбрана вместо bestAction (не просто повторение alternative, а причина отказа от неё); whatCouldChange — какие обстоятельства или новая информация могли бы изменить эту рекомендацию на другую. Ответь СТРОГО валидным JSON-объектом вида {"bestAction": string, "alternative": string, "avoid": string, "why": string, "whyNotAlternative": string, "whatCouldChange": string}. Без пояснений вне JSON.';

@Injectable()
export class BestNextMoveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async detect(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);

    if (
      conversation.status !== ConversationProcessingStatus.TRANSCRIBED &&
      conversation.status !== ConversationProcessingStatus.ANALYZED
    ) {
      throw new BadRequestException(
        `Conversation ${conversationId} must be TRANSCRIBED before Best Next Move detection (current: ${conversation.status})`,
      );
    }

    const segments = conversation.transcript?.segments ?? [];
    if (segments.length === 0) {
      throw new BadRequestException(`Conversation ${conversationId} has no transcript segments to analyze`);
    }

    const objective = await this.prisma.decisionObjective.findUnique({
      where: { projectId: conversation.projectId },
    });

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    const systemPrompt = activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT;

    const objectiveContext = objective?.desiredOutcome
      ? `Цель разговора: ${objective.desiredOutcome}\n\n`
      : '';
    const transcriptText = segments
      .map((s: any) => `${s.participant?.diarizationLabel ?? 'speaker'}: ${s.text}`)
      .join('\n');
    const userPrompt = `${objectiveContext}Транскрипт разговора:\n${transcriptText}`;

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId: conversation.projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt,
        userPrompt,
        jsonMode: true,
        maxTokens: 900,
        validateOutput: isValidRecommendationPayload,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Анализ отклонён проверкой безопасности содержимого транскрипта.');
      }
      throw new BadGatewayException(
        'Не удалось сформировать рекомендацию — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const raw: RawRecommendation = JSON.parse(result.text);

    return this.prisma.bestNextMoveRecommendation.create({
      data: {
        conversationId,
        bestAction: raw.bestAction,
        alternative: raw.alternative,
        avoid: raw.avoid,
        why: raw.why,
        whyNotAlternative: raw.whyNotAlternative ?? null,
        whatCouldChange: raw.whatCouldChange ?? null,
        generatedByInferenceId: result.aiInferenceId,
      },
    });
  }

  /** Последний снимок — детекция не мутирует старые записи, тот же
   * принцип, что MissingInformationCheck/ConversationAgenda. */
  async getLatest(userId: string, conversationId: string) {
    await this.findOwnedConversationWithTranscript(userId, conversationId);
    return this.prisma.bestNextMoveRecommendation.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async findOwnedConversationWithTranscript(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        project: true,
        transcript: { include: { segments: { include: { participant: true } } } },
      },
    });
    if (!conversation || conversation.project.ownerId !== userId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }
}

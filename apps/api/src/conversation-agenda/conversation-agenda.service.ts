// Пункт 27: ConversationAgendaService (раздел 2 ТЗ, MVP v2 пункт 15) —
// "AI формирует agenda на основе прошлого + текущей цели" — буквальная
// цитата ТЗ, AI-вызов обязателен, не ручной CRUD (в отличие от
// ProtectedNote рядом, где наоборот — пользователь заполняет сам).
//
// Модель ConversationAgenda существовала с Пункта 12 (Conversation
// Dossier), но ни разу не было сервиса, который бы её реально
// заполнял, — тот же класс пробела, что уже был найден и закрыт для
// Argument Lifecycle (Пункт 23) и диаризации (Пункт 26 в этом же
// проходе): модель есть, фичи нет.
//
// Контекст для AI: DecisionObjective проекта (цель) + транскрипты
// ВСЕХ уже расшифрованных прошлых разговоров этого проекта (буквально
// "на основе прошлого"). Снимок, не мутируемый список — та же логика,
// что MissingInformationCheck/BestNextMoveRecommendation: повторная
// генерация создаёт НОВУЮ запись, не переписывает старую.

import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ConversationProcessingStatus } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'conversation-agenda-generation';

function isValidAgendaPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string');
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'На основе прошлых разговоров (транскриптов ниже, если есть) и текущей цели пользователя сформируй повестку следующего разговора — конкретные пункты, которые стоит поднять, с учётом того, что уже обсуждалось раньше. Не повторяй то, что уже было полностью решено в прошлых разговорах — фокусируйся на незакрытом и новом. Ответь СТРОГО валидным JSON-массивом строк, каждая строка — один пункт повестки. Без пояснений вне JSON.';

@Injectable()
export class ConversationAgendaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async generate(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    const objective = await this.prisma.decisionObjective.findUnique({ where: { projectId } });

    const pastConversations = await this.prisma.conversation.findMany({
      where: {
        projectId,
        status: { in: [ConversationProcessingStatus.TRANSCRIBED, ConversationProcessingStatus.ANALYZED] },
      },
      include: { transcript: { include: { segments: true } } },
      orderBy: { occurredAt: 'desc' },
      take: 5, // последние 5 — не весь архив разом, чтобы не раздувать промпт бесконечно на давних проектах
    });

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    const systemPrompt = activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT;

    const objectiveContext = objective?.desiredOutcome ? `Цель: ${objective.desiredOutcome}\n\n` : '';
    const transcriptsContext = pastConversations
      .map((c: any, i: number) => {
        const text = (c.transcript?.segments ?? []).map((s: any) => s.text).join(' ');
        return text ? `Разговор ${i + 1} (${c.occurredAt.toISOString().slice(0, 10)}): ${text}` : null;
      })
      .filter(Boolean)
      .join('\n\n');
    const userPrompt = `${objectiveContext}${transcriptsContext || 'Прошлых расшифрованных разговоров пока нет — сформируй повестку только на основе цели.'}`;

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt,
        userPrompt,
        jsonMode: true,
        maxTokens: 600,
        validateOutput: isValidAgendaPayload,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Формирование повестки отклонено проверкой безопасности содержимого.');
      }
      throw new BadGatewayException(
        'Не удалось сформировать повестку — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const items: string[] = JSON.parse(result.text);

    return this.prisma.conversationAgenda.create({
      data: {
        projectId,
        items,
        generatedByInferenceId: result.aiInferenceId,
        basedOnConversations: { connect: pastConversations.map((c: { id: string }) => ({ id: c.id })) },
      },
    });
  }

  async getLatest(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.conversationAgenda.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }
}

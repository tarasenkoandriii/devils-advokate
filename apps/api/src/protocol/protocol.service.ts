// Пункт 62: ProtocolService (§3.30 ТЗ) — "Протокол по итогам
// решения", v4-роадмап (пункт 48 общего списка). По прямому запросу.
//
// СИНТЕЗ ИЗ УЖЕ СУЩЕСТВУЮЩИХ ДАННЫХ — "кто что обязался сделать, к
// какому сроку" уже структурно есть в Commitment (Пункт 14), не
// переизобретается. AI синтезирует связный текст поверх Commitment +
// DecisionObjective + (если есть) последнего разговора проекта — тот
// же принцип, что уже применялся в OutcomeForecastingService (Пункт
// 47) и MotiveAnalysisService (Пункт 59).
//
// "ЛЁГКАЯ ВЕРСИЯ MOU, БЕЗ ЮРИДИЧЕСКОЙ СИЛЫ... ЯВНО ПОМЕЧАЕТСЯ КАК
// НЕФОРМАЛЬНАЯ ДОГОВОРЁННОСТЬ" — формулировка задана прямо в
// системном промпте, не только как UI-текст: модель явно
// инструктирована включить эту оговорку в сам текст протокола.
//
// "ОТПРАВИТЬ ВТОРОЙ СТОРОНЕ ДЛЯ ПОДТВЕРЖДЕНИЯ ПРЯМО В TELEGRAM" — НЕ
// реализуется здесь отдельным механизмом: TMA переиспользует уже
// существующий Safe Share pipeline (Пункт 12, §3.48 —
// safeSharePreflight/safeShareConfirm), тот же паттерн, что уже
// применяется в ShareButton.tsx для аргументов. Подтверждение —
// обычный ответ в Telegram-чате, не отдельная система обратной связи.

import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'protocol-generation';

interface RawProtocol {
  summaryText: string;
}

function isValidProtocolPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && typeof parsed.summaryText === 'string' && parsed.summaryText.trim().length > 0;
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Составь краткий текстовый протокол/соглашение по итогам решения или переговоров — резюме того, о чём договорились, и список обязательств (кто, что, к какому сроку) на основе переданных данных. Это ЛЁГКАЯ ВЕРСИЯ MOU, БЕЗ ЮРИДИЧЕСКОЙ СИЛЫ официального договора — обязательно включи в текст явную оговорку об этом (например, "неформальная договорённость, не имеет юридической силы"). Текст должен быть готов к отправке второй стороне для подтверждения — вежливый, конкретный, без лишних деталей. Ответь СТРОГО валидным JSON-объектом вида {"summaryText": string}. Без пояснений вне JSON.';

@Injectable()
export class ProtocolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async generate(userId: string, projectId: string, engineId?: string) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);

    const [commitments, objective, lastConversation] = await Promise.all([
      this.prisma.commitment.findMany({ where: { projectId }, include: { person: true } }),
      this.prisma.decisionObjective.findUnique({ where: { projectId } }),
      this.prisma.conversation.findFirst({
        where: { projectId },
        orderBy: { occurredAt: 'desc' },
        include: { transcript: { include: { segments: true } } },
      }),
    ]);

    if (commitments.length === 0 && !objective?.desiredOutcome) {
      throw new BadRequestException(
        'Пока нет ни зафиксированных обязательств, ни желаемого исхода — протокол строить не на чем',
      );
    }

    const commitmentsText = commitments
      .map(
        (c: { owner: string; description: string; dueDate: Date | null; person: { displayName: string | null } }) =>
          `- [${c.owner === 'USER' ? 'пользователь' : c.person.displayName ?? 'фигурант'}] ${c.description}${c.dueDate ? ` (срок: ${c.dueDate.toISOString().slice(0, 10)})` : ''}`,
      )
      .join('\n');

    const objectiveText = objective?.desiredOutcome ? `Желаемый исход: ${objective.desiredOutcome}` : '';

    const lastConversationText =
      lastConversation?.transcript?.segments && lastConversation.transcript.segments.length > 0
        ? `Фрагмент последнего разговора по проекту:\n${lastConversation.transcript.segments
            .slice(0, 20)
            .map((s: { text: string }) => s.text)
            .join(' ')}`
        : '';

    const userPrompt = [
      `Ситуация: ${project.question}`,
      objectiveText,
      commitmentsText ? `Зафиксированные обязательства:\n${commitmentsText}` : '(обязательства пока не зафиксированы)',
      lastConversationText,
    ]
      .filter(Boolean)
      .join('\n\n');

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt: activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 1200,
        validateOutput: isValidProtocolPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось составить протокол — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const raw: RawProtocol = JSON.parse(result.text);
    return this.prisma.protocol.create({
      data: {
        projectId,
        summaryText: raw.summaryText,
        generatedByInferenceId: result.aiInferenceId,
      },
    });
  }

  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.protocol.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }
}

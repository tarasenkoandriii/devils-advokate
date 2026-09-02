// MVP-фича 1: генерация аргументов за/против (§3.10 ТЗ, MVP-пункт 1)
//
// Первый реальный потребитель AIRouterService. Промпт — минимальный
// рабочий вариант ("v1"), не финальный копирайт; ожидается, что
// формулировка будет итерироваться через PromptVersion (draft → testing
// → active), не правкой строки в коде задним числом.
//
// Обновление при реализации фичи 6: если у проекта заполнен
// DecisionObjective, он подмешивается в userPrompt — иначе форма была
// бы write-only и никак не улучшала бы результат, ради которого её
// вообще заполняют. Не обязателен: без DecisionObjective поведение то
// же, что и раньше (просто question/goal).

import { Injectable, BadGatewayException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ArgumentStance, DecisionObjective } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'argument-generation';

interface RawGeneratedArgument {
  text: string;
  stance: 'pro' | 'con';
  weight?: number;
}

function isValidGeneratedPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.text === 'string' &&
        (item.stance === 'pro' || item.stance === 'con') &&
        (item.weight === undefined || typeof item.weight === 'number'),
    );
  } catch {
    return false;
  }
}

export function buildUserPrompt(
  project: { question: string; goal: string | null },
  objective: DecisionObjective | null,
): string {
  const lines = [`Вопрос: ${project.question}`];
  if (project.goal) lines.push(`Цель: ${project.goal}`);

  if (objective) {
    if (objective.desiredOutcome) lines.push(`Желаемый исход: ${objective.desiredOutcome}`);
    if (objective.idealOutcome) lines.push(`Идеальный исход: ${objective.idealOutcome}`);
    if (objective.minimumAcceptableOutcome)
      lines.push(`Минимально приемлемый результат: ${objective.minimumAcceptableOutcome}`);
    if (objective.unacceptableOutcome)
      lines.push(`Неприемлемо (красная черта): ${objective.unacceptableOutcome}`);
    if (objective.constraints.length > 0)
      lines.push(`Ограничения: ${objective.constraints.join('; ')}`);
    if (objective.nonNegotiables.length > 0)
      lines.push(`Не подлежит обсуждению: ${objective.nonNegotiables.join('; ')}`);
    if (objective.negotiables.length > 0)
      lines.push(`Можно поступиться: ${objective.negotiables.join('; ')}`);
    if (objective.deadline) lines.push(`Срок: ${objective.deadline.toISOString().split('T')[0]}`);
  }

  return lines.join('\n');
}

@Injectable()
export class ArgumentGenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async generate(projectId: string, userId: string, engineId?: string) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);
    const objective = await this.prisma.decisionObjective.findUnique({ where: { projectId } });

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    const systemPrompt =
      activePrompt?.template ??
      'Ты помогаешь человеку подготовиться к разговору. Сгенерируй список аргументов за и против по описанной ситуации, учитывая желаемый исход, ограничения и то, чем нельзя поступиться, если они указаны. Ответь СТРОГО валидным JSON-массивом объектов вида {"text": string, "stance": "pro"|"con", "weight": number от 0 до 1}. Без пояснений вне JSON.';

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt,
        userPrompt: buildUserPrompt(project, objective),
        jsonMode: true,
        maxTokens: 1500,
        validateOutput: isValidGeneratedPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      // Разные типы отказа — разные HTTP-статусы, не один общий "502 на всё":
      // - ForbiddenException (нет согласия на внешний AI) пробрасывается как есть
      // - блокировка по prompt injection — 400, это ошибка ввода, не сбоя инфраструктуры
      // - всё остальное (недоступность провайдера, exhausted retries) — 502
      // [ai-errors] 2026-09-02: общий шлюз — 403 согласия, 429 суточного
      // лимита и «нет модели» (сид не прогнан / нет ключа) доезжают до
      // пользователя со своим смыслом, а не под видом «провайдер
      // недоступен». Это главная AI-фича проекта, и здесь подмена
      // диагноза стоила дороже всего.
      rethrowClientVisibleAiError(err);
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException(
          'Запрос отклонён проверкой безопасности содержимого — переформулируйте вопрос без служебных инструкций внутри текста.',
        );
      }
      throw new BadGatewayException(
        'Не удалось сгенерировать аргументы — AI-провайдер недоступен или вернул некорректный ответ. Попробуйте ещё раз или выберите другой движок.',
      );
    }

    const rawArguments: RawGeneratedArgument[] = JSON.parse(result.text);

    const createdArguments = await this.prisma.$transaction(
      rawArguments.map((arg) =>
        this.prisma.argument.create({
          data: {
            projectId,
            text: arg.text,
            stance: arg.stance === 'pro' ? ArgumentStance.PRO : ArgumentStance.CON,
            weight: arg.weight ?? null,
            derivedFromInferenceId: result.aiInferenceId,
          },
        }),
      ),
    );

    return createdArguments;
  }
}

// MVP-фича 10: скрипты открытия и закрытия разговора (§3.46 ТЗ,
// MVP-пункт 10) — последняя недостающая секция Conversation Card
// (фича 8). Третий реальный потребитель AIRouterService после
// генерации аргументов (фича 1) и Steelman (фича 7).
//
// §3.46 упоминает учёт коммуникационного профиля фигуранта (§3.11) —
// это v3-фича (Person.communicationProfile не существует в схеме),
// здесь скрипт строится на Decision Objective/BATNA без него — честное
// упрощение для MVP, не притворяется учётом того, чего физически нет.

import { Injectable, NotFoundException, BadGatewayException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ConversationScriptType } from '@prisma/client';

const TASK_TYPE = 'conversation-script';

function isNonEmptyString(text: string): boolean {
  return typeof text === 'string' && text.trim().length > 0;
}

@Injectable()
export class ConversationScriptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async generate(
    projectId: string,
    userId: string,
    type: ConversationScriptType,
    personId?: string,
    engineId?: string,
  ) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);

    let personLabel: string | null = null;
    if (personId) {
      const link = await this.prisma.projectPerson.findUnique({
        where: { projectId_personId: { projectId, personId } },
        include: { person: true },
      });
      if (!link) {
        throw new NotFoundException(`Person ${personId} not found in project ${projectId}`);
      }
      personLabel = link.person.displayName;
    }

    const [objective, boundaries] = await Promise.all([
      this.prisma.decisionObjective.findUnique({ where: { projectId } }),
      this.prisma.negotiationBoundaries.findUnique({ where: { projectId } }),
    ]);

    const userPrompt = this.buildPrompt(project, objective, boundaries, type, personLabel);

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
        systemPrompt:
          activePrompt?.template ??
          (type === ConversationScriptType.OPENING
            ? 'Ты помогаешь человеку начать важный разговор так, чтобы сразу задать нужный тон. Ответь одной-двумя фразами, которые можно сказать вслух — без пояснений, без кавычек, без markdown.'
            : 'Ты помогаешь человеку завершить важный разговор — зафиксировать договорённости или, если решение ещё не принято, оставить пространство для следующего шага. Ответь одной-двумя фразами, которые можно сказать вслух — без пояснений, без кавычек, без markdown.'),
        userPrompt,
        jsonMode: false,
        maxTokens: 300,
        validateOutput: isNonEmptyString,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException(
          'Запрос отклонён проверкой безопасности содержимого — переформулируйте вопрос без служебных инструкций внутри текста.',
        );
      }
      throw new BadGatewayException(
        'Не удалось сгенерировать скрипт — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    return this.prisma.conversationScript.create({
      data: {
        projectId,
        personId: personId ?? null,
        type,
        text: result.text.trim(),
        derivedFromInferenceId: result.aiInferenceId,
      },
    });
  }

  async getLatest(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);

    const [opening, closing] = await Promise.all([
      this.prisma.conversationScript.findFirst({
        where: { projectId, type: ConversationScriptType.OPENING },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.conversationScript.findFirst({
        where: { projectId, type: ConversationScriptType.CLOSING },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { opening, closing };
  }

  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.conversationScript.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private buildPrompt(
    project: { question: string; goal: string | null },
    objective: { desiredOutcome: string | null; unacceptableOutcome: string | null } | null,
    boundaries: { walkAwayPoint: string | null } | null,
    type: ConversationScriptType,
    personLabel: string | null,
  ): string {
    const lines = [`Ситуация: ${project.question}`];
    if (project.goal) lines.push(`Цель: ${project.goal}`);
    if (personLabel) lines.push(`Разговор с: ${personLabel}`);
    if (objective?.desiredOutcome) lines.push(`Желаемый исход: ${objective.desiredOutcome}`);
    if (objective?.unacceptableOutcome) lines.push(`Красная черта: ${objective.unacceptableOutcome}`);
    if (boundaries?.walkAwayPoint) lines.push(`Точка выхода: ${boundaries.walkAwayPoint}`);
    lines.push(
      type === ConversationScriptType.OPENING
        ? 'Предложи, как начать этот разговор.'
        : 'Предложи, как завершить этот разговор.',
    );
    return lines.join('\n');
  }
}

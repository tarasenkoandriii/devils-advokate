// MVP-фича 7: Steelman позиции оппонента (§3.43 ТЗ, MVP-пункт 7)
//
// Симметричная пара к Red Team (3.1, v3-фича, ещё не реализована) —
// не атака на позицию пользователя, а построение сильнейшей версии
// позиции фигуранта. Второй реальный потребитель AIRouterService после
// генерации аргументов — если он существует, всё уже готово (consent,
// content scan, retry/fallback), сама фича здесь — по большей части
// промпт-инжиниринг и persistence поверх готовой инфраструктуры.
//
// Для MVP не требует карты круга лиц/прецедентов/симуляции перспектив
// (v3-фичи, §3.8/§3.9/§3.11 ТЗ) — опирается на то, что уже есть:
// PersonFact этого человека (с учётом FactScope, §4.2), не более.

import { Injectable, NotFoundException, BadGatewayException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';

const TASK_TYPE = 'steelman';

interface RawSteelmanResult {
  strongestArgument: string;
  reasonableness?: string;
  whatUserMayMiss?: string;
}

function isValidSteelmanPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.strongestArgument === 'string' &&
      parsed.strongestArgument.length > 0
    );
  } catch {
    return false;
  }
}

@Injectable()
export class SteelmanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async generate(projectId: string, personId: string, userId: string, engineId?: string) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);

    const link = await this.prisma.projectPerson.findUnique({
      where: { projectId_personId: { projectId, personId } },
      include: { person: true },
    });
    if (!link) {
      throw new NotFoundException(`Person ${personId} not found in project ${projectId}`);
    }

    const facts = await this.prisma.personFact.findMany({
      where: {
        personId,
        status: 'ACTIVE',
        OR: [{ scope: 'PROJECT', projectId }, { scope: 'PERSON_GLOBAL' }],
      },
    });

    const personLabel = link.person.displayName ?? 'фигурант';
    const factsSummary =
      facts.length > 0
        ? facts.map((f) => `- ${f.content}`).join('\n')
        : '(известных фактов об этом человеке пока нет)';

    const userPrompt = [
      `Ситуация: ${project.question}`,
      project.goal ? `Цель пользователя: ${project.goal}` : '',
      `Построй сильнейшую версию позиции человека "${personLabel}" в этой ситуации — не ищи в ней слабые места, а объясни, почему эта позиция может быть разумной с его точки зрения.`,
      `Известные факты об этом человеке:\n${factsSummary}`,
      'Ответь СТРОГО валидным JSON-объектом вида {"strongestArgument": string, "reasonableness": string, "whatUserMayMiss": string}. Без пояснений вне JSON.',
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
        systemPrompt:
          activePrompt?.template ??
          'Ты помогаешь человеку увидеть ситуацию глазами другого участника — честно и без карикатуры, чтобы противодействовать confirmation bias, а не просто согласиться с пользователем.',
        userPrompt,
        jsonMode: true,
        maxTokens: 800,
        validateOutput: isValidSteelmanPayload,
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
        'Не удалось построить Steelman-кейс — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const parsed: RawSteelmanResult = JSON.parse(result.text);

    const steelmanCase = await this.prisma.steelmanCase.create({
      data: {
        projectId,
        personId,
        strongestArgument: parsed.strongestArgument,
        reasonableness: parsed.reasonableness ?? null,
        whatUserMayMiss: parsed.whatUserMayMiss ?? null,
        derivedFromInferenceId: result.aiInferenceId,
        supportingFacts: {
          create: facts.map((f) => ({ personFactId: f.id })),
        },
      },
      include: { supportingFacts: true },
    });

    return steelmanCase;
  }

  async list(userId: string, projectId: string, personId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.steelmanCase.findMany({
      where: { projectId, personId },
      orderBy: { createdAt: 'desc' },
    });
  }
}

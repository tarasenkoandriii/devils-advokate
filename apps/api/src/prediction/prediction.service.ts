// Пункт 25: PredictionService (§3.60 ТЗ) — вне изначально запрошенных
// 11 фич §3.49-3.59, следующая по номеру в разделе 3 ТЗ.
//
// Построено МИНИМАЛЬНОЕ ядро §3.60, не полноценное расширение §3.2
// (Decision Track Record — накопительная статистика точности и
// паттерны когнитивных искажений по МНОГИМ решениям сразу), которое в
// этом проекте не начато вообще. Подробное обоснование — см.
// комментарий над моделью Prediction в schema.prisma.
//
// Двухфазный флоу: create() фиксирует прогноз СРАЗУ (до того, как
// известен исход) — actualOutcome/difference/lesson все null.
// recordActualOutcome() вызывается ПОЗЖЕ, когда исход действительно
// стал известен — единственный AI-вызов в этом сервисе, сравнивает
// predictedOutcome с actualOutcome, порождает difference+lesson за
// один раз (тот же паттерн "один AI-вызов → structured результат",
// что уже применён в Turning Points/Do Not Say/Best Next Move).

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';

const TASK_TYPE = 'prediction-analysis';

interface RawAnalysis {
  difference: string;
  lesson: string;
}

function isValidAnalysisPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && typeof parsed.difference === 'string' && typeof parsed.lesson === 'string';
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Тебе даны прогноз, сделанный ранее, и фактический результат, который произошёл позже. Сравни их и ответь на явный вопрос: что система или сам пользователь спрогнозировали неправильно? Структура ответа: difference — в чём конкретно разница между прогнозом и фактическим результатом; lesson — какой практический вывод стоит сделать на будущее (не общие слова вроде "будь внимательнее", а конкретное наблюдение о том, что именно было недооценено/переоценено или упущено). Ответь СТРОГО валидным JSON-объектом вида {"difference": string, "lesson": string}. Без пояснений вне JSON.';

@Injectable()
export class PredictionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async create(userId: string, projectId: string, predictedOutcome: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.prediction.create({
      data: { projectId, predictedOutcome },
    });
  }

  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.prediction.findMany({
      where: { projectId },
      orderBy: { predictedAt: 'desc' },
    });
  }

  /** §3.60 ТЗ: "прогноз → фактический результат → в чём разница →
   * какой вывод сделать" — этот метод закрывает последние три поля
   * структуры за один вызов, когда исход действительно стал известен. */
  async recordActualOutcome(userId: string, predictionId: string, actualOutcome: string) {
    const prediction = await this.findOwnedPrediction(userId, predictionId);

    if (prediction.actualOutcome !== null) {
      throw new BadRequestException(
        `Prediction ${predictionId} already has a recorded actual outcome — create a new Prediction instead of overwriting history`,
      );
    }

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    const systemPrompt = activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT;
    const userPrompt = `Прогноз: ${prediction.predictedOutcome}\n\nФактический результат: ${actualOutcome}`;

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId: prediction.projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt,
        userPrompt,
        jsonMode: true,
        maxTokens: 600,
        validateOutput: isValidAnalysisPayload,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Анализ отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException(
        'Не удалось проанализировать прогноз против реальности — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const raw: RawAnalysis = JSON.parse(result.text);

    return this.prisma.prediction.update({
      where: { id: predictionId },
      data: {
        actualOutcome,
        actualOutcomeRecordedAt: new Date(),
        difference: raw.difference,
        lesson: raw.lesson,
        generatedByInferenceId: result.aiInferenceId,
      },
    });
  }

  private async findOwnedPrediction(userId: string, predictionId: string) {
    const prediction = await this.prisma.prediction.findUnique({
      where: { id: predictionId },
      include: { project: true },
    });
    if (!prediction || prediction.project.ownerId !== userId) {
      throw new NotFoundException(`Prediction ${predictionId} not found`);
    }
    return prediction;
  }
}

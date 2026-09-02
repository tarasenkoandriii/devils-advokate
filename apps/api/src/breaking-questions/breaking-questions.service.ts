// Пункт 84: BreakingQuestionsService (§3.33 ТЗ, "генерация breaking-
// вопросов по требованию") — первая половина прохода 2 "экрана
// сопровождения" (вторая — LiveArgumentTrackingService, отдельный
// файл). По прямому запросу.
//
// ПО ТРЕБОВАНИЮ, НЕ ЦИКЛИЧНО — единственный вызов на нажатие кнопки,
// в отличие от LiveHintsService/LiveManipulationService (Пункты
// 82/83), которые работают периодическими циклами до 30 секунд.
//
// ДВА ВОПРОСА ЗА ОДИН ВЫЗОВ, buкально ТЗ: "Вопрос 1 — пробивающий...
// Вопрос 2 — компромиссный". Переиспользует уже существующие
// источники — базу аргументов проекта (не новый ввод), MotiveHypothesis
// (Пункт 59, "известные факты о фигуранте"), если targetPersonId
// передан. НЕ отдельная новая модель фактов — синтез уже готовых
// данных, тот же принцип, что ClosingMessageService/CompromiseSheetService.

import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ArgumentStance } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'breaking-questions';

interface RawQuestions {
  breakingQuestion: string;
  compromiseQuestion: string;
}

function isValidQuestionsPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed.breakingQuestion === 'string' && typeof parsed.compromiseQuestion === 'string' && parsed.breakingQuestion.trim().length > 0 && parsed.compromiseQuestion.trim().length > 0;
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT =
  'Тебе дан фрагмент транскрипта живого разговора, база аргументов пользователя и (если есть) гипотезы о мотивах собеседника. Составь ДВА разных вопроса. breakingQuestion — "пробивающий" вопрос: вскрывает слабое место в ТЕКУЩЕЙ линии аргументации собеседника (на основе того, что он уже сказал в транскрипте), потенциально снижает накал разговора, а НЕ разжигает его дальше — не переход на личности, не провокация. compromiseQuestion — "компромиссный" вопрос: нацелен не на то, чтобы "выиграть" спор, а на поиск точки компромисса, используй логику примирения и совпадения целей, если данные об этом есть. Оба вопроса — конкретные, готовые быть прямо заданными вслух, не абстрактные советы. Ответь СТРОГО валидным JSON вида {"breakingQuestion": string, "compromiseQuestion": string}. Без пояснений вне JSON.';

@Injectable()
export class BreakingQuestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async generate(
    userId: string,
    projectId: string,
    transcriptWindow: string,
    targetPersonId?: string,
    engineId?: string,
  ) {
    if (!transcriptWindow.trim()) {
      throw new BadRequestException('transcriptWindow не может быть пустым');
    }
    await assertProjectOwnership(this.prisma, userId, projectId);

    const [projectArguments, motiveHypotheses] = await Promise.all([
      this.prisma.argument.findMany({
        where: { projectId, targetPersonId: null, stance: { in: [ArgumentStance.PRO, ArgumentStance.CON] } },
      }),
      targetPersonId
        ? this.prisma.motiveHypothesis.findMany({ where: { projectId, personId: targetPersonId } })
        : Promise.resolve([]),
    ]);

    const argumentsText = projectArguments.map((a: { stance: string; text: string }) => `(${a.stance}) ${a.text}`).join('\n');
    const motiveText = motiveHypotheses
      .map((m: { explanation: string }) => m.explanation)
      .join('\n');

    const userPrompt = [
      `Фрагмент транскрипта разговора:\n${transcriptWindow}`,
      argumentsText ? `База аргументов пользователя:\n${argumentsText}` : '',
      motiveText ? `Гипотезы о мотивах собеседника:\n${motiveText}` : '',
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
        systemPrompt: activePrompt?.template ?? SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 500,
        validateOutput: isValidQuestionsPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось составить вопросы — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const raw: RawQuestions = JSON.parse(result.text);

    return this.prisma.breakingQuestionSet.create({
      data: {
        projectId,
        breakingQuestion: raw.breakingQuestion,
        compromiseQuestion: raw.compromiseQuestion,
        generatedByInferenceId: result.aiInferenceId,
      },
    });
  }

  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.breakingQuestionSet.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }
}

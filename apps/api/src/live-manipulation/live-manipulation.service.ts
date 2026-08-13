// Пункт 83: LiveManipulationService (§3.33 ТЗ, "детектор уловок —
// live-режим прямо на экране") — первый из двух согласованных срезов
// "экрана сопровождения". По прямому запросу.
//
// НЕ ПЕРЕИСПОЛЬЗУЕТ ManipulationDetectorService (Пункт 36) — тот
// привязан к полному, уже сохранённому Conversation с сегментами и
// диаризацией. Здесь — тот же тип входа, что уже использует
// LiveHintsService (Пункт 82): голый растущий текстовый оконный
// фрагмент, до 30-секундный цикл, backend не хранит транскрипт
// между вызовами.
//
// МОЖЕТ БЫТЬ НЕСКОЛЬКО ФЛАГОВ ЗА ЦИКЛ — в отличие от LiveHintEvent
// (максимум одна подсказка, "тихие пуш-подсказки"), здесь детекция
// РЕАЛЬНО ПРОИЗОШЕДШИХ манипулятивных реплик — их может быть
// несколько в одном окне, каждая заслуживает отдельного флага, не
// сжимается до одной "самой важной".

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';

const TASK_TYPE = 'live-manipulation-detection';

interface RawFlag {
  technique: string;
  description: string;
  confidence?: number;
}

function isValidFlagsPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.technique === 'string' &&
        typeof item.description === 'string' &&
        (item.confidence === undefined || typeof item.confidence === 'number'),
    );
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT =
  'Тебе дан ПОСЛЕДНИЙ фрагмент транскрипта живого разговора (не весь разговор, только недавнее окно, без указания говорящего построчно — сплошной текст). Найди в этом фрагменте использование манипулятивных приёмов аргументации: переход на личности, подмена тезиса, ложная дилемма, whataboutism, апелляция к эмоциям вместо сути, давление на срочность. Для каждого найденного приёма укажи: technique — короткое название на русском, description — конкретно, в чём проявился приём в этом фрагменте, confidence — 0..1, честная оценка уверенности (live-детекция на неполном контексте менее надёжна, чем анализ полной записи — не завышай уверенность). Если приёмов нет — верни пустой массив []. Ответь СТРОГО валидным JSON-массивом объектов вида {"technique": string, "description": string, "confidence": number}. Без пояснений вне JSON.';

@Injectable()
export class LiveManipulationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  /** transcriptWindow — уже ограниченный КЛИЕНТОМ фрагмент, НЕ
   * персистируется здесь ни при каких обстоятельствах, тот же принцип,
   * что LiveHintsService.analyze(). */
  async analyze(userId: string, projectId: string, transcriptWindow: string, engineId?: string) {
    if (!transcriptWindow.trim()) {
      throw new BadRequestException('transcriptWindow не может быть пустым');
    }
    await assertProjectOwnership(this.prisma, userId, projectId);

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
        userPrompt: transcriptWindow,
        jsonMode: true,
        maxTokens: 500,
        validateOutput: isValidFlagsPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось проверить фрагмент — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const rawFlags: RawFlag[] = JSON.parse(result.text);

    const created = [];
    for (const flag of rawFlags) {
      const record = await this.prisma.liveManipulationFlag.create({
        data: {
          projectId,
          technique: flag.technique,
          description: flag.description,
          confidence: flag.confidence ?? null,
          generatedByInferenceId: result.aiInferenceId,
        },
      });
      created.push(record);
    }
    return created;
  }

  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.liveManipulationFlag.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }
}

// Пункт 82: LiveHintsService (§3.4 ТЗ) — "Live-подсказки во время
// разговора". По прямому запросу, разблокировано находкой Пункта 81.
//
// ЦИКЛ ДО 30 СЕКУНД, НЕ МГНОВЕННО — согласовано явно перед реализацией.
// Метод analyze() вызывается клиентом периодически с уже накопленным
// на клиенте (и уже ограниченным клиентом по окну) транскриптом —
// НЕ хранит транскрипт между вызовами, каждый вызов независим.
//
// МАКСИМУМ ОДНА ПОДСКАЗКА ЗА ЦИКЛ — "тихие пуш-подсказки", не
// заваливать несколькими сразу. AI выбирает ОДИН наиболее уместный
// момент из двух возможных типов, не оба сразу.
//
// НЕ ПОВТОРЯЕТ УЖЕ ПРЕДЛОЖЕННЫЕ АРГУМЕНТЫ — отфильтровывает из списка
// кандидатов те, что уже фигурировали в LiveHintEvent этой сессии
// (projectId), не только lifecycleStatus=USED.

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ArgumentLifecycleStatus, ArgumentStance, LiveHintType } from '@prisma/client';

const TASK_TYPE = 'live-hint';

interface RawHint {
  hintType: 'ARGUMENT_SUGGESTION' | 'TOPIC_REPETITION';
  hintText: string;
  suggestedArgumentIndex?: number; // индекс в списке переданных кандидатов, не сам id (AI не должен придумывать id)
}

function isValidHintPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null) return true; // "нет уместной подсказки в этом цикле" — валидный честный ответ
    return (
      (parsed.hintType === 'ARGUMENT_SUGGESTION' || parsed.hintType === 'TOPIC_REPETITION') &&
      typeof parsed.hintText === 'string' &&
      parsed.hintText.trim().length > 0
    );
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT =
  'Тебе дан ПОСЛЕДНИЙ фрагмент транскрипта живого разговора (не весь разговор, только недавнее окно) и список аргументов, которые пользователь подготовил заранее, но ещё не озвучил. Реши, стоит ли дать ОДНУ тихую подсказку прямо сейчас — ТОЛЬКО если это действительно уместно, не для каждого цикла. Два возможных типа: (1) ARGUMENT_SUGGESTION — сейчас подходящий момент упомянуть один из непрозвучавших аргументов (укажи suggestedArgumentIndex — номер этого аргумента в переданном списке, начиная с 0); (2) TOPIC_REPETITION — собеседник явно повторно (минимум второй раз в этом фрагменте) возвращается к одной и той же теме — не игнорировать. Если ни один из двух случаев явно не подходит — верни JSON null, не выдумывай подсказку ради подсказки. Ответь СТРОГО валидным JSON: либо null, либо объектом вида {"hintType": "ARGUMENT_SUGGESTION"|"TOPIC_REPETITION", "hintText": string, "suggestedArgumentIndex": number}. Без пояснений вне JSON.';

@Injectable()
export class LiveHintsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  /** transcriptWindow — уже ограниченный КЛИЕНТОМ фрагмент (последние
   * ~10 минут), НЕ персистируется здесь ни при каких обстоятельствах. */
  async analyze(userId: string, projectId: string, transcriptWindow: string, engineId?: string) {
    if (!transcriptWindow.trim()) {
      throw new BadRequestException('transcriptWindow не может быть пустым');
    }
    await assertProjectOwnership(this.prisma, userId, projectId);

    const [candidateArguments, alreadySuggestedIds] = await Promise.all([
      this.prisma.argument.findMany({
        where: {
          projectId,
          targetPersonId: null,
          stance: { in: [ArgumentStance.PRO, ArgumentStance.CON] },
          lifecycleStatus: { not: ArgumentLifecycleStatus.USED },
        },
      }),
      this.prisma.liveHintEvent
        .findMany({ where: { projectId, suggestedArgumentId: { not: null } }, select: { suggestedArgumentId: true } })
        .then((rows: { suggestedArgumentId: string | null }[]) => new Set(rows.map((r) => r.suggestedArgumentId))),
    ]);

    // "Не повторяет уже предложенные" — фильтр ДО отправки в промпт,
    // не постфактум-проверка ответа AI.
    const freshCandidates = candidateArguments.filter((a: { id: string }) => !alreadySuggestedIds.has(a.id));

    const candidatesText = freshCandidates
      .map((a: { text: string }, i: number) => `[${i}] ${a.text}`)
      .join('\n');

    const userPrompt = [
      `Фрагмент транскрипта:\n${transcriptWindow}`,
      candidatesText ? `Непрозвучавшие подготовленные аргументы:\n${candidatesText}` : 'Непрозвучавших подготовленных аргументов нет.',
    ].join('\n\n');

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
        maxTokens: 300,
        validateOutput: isValidHintPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось получить подсказку — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const raw: RawHint | null = JSON.parse(result.text);
    if (!raw) return null; // честный "нет уместной подсказки в этом цикле", не подделываем

    let suggestedArgumentId: string | null = null;
    if (raw.hintType === 'ARGUMENT_SUGGESTION' && typeof raw.suggestedArgumentIndex === 'number') {
      const matched = freshCandidates[raw.suggestedArgumentIndex];
      // Индекс от AI мог "поплыть" (модель ошиблась с номером) — честно
      // не подставляем случайный аргумент, просто оставляем null.
      suggestedArgumentId = matched?.id ?? null;
    }

    return this.prisma.liveHintEvent.create({
      data: {
        projectId,
        hintType: raw.hintType === 'TOPIC_REPETITION' ? LiveHintType.TOPIC_REPETITION : LiveHintType.ARGUMENT_SUGGESTION,
        hintText: raw.hintText,
        suggestedArgumentId,
        generatedByInferenceId: result.aiInferenceId,
      },
    });
  }

  async markDismissed(userId: string, projectId: string, eventId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    const event = await this.prisma.liveHintEvent.findFirst({ where: { id: eventId, projectId } });
    if (!event) {
      throw new NotFoundException(`LiveHintEvent ${eventId} not found in project ${projectId}`);
    }
    return this.prisma.liveHintEvent.update({ where: { id: eventId }, data: { dismissed: true } });
  }

  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.liveHintEvent.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }
}

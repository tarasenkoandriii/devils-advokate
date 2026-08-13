// Пункт 15: TurningPointsService (§3.50 ТЗ) — вторая из 11 фич MVP v2
// поверх Conversation Dossier.
//
// АРХИТЕКТУРНОЕ РЕШЕНИЕ — НОВАЯ Prisma-модель НЕ заводилась вообще.
// У поворотных точек уже было всё нужное с чекпоинта 1:
// ConversationSignal(signalType=EMOTIONAL_SHIFT|ARGUMENT_ACCEPTANCE) —
// именно то, что описывает §3.50 ("накал необратимо пошёл вверх/вниз"
// = EMOTIONAL_SHIFT; "позиция фигуранта явно сдвинулась" =
// ARGUMENT_ACCEPTANCE, включая уже существующее правило §3.33 про
// confirmedGenuinely=false при совпадении с манипуляцией) —
// TranscriptSegment.startMs (Пункт 12/13) уже даёт точный таймкод
// ("не абстрактно где-то в середине, а конкретная минута/реплика") —
// TranscriptSegment.text уже даёт "какая фраза оказалась переломной".
//
// Единственное, чего не было — текстового объяснения ПОЧЕМУ AI считает
// момент переломным. Не добавлено как новое поле ConversationSignal
// (было бы полем, нужным только одному сигналу из шести существующих
// типов) — вместо этого переиспользован уже существующий путь
// AIInference + ConversationSignalEvidence, тот же паттерн, что уже
// в ArgumentGenerationService: ОДИН вызов AIRouterService → ОДИН
// AIInference → НЕСКОЛЬКО сущностей на него ссылаются (там —
// Argument.derivedFromInferenceId у всех аргументов одного вызова
// генерации, здесь — ConversationSignalEvidence.aiInferenceId у всех
// найденных за один прогон точек). detect()/list() парсят
// AIInference.output обратно в JSON и сопоставляют описание каждой
// точке по segmentId — не хранят N отдельных AIInference ради одного
// HTTP-вызова.

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConversationProcessingStatus, ConversationSignalType } from '@prisma/client';

const TASK_TYPE = 'turning-point-detection';

interface RawTurningPoint {
  segmentId: string;
  signalType: 'EMOTIONAL_SHIFT' | 'ARGUMENT_ACCEPTANCE';
  description: string;
  confidence?: number;
}

function isValidTurningPointsPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.segmentId === 'string' &&
        (item.signalType === 'EMOTIONAL_SHIFT' || item.signalType === 'ARGUMENT_ACCEPTANCE') &&
        typeof item.description === 'string' &&
        (item.confidence === undefined || typeof item.confidence === 'number'),
    );
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Ты анализируешь транскрипт разговора построчно, с указанием говорящего и id реплики. Найди моменты, где направление разговора решающе изменилось: (1) EMOTIONAL_SHIFT — момент, после которого напряжённость разговора необратимо выросла или снизилась; (2) ARGUMENT_ACCEPTANCE — момент, где собеседник явно сдвинул позицию или согласился с чем-то. Для каждого найденного момента укажи id ИМЕННО ТОЙ реплики (segmentId), после которой произошёл перелом. Ответь СТРОГО валидным JSON-массивом объектов вида {"segmentId": string, "signalType": "EMOTIONAL_SHIFT"|"ARGUMENT_ACCEPTANCE", "description": string, "confidence": number от 0 до 1}. Если переломных моментов нет — верни пустой массив []. Без пояснений вне JSON.';

@Injectable()
export class TurningPointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  /** Запускает детекцию (AI-вызов) и сразу возвращает результат —
   * отдельного "запустить" и "посмотреть позже" нет, в отличие от
   * транскрибации: анализ уже готового транскрипта синхронный и
   * быстрый (один текстовый промпт, не долгая внешняя обработка
   * аудио), не требует async job+webhook флоу, как STT. */
  async detect(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);

    if (conversation.status !== ConversationProcessingStatus.TRANSCRIBED) {
      throw new BadRequestException(
        `Conversation ${conversationId} must be TRANSCRIBED before turning-point detection (current: ${conversation.status})`,
      );
    }
    const segments = conversation.transcript?.segments ?? [];
    if (segments.length === 0) {
      throw new BadRequestException(`Conversation ${conversationId} has no transcript segments to analyze`);
    }

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { status: ConversationProcessingStatus.ANALYZING },
    });

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    const systemPrompt = activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT;
    const userPrompt = segments
      .map((s) => `[${s.id}] ${s.participant?.diarizationLabel ?? 'speaker'}: ${s.text}`)
      .join('\n');

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
        maxTokens: 1500,
        validateOutput: isValidTurningPointsPayload,
      });
    } catch (err) {
      // Статус откатывается на TRANSCRIBED (не остаётся в ANALYZING
      // навсегда) — тот же принцип, что AIRouterService откатывает
      // AIJob в FAILED при исключении, не оставляет RUNNING.
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { status: ConversationProcessingStatus.TRANSCRIBED },
      });
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException(
          'Анализ отклонён проверкой безопасности содержимого транскрипта.',
        );
      }
      throw new BadGatewayException(
        'Не удалось проанализировать разговор — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const rawPoints: RawTurningPoint[] = JSON.parse(result.text);
    const segmentById = new Map<string, (typeof segments)[number]>(
      segments.map((s: (typeof segments)[number]): [string, (typeof segments)[number]] => [s.id, s]),
    );

    // §3.33 ТЗ (правило, на которое прямо ссылается §3.50): согласие,
    // совпадающее по времени с манипулятивным паттерном на том же
    // сегменте, не подтверждается как искреннее. Проверяется здесь
    // (service-слой), не в схеме — та же формулировка инварианта, что
    // уже была зафиксирована в комментарии схемы над полем
    // confirmedGenuinely с чекпоинта 1, применяется на практике впервые.
    const manipulationSegmentIds = new Set(
      (
        await this.prisma.conversationSignal.findMany({
          where: {
            signalType: ConversationSignalType.MANIPULATION_PATTERN,
            transcriptSegmentId: { in: [...segmentById.keys()] },
          },
          select: { transcriptSegmentId: true },
        })
      ).map((s: { transcriptSegmentId: string | null }) => s.transcriptSegmentId),
    );

    const created = [];
    for (const point of rawPoints) {
      const segment = segmentById.get(point.segmentId);
      if (!segment) continue; // AI сослался на несуществующий id реплики — пропускаем, не падаем на всём батче

      const signal = await this.prisma.conversationSignal.create({
        data: {
          signalType: point.signalType as ConversationSignalType,
          transcriptSegmentId: segment.id,
          participantId: segment.participantId,
          confidence: point.confidence ?? null,
          confirmedGenuinely:
            point.signalType === 'ARGUMENT_ACCEPTANCE' ? !manipulationSegmentIds.has(segment.id) : null,
        },
      });
      await this.prisma.conversationSignalEvidence.create({
        data: { conversationSignalId: signal.id, aiInferenceId: result.aiInferenceId },
      });
      created.push({ ...signal, segment, description: point.description });
    }

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { status: ConversationProcessingStatus.ANALYZED },
    });

    return created;
  }

  /** Список уже найденных поворотных точек (без нового AI-вызова) —
   * восстанавливает description из общего AIInference.output по
   * segmentId, не хранит его отдельно на каждом ConversationSignal
   * (см. обоснование в шапке файла). */
  async list(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);
    const segmentIds = (conversation.transcript?.segments ?? []).map((s: { id: string }) => s.id);
    if (segmentIds.length === 0) return [];

    const signals = await this.prisma.conversationSignal.findMany({
      where: {
        signalType: { in: [ConversationSignalType.EMOTIONAL_SHIFT, ConversationSignalType.ARGUMENT_ACCEPTANCE] },
        transcriptSegmentId: { in: segmentIds },
      },
      include: {
        transcriptSegment: true,
        evidence: { include: { aiInference: true } },
      },
    });

    const segmentOrder = new Map<string, number>(
      segmentIds.map((id: string, i: number): [string, number] => [id, i]),
    );
    return signals
      .map((signal: any) => {
        const description = this.resolveDescription(signal);
        return { ...signal, description };
      })
      .sort(
        (a: any, b: any) =>
          (segmentOrder.get(a.transcriptSegmentId ?? '') ?? 0) -
          (segmentOrder.get(b.transcriptSegmentId ?? '') ?? 0),
      );
  }

  private resolveDescription(signal: {
    transcriptSegmentId: string | null;
    evidence: Array<{ aiInference: { output: string } | null }>;
  }): string | null {
    for (const ev of signal.evidence) {
      if (!ev.aiInference) continue;
      try {
        const parsed: RawTurningPoint[] = JSON.parse(ev.aiInference.output);
        const match = parsed.find((p) => p.segmentId === signal.transcriptSegmentId);
        if (match) return match.description;
      } catch {
        // AIInference.output от другой фичи/не JSON — пропускаем, не падаем
        continue;
      }
    }
    return null;
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

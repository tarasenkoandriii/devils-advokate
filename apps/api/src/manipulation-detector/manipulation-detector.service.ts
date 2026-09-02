// Пункт 36: ManipulationDetectorService (§3.28 ТЗ) — первая из трёх
// фич MVP v3, отобранных как готовые СЕЙЧАС без новой инфраструктуры
// (по итогам явного анализа: "стоит ли выполнять MVP v3 сейчас",
// см. соответствующий раздел этого README).
//
// АРХИТЕКТУРНОЕ РЕШЕНИЕ — тот же класс, что уже применялся к Turning
// Points (Пункт 15): НОВАЯ Prisma-модель НЕ заводилась. У детектора
// манипуляций уже было всё нужное с чекпоинта 1:
// ConversationSignal(signalType=MANIPULATION_PATTERN) — этот enum-
// значение существовало в схеме с самого начала, но ни один сервис ни
// разу его не создавал (Turning Points только ЧИТАЕТ его, чтобы
// проверить confirmedGenuinely — см. manipulationSegmentIds в
// turning-points.service.ts) — тот же класс пробела, что уже
// находился раньше (модель/enum есть, сервиса-создателя нет), здесь
// закрыт реализацией.
//
// КЛЮЧЕВОЕ ОТЛИЧИЕ ОТ Do Not Say (Пункт 18, §3.53/§3.17): та фича
// анализирует ТОЛЬКО реплики isSelf-участника (риск для самого
// пользователя). Здесь — ТЗ прямо требует обратное: "распознавание
// работает на ОБОИХ говорящих через диаризацию" (§3.28, "полезный
// побочный эффект... симметрично 3.17") — детектор манипуляций
// анализирует ВСЕ реплики без фильтра по isSelf, включая реплики
// собеседника (основной случай использования) и реплики самого
// пользователя (побочный эффект, явно упомянутый в ТЗ).
//
// "Техника манипуляции" (переход на личности/подмена тезиса/ложная
// дилемма/whataboutism/апелляция к эмоциям/давление на срочность) —
// НЕ отдельное enum-поле схемы (ConversationSignal не имеет
// специального поля под это, в отличие от riskCategory для SELF_RISK
// или severity для FACTUAL_DISCREPANCY) — хранится текстом внутри
// AIInference.output, восстанавливается в list() тем же способом, что
// description у Turning Points, не отдельным полем на каждый сигнал
// ради одного значения на batch-вызов.

import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConversationProcessingStatus, ConversationSignal, ConversationSignalType } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'manipulation-detection';

interface RawManipulationPoint {
  segmentId: string;
  technique: string; // например "переход на личности", "ложная дилемма" — не enum, см. обоснование в шапке файла
  description: string;
  confidence?: number;
}

function isValidManipulationPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.segmentId === 'string' &&
        typeof item.technique === 'string' &&
        typeof item.description === 'string' &&
        (item.confidence === undefined || typeof item.confidence === 'number'),
    );
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Ты анализируешь транскрипт разговора построчно, с указанием говорящего и id реплики. Найди реплики ЛЮБОГО из говорящих (не только одного конкретного), где используется манипулятивный приём аргументации: переход на личности, подмена тезиса, ложная дилемма, whataboutism (аргумент "а вот ты..."), апелляция к эмоциям вместо сути, давление на срочность. Для каждой найденной реплики укажи: segmentId — id реплики, technique — короткое название приёма на русском, description — конкретно, в чём проявился приём в ЭТОЙ реплике. Ответь СТРОГО валидным JSON-массивом объектов вида {"segmentId": string, "technique": string, "description": string, "confidence": number от 0 до 1}. Если манипулятивных приёмов нет — верни пустой массив []. Без пояснений вне JSON.';

@Injectable()
export class ManipulationDetectorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async detect(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);

    if (
      conversation.status !== ConversationProcessingStatus.TRANSCRIBED &&
      conversation.status !== ConversationProcessingStatus.ANALYZED
    ) {
      throw new BadRequestException(
        `Conversation ${conversationId} must be TRANSCRIBED before manipulation detection (current: ${conversation.status})`,
      );
    }
    const segments = conversation.transcript?.segments ?? [];
    if (segments.length === 0) {
      throw new BadRequestException(`Conversation ${conversationId} has no transcript segments to analyze`);
    }

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    const systemPrompt = activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT;
    // Все реплики, оба говорящих — НЕ фильтруется по isSelf (см. обоснование в шапке файла).
    const userPrompt = segments
      .map((s: (typeof segments)[number]) => `[${s.id}] ${s.participant?.diarizationLabel ?? 'speaker'}: ${s.text}`)
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
        validateOutput: isValidManipulationPayload,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Анализ отклонён проверкой безопасности содержимого транскрипта.');
      }
      throw new BadGatewayException(
        'Не удалось проверить разговор на манипулятивные приёмы — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const rawPoints: RawManipulationPoint[] = JSON.parse(result.text);
    const segmentById = new Map<string, (typeof segments)[number]>(
      segments.map((s: (typeof segments)[number]): [string, (typeof segments)[number]] => [s.id, s]),
    );

    const created: Array<ConversationSignal & { segment: (typeof segments)[number]; technique: string; description: string }> = [];
    for (const point of rawPoints) {
      const segment = segmentById.get(point.segmentId);
      if (!segment) continue; // AI сослался на несуществующий id реплики — пропускаем, не падаем на всём батче

      const signal = await this.prisma.conversationSignal.create({
        data: {
          signalType: ConversationSignalType.MANIPULATION_PATTERN,
          transcriptSegmentId: segment.id,
          participantId: segment.participantId,
          confidence: point.confidence ?? null,
        },
      });
      await this.prisma.conversationSignalEvidence.create({
        data: { conversationSignalId: signal.id, aiInferenceId: result.aiInferenceId },
      });
      created.push({ ...signal, segment, technique: point.technique, description: point.description });
    }

    return created;
  }

  /** Список уже найденных манипулятивных приёмов (без нового AI-вызова)
   * — восстанавливает technique/description из общего AIInference.output
   * по segmentId, тот же паттерн, что TurningPointsService.list(). */
  async list(userId: string, conversationId: string) {
    const conversation = await this.findOwnedConversationWithTranscript(userId, conversationId);
    const segmentIds = (conversation.transcript?.segments ?? []).map((s: { id: string }) => s.id);
    if (segmentIds.length === 0) return [];

    const signals = await this.prisma.conversationSignal.findMany({
      where: {
        signalType: ConversationSignalType.MANIPULATION_PATTERN,
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
        const resolved = this.resolveTechniqueAndDescription(signal);
        return { ...signal, technique: resolved?.technique ?? null, description: resolved?.description ?? null };
      })
      .sort(
        (a: any, b: any) =>
          (segmentOrder.get(a.transcriptSegmentId ?? '') ?? 0) -
          (segmentOrder.get(b.transcriptSegmentId ?? '') ?? 0),
      );
  }

  private resolveTechniqueAndDescription(signal: {
    transcriptSegmentId: string | null;
    evidence: Array<{ aiInference: { output: string } | null }>;
  }): { technique: string; description: string } | null {
    for (const ev of signal.evidence) {
      if (!ev.aiInference) continue;
      try {
        const parsed: RawManipulationPoint[] = JSON.parse(ev.aiInference.output);
        const match = parsed.find((p) => p.segmentId === signal.transcriptSegmentId);
        if (match) return { technique: match.technique, description: match.description };
      } catch {
        continue; // AIInference.output от другой фичи/не JSON — пропускаем, не падаем
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

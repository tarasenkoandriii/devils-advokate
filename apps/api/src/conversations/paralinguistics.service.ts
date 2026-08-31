// Пункт [multimodal] §7 — паралингвистика собственной записи: то, что
// текст теряет на первом же шаге конвейера. Диаризация говорит «кто»,
// этот проход добавляет «как»: паузу перед ответом, срыв темпа,
// несовпадение слов и подачи.
//
// НАДСТРАИВАЕТСЯ над AssemblyAI, не заменяет его: транскрипт остаётся
// источником истины по словам, таймкодам и диаризации; модель получает
// УЖЕ ГОТОВЫЕ сегменты с id и таймкодами и только комментирует подачу
// известных реплик. Поэтому запуск — строго ПОСЛЕ TRANSCRIBED (§7.1):
// это устраняет расхождение двух транскриптов и делает привязку
// сигналов детерминированной.
//
// §7.4 — ЖЁСТКАЯ ГРАНИЦА: никаких выводов о личности, правдивости,
// намерениях, психическом состоянии, никакой «детекции лжи». Только
// описание наблюдаемого. Запрет живёт в промпте, в валидации и в
// тестах — не только в этом комментарии. Паралингвистика — самая
// соблазнительная фича продукта для превращения в детектор лжи, и
// продукт уже провёл эту линию трижды (Пункт 40, health §2.1,
// userConfirmedIntentionalFalsehood — только пользователем).

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AsyncJobOutcome } from '../ai-router/ai-router.service';
import { ConversationSignalType } from '@prisma/client';

export const PARALINGUISTICS_TASK_TYPE = 'conversation-paralinguistics';

export const DEFAULT_PARALINGUISTICS_PROMPT = `Ты слушаешь запись разговора. Текстовый транскрипт уже готов и передан ниже — НЕ транскрибируй заново.
Для каждого сегмента, где есть что отметить, опиши ПОДАЧУ и верни СТРОГО JSON:
{"segments":[{"segmentId":"<id из списка>","delivery":"наблюдаемая подача","signals":[{"type":"DELIVERY_INCONGRUENCE|EMOTIONAL_SHIFT","channel":"prosody|pace|pause|visual","confidence":0.0,"rationale":"почему"}]}]}
Требования, каждое обязательно:
- segmentId ТОЛЬКО из переданного списка — не выдумывай сегменты;
- описывай только наблюдаемое: темп, паузы, интонационный контур, несовпадение слов и подачи;
- ЗАПРЕЩЕНЫ суждения о правдивости, намерениях, характере, психическом состоянии, любая «детекция лжи»;
- сегменты без примечательной подачи просто не включай; пустой ответ {"segments":[]} валиден.`;

const ALLOWED_TYPES = new Set<string>([
  ConversationSignalType.DELIVERY_INCONGRUENCE,
  ConversationSignalType.EMOTIONAL_SHIFT,
]);

/** §7.4 — стоп-слова «выводов о личности» в выходе модели. Грубый, но
 * честный фильтр второй линии (первая — промпт): попадание — провал
 * валидации и retry, а не запись сигнала. */
const FORBIDDEN_JUDGEMENT_PATTERNS = /лжёт|лжет|врёт|врет|обманывает|лживый|is lying|liar|deceptive person|психопат|нарцисс/i;

interface ParsedParalinguistics {
  segments: Array<{
    segmentId: string;
    delivery?: string;
    signals: Array<{ type: ConversationSignalType; channel?: string; confidence?: number }>;
  }>;
}

export function parseParalinguisticsOutput(text: string): ParsedParalinguistics | null {
  let json: unknown;
  try {
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const root = json as { segments?: unknown };
  if (!Array.isArray(root.segments)) return null;
  if (FORBIDDEN_JUDGEMENT_PATTERNS.test(text)) return null;

  const segments: ParsedParalinguistics['segments'] = [];
  for (const raw of root.segments) {
    if (typeof raw !== 'object' || raw === null) return null;
    const seg = raw as Record<string, unknown>;
    if (typeof seg.segmentId !== 'string' || !seg.segmentId.trim()) return null;
    const signals: ParsedParalinguistics['segments'][number]['signals'] = [];
    if (seg.signals !== undefined) {
      if (!Array.isArray(seg.signals)) return null;
      for (const s of seg.signals) {
        if (typeof s !== 'object' || s === null) return null;
        const sig = s as Record<string, unknown>;
        if (typeof sig.type !== 'string' || !ALLOWED_TYPES.has(sig.type)) return null;
        signals.push({
          type: sig.type as ConversationSignalType,
          channel: typeof sig.channel === 'string' ? sig.channel : undefined,
          confidence: typeof sig.confidence === 'number' ? sig.confidence : undefined,
        });
      }
    }
    segments.push({
      segmentId: seg.segmentId,
      delivery: typeof seg.delivery === 'string' ? seg.delivery : undefined,
      signals,
    });
  }
  return { segments };
}

function msToTimecode(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

@Injectable()
export class ParalinguisticsService implements OnModuleInit {
  private readonly logger = new Logger(ParalinguisticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  onModuleInit(): void {
    this.aiRouter.registerOutputValidator(
      PARALINGUISTICS_TASK_TYPE,
      (text) => parseParalinguisticsOutput(text) !== null,
    );
    this.aiRouter.registerCompletionHandler(PARALINGUISTICS_TASK_TYPE, (outcome) =>
      this.handleOutcome(outcome),
    );
  }

  /** Запуск прохода — вызывается из handleTranscriptionWebhook ПОСЛЕ
   * записи транскрипта (§7.1). Бросает при невозможности — вызывающий
   * код обязан освободить зарезервированного потребителя файла. */
  async enqueueForConversation(conversationId: string): Promise<{ jobId: string }> {
    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      include: {
        project: { select: { ownerId: true, id: true } },
        transcript: { include: { segments: { orderBy: { startMs: 'asc' } } } },
      },
    });
    if (!conversation.audioBlobPathname) {
      throw new Error('paralinguistics requires the audio blob — streaming-path conversations have none');
    }
    const segments = conversation.transcript?.segments ?? [];
    if (segments.length === 0) {
      throw new Error('paralinguistics requires a non-empty transcript');
    }

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: PARALINGUISTICS_TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    // Сегменты подставляются в текстовую часть промпта: модель
    // комментирует ИЗВЕСТНЫЕ реплики, не транскрибирует заново (§7.1).
    const segmentList = segments
      .map(
        (s) =>
          `{"segmentId":"${s.id}","start":"${msToTimecode(s.startMs)}","end":"${msToTimecode(s.endMs)}","text":${JSON.stringify(s.text)}}`,
      )
      .join('\n');

    const { jobId } = await this.aiRouter.enqueue({
      userId: conversation.project.ownerId,
      projectId: conversation.project.id,
      taskType: PARALINGUISTICS_TASK_TYPE,
      promptVersionId: activePrompt?.id,
      userPrompt: [
        // Медиа первым, текст после — рекомендация провайдера (§5).
        {
          type: 'media',
          ref: {
            source: 'blob',
            pathname: conversation.audioBlobPathname,
            mimeType: conversation.audioBlobContentType ?? 'application/octet-stream',
          },
        },
        {
          type: 'text',
          text: `${activePrompt?.template ?? DEFAULT_PARALINGUISTICS_PROMPT}\n\nСегменты транскрипта:\n${segmentList}`,
        },
      ],
      jsonMode: true,
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { paralinguisticsJobId: jobId },
    });
    return { jobId };
  }

  private async handleOutcome(outcome: AsyncJobOutcome): Promise<void> {
    if (outcome.kind === 'waiting') return;

    const conversation = await this.prisma.conversation.findFirst({
      where: { paralinguisticsJobId: outcome.jobId },
      include: { transcript: { include: { segments: { select: { id: true, participantId: true } } } } },
    });
    if (!conversation) return;

    try {
      if (outcome.kind === 'completed') {
        await this.persist(conversation.id, outcome.aiInferenceId, conversation.transcript?.segments ?? []);
      } else {
        this.logger.warn(`Paralinguistics job ${outcome.jobId} failed: ${outcome.reason}`);
      }
    } finally {
      // Потребитель файла освобождается при ЛЮБОМ исходе — иначе blob
      // висит до сторожевой (§7.2). Ленивый импорт против цикла
      // conversations ↔ paralinguistics на уровне файлов не нужен:
      // release живёт в ConversationsService, но чтобы не тянуть его
      // сюда (цикл DI), декремент делается напрямую — та же логика,
      // одно место данных.
      await this.releaseConsumer(conversation.id);
    }
  }

  /** Декремент потребителя + удаление файла на нуле. Продублировано с
   * ConversationsService.releaseMediaConsumer намеренно НЕ полностью:
   * само удаление blob'а делегируется AudioBlobService через
   * запись-маркер — здесь только декремент; физическую чистку нуля
   * выполняет releaseMediaConsumer, вызываемый из reap или вебхука.
   * Чтобы не оставлять файл до сторожевой в типичном случае, декремент
   * до нуля дополнительно триггерит немедленную чистку через
   * ConversationsService — см. wireRelease(). */
  private releaseFn: ((conversationId: string, count?: number) => Promise<void>) | null = null;

  /** ConversationsService подключает свой releaseMediaConsumer сюда в
   * onModuleInit — инъекция функцией вместо инъекции сервиса, чтобы не
   * заводить circular DI (forwardRef) ради одного вызова. */
  wireRelease(fn: (conversationId: string, count?: number) => Promise<void>): void {
    this.releaseFn = fn;
  }

  private async releaseConsumer(conversationId: string): Promise<void> {
    if (this.releaseFn) {
      await this.releaseFn(conversationId, 1);
      return;
    }
    // Фолбэк, если проводка не случилась: хотя бы декремент, файл
    // подчистит сторожевая по lease.
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { pendingMediaConsumers: { decrement: 1 } },
    });
  }

  private async persist(
    conversationId: string,
    aiInferenceId: string,
    segments: Array<{ id: string; participantId: string | null }>,
  ): Promise<void> {
    const inference = await this.prisma.aIInference.findUniqueOrThrow({ where: { id: aiInferenceId } });
    const parsed = parseParalinguisticsOutput(inference.output);
    if (!parsed) return;

    const known = new Map(segments.map((s) => [s.id, s]));
    let invented = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const seg of parsed.segments) {
        const target = known.get(seg.segmentId);
        if (!target) {
          // §8.2: выдуманный сегмент. Валидатор в роутере структуру
          // проверил, но множество id знает только этот код. Пропуск с
          // подсчётом — тот же паттерн, что у manipulation-detector
          // («AI сослался на несуществующий id — пропускаем, не падаем
          // на всём батче»); полный провал был бы хуже: он выбросил бы
          // и валидные сигналы.
          invented++;
          continue;
        }
        for (const sig of seg.signals) {
          const signal = await tx.conversationSignal.create({
            data: {
              signalType: sig.type,
              transcriptSegmentId: target.id,
              participantId: target.participantId,
              confidence: sig.confidence ?? null,
              paralinguisticChannel: sig.channel ?? null,
            },
          });
          await tx.conversationSignalEvidence.create({
            data: { conversationSignalId: signal.id, aiInferenceId },
          });
        }
      }
    });

    if (invented > 0) {
      this.logger.warn(
        `Paralinguistics for conversation ${conversationId}: модель сослалась на ${invented} несуществующих сегментов — пропущены`,
      );
    }
  }
}

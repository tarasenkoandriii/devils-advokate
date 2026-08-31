// Пункт [multimodal] §6 — полностью автоматический разбор публичного
// видео: от «выбрал ролик» до готового разбора без единого действия
// пользователя. Байты ролика НИКОГДА не проходят через нашу
// инфраструктуру — провайдеру передаётся YouTube-URI, содержимое
// забирает провайдер (§0; чем это отличается от отклонённого §2.2
// yt-dlp — таблица §1.3 ТЗ).
//
// Этот сервис — «потребитель» асинхронной полосы роутера: он ставит
// джобу (enqueueItemAnalysis) и регистрирует обработчик завершения
// (onModuleInit → registerCompletionHandler). Роутер про media-review
// не знает ничего — зависимость односторонняя.

import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AsyncJobOutcome } from '../ai-router/ai-router.service';
import {
  AIJobStatus,
  ConversationProcessingStatus,
  ConversationSignalType,
  ConversationSourceType,
  MediaReviewItemStatus,
} from '@prisma/client';

export const MEDIA_PUBLIC_REVIEW_TASK_TYPE = 'media-public-review';

/** §6.5 — 20 минут. Не круглое число на глаз: ~300 токенов/сек видео
 * по полной ставке (media_resolution в Interactions API не подтверждён,
 * считаем без скидки) ⇒ ~360 000 токенов на ролик — в контекст с
 * запасом; 8-часовой суточный free-tier лимит даёт ~24 таких ролика в
 * сутки НА ВЕСЬ ПРОДУКТ (не на пользователя, §9.3). Длительность —
 * единственный доступный нам рычаг стоимости. */
export const MEDIA_REVIEW_MAX_DURATION_SECONDS = 1200;

/** §8.1 — дефолтный промпт; ACTIVE-версия из PromptRegistry
 * (promptId = taskType) перекрывает его, ровно как у intake-classify. */
export const DEFAULT_MEDIA_REVIEW_PROMPT = `Ты разбираешь публичное видео. Верни СТРОГО JSON без пояснений вокруг:
{"language":"<код языка или null>","segments":[{"start":"MM:SS","end":"MM:SS","speakerLabel":"SPEAKER_00","text":"дословная реплика","delivery":"наблюдаемая подача: темп, паузы, интонационный контур","signals":[{"type":"MANIPULATION_PATTERN|FACTUAL_DISCREPANCY|EMOTIONAL_SHIFT|DELIVERY_INCONGRUENCE|PROBING_PATTERN","channel":"prosody|pace|pause|visual","confidence":0.0,"rationale":"почему"}]}]}
Требования, каждое обязательно:
- таймкоды в формате MM:SS (минуты:секунды от начала ролика);
- реплики дословные, без пересказа;
- delivery — ТОЛЬКО описание наблюдаемого (темп, паузы, интонация, несовпадение слов и подачи);
- ЗАПРЕЩЕНЫ любые суждения о правдивости, намерениях, характере или психическом состоянии говорящих, любая «детекция лжи»;
- signals может быть пустым массивом; не выдумывай сигналы ради количества.`;

interface ParsedSegment {
  startMs: number;
  endMs: number;
  speakerLabel: string;
  text: string;
  delivery?: string;
  signals: Array<{
    type: ConversationSignalType;
    channel?: string;
    confidence?: number;
  }>;
}

const ALLOWED_SIGNAL_TYPES = new Set<string>([
  ConversationSignalType.MANIPULATION_PATTERN,
  ConversationSignalType.FACTUAL_DISCREPANCY,
  ConversationSignalType.EMOTIONAL_SHIFT,
  ConversationSignalType.DELIVERY_INCONGRUENCE,
  ConversationSignalType.PROBING_PATTERN,
]);

/** "MM:SS" (или "H:MM:SS") → миллисекунды; null, если не разобралось.
 * Конвертация НА НАШЕЙ стороне: MM:SS — документированный для Gemini
 * формат таймкодов (§8.1), модель не просят считать миллисекунды. */
export function timecodeToMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    // Число трактуем как уже-миллисекунды — на случай, если модель
    // вернула startMs напрямую; оба варианта валидны.
    return Math.round(value);
  }
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, h, mm, ss] = m;
  return ((Number(h ?? 0) * 60 + Number(mm)) * 60 + Number(ss)) * 1000;
}

/** Разбор и структурная валидация выхода модели. Возвращает null при
 * любом нарушении схемы — вызывающий код превращает это в провал
 * validateOutput (retry), а не в тихую запись мусора. Экспортирован
 * для тестов и для регистрации в роутере. */
export function parseMediaReviewOutput(text: string): { language: string | null; segments: ParsedSegment[] } | null {
  let json: unknown;
  try {
    // Модель иногда оборачивает JSON в ```-заборы несмотря на запрет.
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const root = json as { language?: unknown; segments?: unknown };
  if (!Array.isArray(root.segments) || root.segments.length === 0) return null;

  const segments: ParsedSegment[] = [];
  for (const raw of root.segments) {
    if (typeof raw !== 'object' || raw === null) return null;
    const seg = raw as Record<string, unknown>;
    const startMs = timecodeToMs(seg.start ?? seg.startMs);
    const endMs = timecodeToMs(seg.end ?? seg.endMs);
    if (startMs === null || endMs === null || endMs < startMs) return null;
    if (typeof seg.speakerLabel !== 'string' || !seg.speakerLabel.trim()) return null;
    if (typeof seg.text !== 'string' || !seg.text.trim()) return null;

    const signals: ParsedSegment['signals'] = [];
    if (seg.signals !== undefined) {
      if (!Array.isArray(seg.signals)) return null;
      for (const s of seg.signals) {
        if (typeof s !== 'object' || s === null) return null;
        const sig = s as Record<string, unknown>;
        if (typeof sig.type !== 'string' || !ALLOWED_SIGNAL_TYPES.has(sig.type)) return null;
        signals.push({
          type: sig.type as ConversationSignalType,
          channel: typeof sig.channel === 'string' ? sig.channel : undefined,
          confidence: typeof sig.confidence === 'number' ? sig.confidence : undefined,
        });
      }
    }
    segments.push({
      startMs,
      endMs,
      speakerLabel: seg.speakerLabel.trim(),
      text: seg.text,
      delivery: typeof seg.delivery === 'string' ? seg.delivery : undefined,
      signals,
    });
  }
  return { language: typeof root.language === 'string' ? root.language : null, segments };
}

@Injectable()
export class MediaReviewAutoService implements OnModuleInit {
  private readonly logger = new Logger(MediaReviewAutoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  onModuleInit(): void {
    // Валидатор и обработчик завершения — по taskType, потому что
    // validateOutput (функция) не сериализуется в pendingRequest.
    this.aiRouter.registerOutputValidator(
      MEDIA_PUBLIC_REVIEW_TASK_TYPE,
      (text) => parseMediaReviewOutput(text) !== null,
    );
    this.aiRouter.registerCompletionHandler(MEDIA_PUBLIC_REVIEW_TASK_TYPE, (outcome) =>
      this.handleOutcome(outcome),
    );
  }

  /** §6.1 — автоматический запуск разбора для элемента очереди.
   * Отказ (длительность, приватность режима, отсутствие согласия
   * EXTERNAL_AI) НЕ роняет добавление в очередь: элемент остаётся в
   * AWAITING_UPLOAD с человекочитаемой причиной, и ручной путь §2.2
   * доступен пользователю как раньше (§6.4). */
  async tryEnqueueAnalysis(
    userId: string,
    queue: { id: string; projectId: string },
    item: {
      id: string;
      youtubeVideoId: string;
      title: string;
      durationSeconds: number | null;
      publishedAt: Date | null;
      createdAt: Date;
      /** Ретрай передаёт существующий разговор — он переиспользуется,
       * а не дублируется (§6.1: один Conversation на элемент). */
      conversationId?: string | null;
    },
  ): Promise<void> {
    // §6.5: длительность известна ДО вызова из метаданных YouTube —
    // отказ сразу, а не после неудачного (и оплаченного) вызова.
    if ((item.durationSeconds ?? 0) > MEDIA_REVIEW_MAX_DURATION_SECONDS) {
      await this.prisma.mediaReviewQueueItem.update({
        where: { id: item.id },
        data: {
          autoAnalysisError: `Ролик длиннее ${MEDIA_REVIEW_MAX_DURATION_SECONDS / 60} минут — автоматический разбор ограничен по стоимости; загрузите файл вручную либо выберите фрагмент короче`,
        },
      });
      return;
    }
    if (item.durationSeconds === null) {
      await this.prisma.mediaReviewQueueItem.update({
        where: { id: item.id },
        data: {
          autoAnalysisError:
            'Длительность ролика неизвестна — без неё автоматический разбор не запускается (лимит стоимости проверить нечем)',
        },
      });
      return;
    }

    try {
      // Conversation создаётся НАМИ, не пользователем — для этого
      // очередь и получила projectId (§6.1.1). occurredAt — из
      // publishedAt ролика (когда разговор реально состоялся), с
      // фолбэком на момент добавления (§6.1 [R2]). При ретрае разговор
      // уже существует (FAILED после прошлой попытки) — возвращаем его
      // в ANALYZING вместо создания дубликата.
      let conversationId = item.conversationId ?? null;
      if (conversationId) {
        await this.prisma.conversation.update({
          where: { id: conversationId },
          data: { status: ConversationProcessingStatus.ANALYZING },
        });
      } else {
        const conversation = await this.prisma.conversation.create({
          data: {
            projectId: queue.projectId,
            sourceType: ConversationSourceType.PUBLIC_VIDEO_URI,
            status: ConversationProcessingStatus.ANALYZING,
            occurredAt: item.publishedAt ?? item.createdAt,
            durationSeconds: item.durationSeconds,
            // rawFileRef — «клиентская ссылка на первоисточник, не сам
            // файл»: YouTube-ссылка ложится в него по прямому назначению.
            rawFileRef: `https://www.youtube.com/watch?v=${item.youtubeVideoId}`,
          },
        });
        conversationId = conversation.id;
      }

      const activePrompt = await this.prisma.promptVersion.findFirst({
        where: { promptId: MEDIA_PUBLIC_REVIEW_TASK_TYPE, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
      });

      const { jobId } = await this.aiRouter.enqueue({
        userId,
        projectId: queue.projectId,
        taskType: MEDIA_PUBLIC_REVIEW_TASK_TYPE,
        promptVersionId: activePrompt?.id,
        userPrompt: [
          // Порядок значим: медиа ПЕРВЫМ, текст после — рекомендация
          // документации провайдера, обязанность вызывающего кода (§5).
          { type: 'media', ref: { source: 'youtube', videoId: item.youtubeVideoId } },
          { type: 'text', text: activePrompt?.template ?? DEFAULT_MEDIA_REVIEW_PROMPT },
        ],
        jsonMode: true,
      });

      await this.prisma.mediaReviewQueueItem.update({
        where: { id: item.id },
        data: {
          status: MediaReviewItemStatus.PROCESSING,
          conversationId,
          aiJobId: jobId,
          autoAnalysisError: null,
        },
      });
    } catch (err) {
      const reason =
        err instanceof ForbiddenException
          ? `Автоматический разбор требует согласия на внешний AI (EXTERNAL_AI): ${err.message}`
          : `Автоматический разбор не запустился: ${err instanceof Error ? err.message : 'неизвестная ошибка'}`;
      await this.prisma.mediaReviewQueueItem.update({
        where: { id: item.id },
        data: { autoAnalysisError: reason },
      });
      this.logger.warn(`Auto-analysis enqueue failed for item ${item.id}: ${err}`);
    }
  }

  /** Повторный запуск автоматического разбора по запросу пользователя —
   * для элементов, чей прошлый разбор упал (квота 429, форма запроса,
   * сторожевая). Появился после первого живого прогона: до пополнения
   * баланса Gemini элементы честно откатывались в AWAITING_UPLOAD, и
   * кроме SQL их было нечем перезапустить. Разговор переиспользуется,
   * дубликат не создаётся; активную джобу не перебиваем — двойная
   * постановка = двойной счёт провайдеру (§4.5). */
  async retryAnalysis(
    userId: string,
    itemId: string,
  ): Promise<{ status: MediaReviewItemStatus; autoAnalysisError: string | null }> {
    const item = await this.prisma.mediaReviewQueueItem.findFirst({
      where: { id: itemId, queue: { userId } },
      include: { queue: { select: { id: true, projectId: true } } },
    });
    if (!item) {
      // Чужой элемент неотличим от несуществующего — тот же принцип,
      // что в getJobForUser.
      throw new BadRequestException('Элемент очереди не найден');
    }
    if (item.status === MediaReviewItemStatus.DONE) {
      throw new BadRequestException('Элемент уже разобран — повторный запуск перезаписал бы готовый разбор');
    }
    if (item.aiJobId) {
      const job = await this.prisma.aIJob.findUnique({ where: { id: item.aiJobId } });
      if (job && (job.status === AIJobStatus.QUEUED || job.status === AIJobStatus.RUNNING)) {
        throw new BadRequestException(
          'Предыдущий разбор ещё выполняется — дождитесь его завершения (зависшую джобу сторожевая закроет не позднее чем через 2 часа)',
        );
      }
    }

    // Те же проверки длительности и тот же путь постановки, что при
    // первом запуске; отказ ложится в autoAnalysisError, не бросает.
    await this.tryEnqueueAnalysis(userId, item.queue, item);

    const refreshed = await this.prisma.mediaReviewQueueItem.findUniqueOrThrow({
      where: { id: itemId },
      select: { status: true, autoAnalysisError: true },
    });
    return refreshed;
  }

  /** Обработчик завершения асинхронной джобы (вызывается воркером
   * роутера). completed → персистенс §6.2; failed → откат §6.4. */
  private async handleOutcome(outcome: AsyncJobOutcome): Promise<void> {
    if (outcome.kind === 'waiting') return; // ре-постановка на ретрай — ждём дальше

    const item = await this.prisma.mediaReviewQueueItem.findFirst({
      where: { aiJobId: outcome.jobId },
    });
    if (!item) return; // джоба не из очереди медиа-разбора

    if (outcome.kind === 'failed') {
      await this.prisma.$transaction([
        this.prisma.mediaReviewQueueItem.update({
          where: { id: item.id },
          data: {
            status: MediaReviewItemStatus.AWAITING_UPLOAD,
            autoAnalysisError: outcome.reason,
          },
        }),
        ...(item.conversationId
          ? [
              this.prisma.conversation.update({
                where: { id: item.conversationId },
                data: { status: ConversationProcessingStatus.FAILED },
              }),
            ]
          : []),
      ]);
      return;
    }

    await this.persistAnalysis(item.id, outcome.aiInferenceId);
  }

  /** §6.2 — персистенс результата, ЕДИНОЙ транзакцией и строго в этом
   * порядке: участники → транскрипт → сегменты → сигналы. Без этого
   * шага getSummary() очереди возвращал бы 0 при любом количестве
   * находок: сводка считает сигналы ЧЕРЕЗ сегменты. Частично
   * записанный разбор хуже отсутствующего — он выглядит успешным. */
  async persistAnalysis(itemId: string, aiInferenceId: string): Promise<void> {
    const item = await this.prisma.mediaReviewQueueItem.findUniqueOrThrow({ where: { id: itemId } });
    if (!item.conversationId) {
      throw new Error(`MediaReviewQueueItem ${itemId} has no conversation to persist into`);
    }
    const conversationId = item.conversationId;

    const inference = await this.prisma.aIInference.findUniqueOrThrow({ where: { id: aiInferenceId } });
    const parsed = parseMediaReviewOutput(inference.output);
    if (!parsed) {
      // validateOutput в роутере уже проверил форму — сюда попадаем
      // только при рассинхроне валидатора и парсера. Честный отказ.
      await this.prisma.mediaReviewQueueItem.update({
        where: { id: itemId },
        data: {
          status: MediaReviewItemStatus.AWAITING_UPLOAD,
          autoAnalysisError: 'Выход модели не разобрался при персистенсе (рассинхрон валидатора и парсера) — сообщите разработчику',
        },
      });
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      // 1. Участники: isSelf=false для ВСЕХ (пользователь — наблюдатель
      // публичного видео, не участник), personId никогда не
      // проставляется автоматически — сопоставление с Person остаётся
      // ручным действием пользователя (§6.2 п.1).
      const labels = [...new Set(parsed.segments.map((s) => s.speakerLabel))];
      const participantByLabel = new Map<string, string>();
      for (const label of labels) {
        const participant = await tx.conversationParticipant.upsert({
          where: { conversationId_diarizationLabel: { conversationId, diarizationLabel: label } },
          update: {},
          create: { conversationId, diarizationLabel: label },
        });
        participantByLabel.set(label, participant.id);
      }

      // 2. Транскрипт (один на разговор).
      const transcript = await tx.transcript.upsert({
        where: { conversationId },
        update: { language: parsed.language },
        create: { conversationId, language: parsed.language },
      });

      // 3. Сегменты. Повторный персистенс (ретрай обработчика) не
      // должен удваивать — сносим и пишем заново, как в вебхуке
      // AssemblyAI. confidence = null: модель не даёт пословной
      // уверенности, выдумывать её нельзя.
      await tx.conversationSignal.deleteMany({
        where: { transcriptSegment: { transcriptId: transcript.id } },
      });
      await tx.transcriptSegment.deleteMany({ where: { transcriptId: transcript.id } });

      for (const seg of parsed.segments) {
        const segment = await tx.transcriptSegment.create({
          data: {
            transcriptId: transcript.id,
            participantId: participantByLabel.get(seg.speakerLabel) ?? null,
            text: seg.text,
            startMs: seg.startMs,
            endMs: seg.endMs,
            confidence: null,
          },
        });

        // 4. Сигналы — с transcriptSegmentId И participantId. Сигнал
        // без сегмента не создаётся вовсе: он был бы невидим для
        // getSummary() и UI разбора (§6.2 п.4).
        for (const sig of seg.signals) {
          const signal = await tx.conversationSignal.create({
            data: {
              signalType: sig.type,
              transcriptSegmentId: segment.id,
              participantId: participantByLabel.get(seg.speakerLabel) ?? null,
              confidence: sig.confidence ?? null,
              paralinguisticChannel:
                sig.type === ConversationSignalType.DELIVERY_INCONGRUENCE ? (sig.channel ?? null) : null,
            },
          });
          await tx.conversationSignalEvidence.create({
            data: { conversationSignalId: signal.id, aiInferenceId },
          });
        }
      }

      await tx.conversation.update({
        where: { id: conversationId },
        data: { status: ConversationProcessingStatus.ANALYZED },
      });
      await tx.mediaReviewQueueItem.update({
        where: { id: itemId },
        data: { status: MediaReviewItemStatus.DONE, autoAnalysisError: null },
      });
    });
  }
}

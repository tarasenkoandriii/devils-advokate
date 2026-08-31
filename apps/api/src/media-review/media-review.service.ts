// Пункт [media-review] (devils-advocate-media-review-tz.md §4/§5):
// MediaReviewService — управление MediaReviewQueue/MediaReviewQueueItem.
// НЕ завантажує жодного відео/аудіо контенту (§2.2 ТЗ) — тільки
// метадані з YouTubeSearchService і зв'язок з Conversation, яку
// користувач завантажує сам через уже наявний UPLOADED_VIDEO флоу.

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationProcessingStatus, MediaReviewItemStatus } from '@prisma/client';
import { MediaReviewAutoService } from './media-review-auto.service';

export interface CreateQueueItemInput {
  youtubeVideoId: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  durationSeconds?: number;
  publishedAt?: string;
}

// Conversation.status — детальніший конвеєр (UPLOADED→TRANSCRIBING→
// TRANSCRIBED→ANALYZING→ANALYZED→FAILED), ніж чотиристановий
// MediaReviewItemStatus з ТЗ. Мапінг навмисно спрощує: усе між
// "файл є" і "аналіз готовий" — PROCESSING, FAILED теж лишається
// PROCESSING (ТЗ не визначає окремий стан помилки для черги —
// чесна спрощена відповідність, не прихована втрата інформації:
// реальний статус завжди можна побачити через саму Conversation).
function mapConversationStatusToItemStatus(status: ConversationProcessingStatus): 'PROCESSING' | 'DONE' {
  return status === ConversationProcessingStatus.ANALYZED ? 'DONE' : 'PROCESSING';
}

@Injectable()
export class MediaReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auto: MediaReviewAutoService,
  ) {}

  private async assertOwnedQueue(userId: string, queueId: string) {
    const queue = await this.prisma.mediaReviewQueue.findUnique({ where: { id: queueId } });
    if (!queue || queue.userId !== userId) {
      throw new NotFoundException(`MediaReviewQueue ${queueId} not found`);
    }
    return queue;
  }

  /** Фаза C ТЗ domain-ui — списка очередей не было (create-only API). */
  async listQueues(userId: string) {
    return this.prisma.mediaReviewQueue.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { items: true } } },
    });
  }

  async createQueue(userId: string, title: string) {
    // Пункт [multimodal] §6.1.1 — очередь создаётся ВМЕСТЕ с
    // проектом-контейнером: Conversation без projectId невозможен, а
    // при автоматическом разборе Conversation создаём мы. Один проект
    // на очередь, не на ролик. ProjectMode — STANDARD (дефолт), новый
    // режим не заводится — решение ТЗ, зафиксированное явно.
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: { ownerId: userId, question: title },
      });
      return tx.mediaReviewQueue.create({ data: { userId, title, projectId: project.id } });
    });
  }

  async addItem(userId: string, queueId: string, input: CreateQueueItemInput) {
    await this.assertOwnedQueue(userId, queueId);

    const maxOrder = await this.prisma.mediaReviewQueueItem.aggregate({
      where: { queueId },
      _max: { orderIndex: true },
    });
    const orderIndex = (maxOrder._max.orderIndex ?? -1) + 1;

    const item = await this.prisma.mediaReviewQueueItem.create({
      data: {
        queueId,
        youtubeVideoId: input.youtubeVideoId,
        title: input.title,
        channelName: input.channelName,
        thumbnailUrl: input.thumbnailUrl,
        durationSeconds: input.durationSeconds,
        publishedAt: input.publishedAt ? new Date(input.publishedAt) : undefined,
        orderIndex,
      },
    });

    // Пункт [multimodal] §6.1 — автоматический разбор запускается СРАЗУ
    // при добавлении: ни одного действия пользователя между «выбрал
    // ролик» и «смотрю разбор». Отказ автоматики (длительность,
    // согласия, квота) НЕ роняет добавление — элемент остаётся в
    // AWAITING_UPLOAD с причиной, ручной путь §2.2 доступен как раньше.
    const queue = await this.prisma.mediaReviewQueue.findUniqueOrThrow({ where: { id: queueId } });
    await this.auto.tryEnqueueAnalysis(userId, queue, item);

    return this.prisma.mediaReviewQueueItem.findUniqueOrThrow({ where: { id: item.id } });
  }

  /** §2.2 ТЗ: файл завантажується користувачем самостійно через уже
   * наявний UPLOADED_VIDEO флоу — тут тільки зв'язок вже існуючої
   * Conversation з елементом черги, ніякого прийому файлу. */
  async linkConversation(userId: string, itemId: string, conversationId: string) {
    const item = await this.prisma.mediaReviewQueueItem.findUnique({
      where: { id: itemId },
      include: { queue: true },
    });
    if (!item || item.queue.userId !== userId) {
      throw new NotFoundException(`MediaReviewQueueItem ${itemId} not found`);
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { project: true },
    });
    if (!conversation || conversation.project.ownerId !== userId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    return this.prisma.mediaReviewQueueItem.update({
      where: { id: itemId },
      data: { conversationId, status: 'READY' },
    });
  }

  /** Знімок черги з живою синхронізацією статусу READY/PROCESSING/DONE
   * проти реального Conversation.status — не окремий webhook/подія на
   * кожну зміну статусу транскрибації, просто читається на кожен GET
   * (§4 ТЗ не вимагає realtime-пушів, тільки коректний статус при
   * перегляді). */
  async getQueue(userId: string, queueId: string) {
    const queue = await this.assertOwnedQueue(userId, queueId);

    const items = await this.prisma.mediaReviewQueueItem.findMany({
      where: { queueId },
      include: { conversation: { select: { status: true, projectId: true } } }, // projectId — для ссылки «открыть разбор» в TMA
      orderBy: { orderIndex: 'asc' },
    });

    const syncedItems = await Promise.all(
      items.map(async (item) => {
        // READY и PROCESSING — оба «живые» статусы: READY→PROCESSING на первом
        // GET после привязки, PROCESSING→DONE — когда Conversation.status стал
        // ANALYZED. Раньше синхронизировался только READY, и элемент навсегда
        // застревал в PROCESSING (найдено аудитом, покрыто тестом).
        if ((item.status === 'READY' || item.status === 'PROCESSING') && item.conversation) {
          // Пункт [multimodal] §6.4 [R2] — ветка FAILED. Общий маппинг
          // ниже сводит FAILED в PROCESSING (осознанное упрощение
          // ручного флоу), но для автоматического разбора это вернуло
          // бы тот самый «елемент назавжди застряг у PROCESSING», уже
          // однажды найденный аудитом: если воркер упал между
          // AIJob→FAILED и откатом элемента, каждый следующий GET
          // оставлял бы его в PROCESSING. Поэтому FAILED здесь — явный
          // откат в AWAITING_UPLOAD с причиной, ручной путь доступен.
          if (item.conversation.status === ConversationProcessingStatus.FAILED) {
            return this.prisma.mediaReviewQueueItem.update({
              where: { id: item.id },
              data: {
                status: MediaReviewItemStatus.AWAITING_UPLOAD,
                autoAnalysisError:
                  item.autoAnalysisError ??
                  'Разбор завершился ошибкой — можно загрузить файл вручную либо повторить попытку',
              },
            });
          }
          const mapped = mapConversationStatusToItemStatus(item.conversation.status);
          if (mapped !== item.status) {
            return this.prisma.mediaReviewQueueItem.update({ where: { id: item.id }, data: { status: mapped } });
          }
        }
        return item;
      }),
    );

    return { ...queue, items: syncedItems };
  }

  /** §2.3 ТЗ, п.5 — "підсумкова зведена картка": агрегація вже
   * наявних ConversationSignal по всіх розмовах черги, не нова
   * модель метрик. */
  async getSummary(userId: string, queueId: string) {
    await this.assertOwnedQueue(userId, queueId);

    const items = await this.prisma.mediaReviewQueueItem.findMany({
      where: { queueId, conversationId: { not: null } },
      select: { conversationId: true, status: true },
    });

    const conversationIds = items.map((i) => i.conversationId).filter((id): id is string => id != null);
    const doneCount = items.filter((i) => i.status === 'DONE').length;

    if (conversationIds.length === 0) {
      return { totalItems: 0, doneItems: 0, manipulationSignals: 0, discrepancySignals: 0 };
    }

    const segmentIds = (
      await this.prisma.transcriptSegment.findMany({
        where: { transcript: { conversationId: { in: conversationIds } } },
        select: { id: true },
      })
    ).map((s) => s.id);

    const [manipulationSignals, discrepancySignals] = await Promise.all([
      this.prisma.conversationSignal.count({
        where: { signalType: 'MANIPULATION_PATTERN', transcriptSegmentId: { in: segmentIds } },
      }),
      this.prisma.conversationSignal.count({
        where: { signalType: 'FACTUAL_DISCREPANCY', transcriptSegmentId: { in: segmentIds } },
      }),
    ]);

    return {
      totalItems: items.length,
      doneItems: doneCount,
      manipulationSignals,
      discrepancySignals,
    };
  }
}

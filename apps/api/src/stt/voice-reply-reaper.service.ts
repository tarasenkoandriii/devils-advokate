// Аудит 2026-09-02 (продолжение) — сторожевая для голосовых реплик.
//
// НАЙДЕНО при введении состояния PROCESSING: у SparringVoiceReplyJob и
// MaterialChatVoiceReplyJob не было НИКАКОЙ сторожевой. Джоба, чей
// вебхук так и не пришёл (провайдер не доставил, задача у него упала без
// вебхука, секрет сменили посреди полёта), оставалась PENDING навсегда;
// джоба, чей обработчик умер посреди ответа оппонента (таймаут функции,
// падение инстанса), теперь оставалась бы PROCESSING навсегда. В обоих
// случаях клиент опрашивал статус бесконечно, а пользователь смотрел на
// «…» без объяснения.
//
// Здесь — тот же принцип, что у AIRouterService.reapExpired: протухшее →
// FAILED с честной причиной, а не тихое «висит». Вызывается из того же
// тика POST /internal/ai-jobs/reap (pg_cron) — ещё один секрет в ещё одном
// SQL-файле ничего бы не добавил.
//
// Пороги. PENDING: 30 минут — короткая реплика распознаётся за секунды,
// вебхук провайдера ретраится минутами; полчаса без него — это отказ, а
// не задержка. PROCESSING: 5 минут — обработчик живёт в одной функции с
// maxDuration 60 с; через пять минут его точно нет.
//
// Восстановления результата здесь нет намеренно: попробовать ещё раз
// забрать транскрипт и доиграть ответ — это повторить весь обработчик
// вебхука из сторожевой, с теми же гонками, ради редкого случая. Честная
// ошибка и кнопка «повторить» у пользователя дешевле и понятнее.
import { Injectable, Logger } from '@nestjs/common';
import { SparringVoiceReplyStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isUnknownEnumValueError, warnEnumMigrationLagOnce } from '../common/enum-migration-lag';

export const VOICE_REPLY_PENDING_MAX_AGE_MS = 30 * 60 * 1000;
export const VOICE_REPLY_PROCESSING_MAX_AGE_MS = 5 * 60 * 1000;

const PENDING_REASON =
  'распознавание не завершилось: результат от провайдера так и не пришёл — повторите запись';
const PROCESSING_REASON =
  'ответ не был сформирован: обработка прервалась после распознавания — повторите запись';

@Injectable()
export class VoiceReplyReaperService {
  private readonly logger = new Logger(VoiceReplyReaperService.name);

  constructor(private readonly prisma: PrismaService) {}

  async reapStale(now = new Date()): Promise<{ voiceRepliesReaped: number }> {
    const pendingBefore = new Date(now.getTime() - VOICE_REPLY_PENDING_MAX_AGE_MS);
    const processingBefore = new Date(now.getTime() - VOICE_REPLY_PROCESSING_MAX_AGE_MS);

    // updatedAt, не createdAt: переход PENDING → PROCESSING обновляет
    // строку, и отсчёт пяти минут идёт от момента забора. Две модели с
    // одинаковой формой where/data — Prisma типизирует их раздельно,
    // поэтому аргументы собраны один раз, а вызовы явные.
    const pendingArgs = {
      where: { status: SparringVoiceReplyStatus.PENDING, updatedAt: { lt: pendingBefore } },
      data: { status: SparringVoiceReplyStatus.FAILED, errorMessage: PENDING_REASON },
    };
    const processingArgs = {
      where: { status: SparringVoiceReplyStatus.PROCESSING, updatedAt: { lt: processingBefore } },
      data: { status: SparringVoiceReplyStatus.FAILED, errorMessage: PROCESSING_REASON },
    };
    // Ветка PROCESSING отдельно: до применения миграции перечисления
    // запрос с этим значением падает в Postgres (22P02). Тогда PENDING
    // всё равно чистим, PROCESSING пропускаем с предупреждением — сторожевая
    // не должна ломаться целиком из-за отставания миграции.
    const pending = await Promise.all([
      this.prisma.sparringVoiceReplyJob.updateMany(pendingArgs),
      this.prisma.materialChatVoiceReplyJob.updateMany(pendingArgs),
    ]);
    let processingCount = 0;
    try {
      const processing = await Promise.all([
        this.prisma.sparringVoiceReplyJob.updateMany(processingArgs),
        this.prisma.materialChatVoiceReplyJob.updateMany(processingArgs),
      ]);
      processingCount = processing.reduce((sum, r) => sum + r.count, 0);
    } catch (err) {
      if (!isUnknownEnumValueError(err)) throw err;
      warnEnumMigrationLagOnce(this.logger, 'VoiceReplyReaperService');
    }
    const total = pending.reduce((sum, r) => sum + r.count, 0) + processingCount;

    if (total > 0) {
      this.logger.warn(`Сторожевая голосовых реплик: ${total} джоб переведено в FAILED по истечении срока`);
    }
    return { voiceRepliesReaped: total };
  }
}

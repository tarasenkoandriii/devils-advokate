// Пункт 23: ArgumentLifecycleService (§3.58 ТЗ) — десятая из 11 фич
// MVP v2, реальное завершение уже существующей с чекпоинта 1 фичи.
//
// Найденный пробел до начала реализации — см. подробное обоснование в
// schema.prisma над моделью ArgumentLifecycleEvent:
// Argument.lifecycleStatus существовал, но ни один сервис не давал
// возможности его изменить, а "выводы вида «этот аргумент уже трижды
// не сработал»" физически невозможны без истории переходов, не
// только текущего снимка статуса.
//
// НЕ навязывается строгая последовательность переходов (draft→tested→
// used→...). ТЗ описывает цепочку как ТИПИЧНЫЙ путь аргумента, не как
// жёсткий конечный автомат с запрещёнными переходами — аргумент может
// быть USED, потом REJECTED, а затем в следующем разговоре снова USED
// (тот же аргумент могут попробовать повторно с изменённой
// формулировкой ситуации) — если бы переходы были линейно
// заблокированы, "трижды не сработал" было бы физически недостижимо
// (после первого REJECTED второй раз попасть в REJECTED уже было бы
// нельзя). Валидируется только что toStatus — валидное значение enum
// (гарантируется TypeScript) и что аргумент принадлежит пользователю.

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ArgumentLifecycleStatus } from '@prisma/client';

const FAILURE_STATUSES: ArgumentLifecycleStatus[] = [
  ArgumentLifecycleStatus.REJECTED,
  ArgumentLifecycleStatus.COUNTERED,
];
const FAILURE_INSIGHT_THRESHOLD = 3; // §3.58 ТЗ, буквальный пример — "уже трижды не сработал"

export interface ArgumentFailureInsight {
  failureCount: number;
  insight: string | null; // null, если ещё не достигнут порог — не показываем "0 раз не сработал" как псевдо-инсайт
}

@Injectable()
export class ArgumentLifecycleService {
  constructor(private readonly prisma: PrismaService) {}

  async transition(
    userId: string,
    argumentId: string,
    toStatus: ArgumentLifecycleStatus,
    input?: { conversationId?: string; note?: string },
  ) {
    const argument = await this.findOwnedArgument(userId, argumentId);

    await this.prisma.argumentLifecycleEvent.create({
      data: {
        argumentId,
        fromStatus: argument.lifecycleStatus,
        toStatus,
        conversationId: input?.conversationId,
        note: input?.note,
      },
    });

    return this.prisma.argument.update({
      where: { id: argumentId },
      data: { lifecycleStatus: toStatus },
    });
  }

  async getHistory(userId: string, argumentId: string) {
    await this.findOwnedArgument(userId, argumentId);
    return this.prisma.argumentLifecycleEvent.findMany({
      where: { argumentId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** "Этот аргумент уже трижды не сработал" — §3.58 ТЗ буквально.
   * REJECTED и COUNTERED оба считаются "не сработал" (аргумент либо
   * прямо отвергнут, либо был опровергнут собеседником) — ACCEPTED и
   * VERIFIED явно исключены (это успех, не провал), EXPIRED не
   * считается ни успехом, ни провалом (аргумент просто устарел, не
   * был отвергнут по содержанию). */
  async getFailureInsight(userId: string, argumentId: string): Promise<ArgumentFailureInsight> {
    await this.findOwnedArgument(userId, argumentId);

    const failureCount = await this.prisma.argumentLifecycleEvent.count({
      where: { argumentId, toStatus: { in: FAILURE_STATUSES } },
    });

    return {
      failureCount,
      insight:
        failureCount >= FAILURE_INSIGHT_THRESHOLD
          ? `Этот аргумент уже ${failureCount} раз не сработал — возможно, стоит пересмотреть формулировку или отказаться от него.`
          : null,
    };
  }

  private async findOwnedArgument(userId: string, argumentId: string) {
    const argument = await this.prisma.argument.findUnique({
      where: { id: argumentId },
      include: { project: true },
    });
    if (!argument || argument.project.ownerId !== userId) {
      throw new NotFoundException(`Argument ${argumentId} not found`);
    }
    return argument;
  }
}

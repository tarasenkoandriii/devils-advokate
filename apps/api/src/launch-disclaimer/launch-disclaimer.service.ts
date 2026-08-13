// MVP-фича 13 (§3.36 ТЗ, "слово тоже оружие") — обязательный экран при
// первом запуске приложения. Единственная задача этого сервиса —
// хранить и проверять факт подтверждения, сам текст дисклеймера живёт
// на фронтенде (TMA), не в БД.
//
// Простейшая из 13 фич MVP не потому что не важна, а потому что вся
// нужная инфраструктура (User, TelegramAuthGuard/bootstrap) существует
// с чекпоинта 1 — здесь только одно новое поле и минимальная логика
// сравнения версий.

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Версия текста дисклеймера. Поднимать при существенном изменении
 * текста — старое acknowledgedAt перестаёт засчитываться, экран
 * показывается повторно (§3.36 ТЗ: "можно повторно показать при
 * значимых обновлениях функциональности"). НЕ поднимать за опечатки —
 * иначе все пользователи будут видеть экран заново без реальной причины. */
export const CURRENT_DISCLAIMER_VERSION = 'v1';

export interface DisclaimerStatus {
  acknowledged: boolean;
  currentVersion: string;
  acknowledgedVersion: string | null;
}

// Пункт 34 (реальное исправление находки аудита, Пункт 33) — раньше
// BootstrapController дублировал ровно эту логику инлайн, не
// переиспользуя её отсюда: два места, которые пришлось бы синхронно
// менять при изменении правила. Вынесена в отдельную экспортируемую
// функцию (не метод класса) — принимает уже загруженного user, не
// дёргает БД сама, поэтому BootstrapController может её использовать
// без добавления LaunchDisclaimerService как новой DI-зависимости и
// без лишнего запроса поверх уже загруженного им user. Тот же паттерн,
// что уже применялся к buildUserPrompt() в argument-generation.service.ts
// — переиспользуемая чистая функция экспортирована из сервиса, не
// продублирована в вызывающем коде.
export function computeDisclaimerStatus(user: {
  launchDisclaimerAcknowledgedAt: Date | null;
  launchDisclaimerVersion: string | null;
}): DisclaimerStatus {
  const acknowledged =
    user.launchDisclaimerAcknowledgedAt !== null &&
    user.launchDisclaimerVersion === CURRENT_DISCLAIMER_VERSION;

  return {
    acknowledged,
    currentVersion: CURRENT_DISCLAIMER_VERSION,
    acknowledgedVersion: user.launchDisclaimerVersion,
  };
}

@Injectable()
export class LaunchDisclaimerService {
  constructor(private readonly prisma: PrismaService) {}

  async getStatus(userId: string): Promise<DisclaimerStatus> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return computeDisclaimerStatus(user);
  }

  async acknowledge(userId: string): Promise<DisclaimerStatus> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        launchDisclaimerAcknowledgedAt: new Date(),
        launchDisclaimerVersion: CURRENT_DISCLAIMER_VERSION,
      },
    });
    return computeDisclaimerStatus(user);
  }
}

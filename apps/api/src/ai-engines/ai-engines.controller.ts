// Закрывает разрыв между бэкендом и UI: AIRouterService уже умеет
// принимать preferredModelVersionId (§3.15 ТЗ, "выбор AI-движка"), но
// до этого прохода не было способа узнать СПИСОК доступных движков
// извне — фронтенду неоткуда взять id для селектора. Один простой
// read-only эндпоинт, не отдельный модуль конфигурации.

import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../secrets/secrets.service';
import { providerSupportsLane } from '../ai-router/ai-provider-client';
import { providerHasUsableKey } from '../common/provider-key';

export interface AvailableEngine {
  modelVersionId: string;
  providerName: string;
  modelName: string;
  version: string;
  latencyClass: string | null;
  costClass: string | null;
}

@Controller('ai-engines')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class AIEnginesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
  ) {}

  // Пункт [router-simplify] 2026-09-01: capability больше не заводится
  // на пару (модель × задача) — одна строка на модель. Параметр
  // taskType в запросе поэтому ничего не фильтрует; он оставлен, чтобы
  // не ломать вызовы фронтенда, и явно помечен как игнорируемый.
  @Get()
  async list(@Query('taskType') _taskType?: string): Promise<AvailableEngine[]> {
    const capabilities = await this.prisma.aIModelCapability.findMany({
      where: { availability: 'active' },
      include: { modelVersion: { include: { model: { include: { provider: true } } } } },
      orderBy: { createdAt: 'asc' },
    });

    // АУДИТ 2026-09-02: список отдавался как есть, без проверки, что
    // выбранным движком вообще можно воспользоваться. Пользователь
    // выбирал в селекторе модель без ключа — или Gemini, который
    // обслуживает только фоновую полосу, — и получал «AI-провайдер
    // недоступен» на каждой фиче. Селектор не должен предлагать то,
    // что заведомо не сработает: те же два условия, что в подборе
    // роутера (полоса + наличие ключа).
    const usable: AvailableEngine[] = [];
    for (const cap of capabilities) {
      const provider = cap.modelVersion.model.provider;
      if (!providerSupportsLane(provider.name, 'sync')) continue;
      if (!(await this.hasUsableKey(provider))) continue;
      usable.push({
        modelVersionId: cap.modelVersion.id,
        providerName: provider.name,
        modelName: cap.modelVersion.model.name,
        version: cap.modelVersion.version,
        latencyClass: cap.latencyClass,
        costClass: cap.costClass,
      });
    }
    return usable;
  }

  /** Тот же критерий, что у роутера — буквально та же функция. */
  private hasUsableKey(provider: { apiEndpoint: string | null; credentialRef: string | null }): Promise<boolean> {
    return providerHasUsableKey(this.secrets, provider);
  }
}

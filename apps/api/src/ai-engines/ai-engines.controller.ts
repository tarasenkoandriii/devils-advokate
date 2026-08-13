// Закрывает разрыв между бэкендом и UI: AIRouterService уже умеет
// принимать preferredModelVersionId (§3.15 ТЗ, "выбор AI-движка"), но
// до этого прохода не было способа узнать СПИСОК доступных движков
// извне — фронтенду неоткуда взять id для селектора. Один простой
// read-only эндпоинт, не отдельный модуль конфигурации.

import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PrismaService } from '../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query('taskType') taskType = 'argument-generation'): Promise<AvailableEngine[]> {
    const capabilities = await this.prisma.aIModelCapability.findMany({
      where: { taskType, availability: 'active' },
      include: { modelVersion: { include: { model: { include: { provider: true } } } } },
    });

    return capabilities.map((cap) => ({
      modelVersionId: cap.modelVersion.id,
      providerName: cap.modelVersion.model.provider.name,
      modelName: cap.modelVersion.model.name,
      version: cap.modelVersion.version,
      latencyClass: cap.latencyClass,
      costClass: cap.costClass,
    }));
  }
}

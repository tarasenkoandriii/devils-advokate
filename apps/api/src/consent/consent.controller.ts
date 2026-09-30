// Обнаружено при переходе к "реальной интеграции": ConsentService
// (закрывающий TODO в AIRouterService) не имел ни одного HTTP-входа.
// Без этого контроллера AIRouterService.execute() гарантированно
// бросает ForbiddenException при первом реальном вызове из TMA — нет
// способа выдать согласие снаружи. Закрывается здесь, не откладывается
// до полноценного Privacy Center (фича 11) — минимальный набор
// эндпоинтов, которого достаточно для работы фичи 1 end-to-end.

import { Body, Controller, Delete, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import { CurrentUser } from '../telegram-auth/current-user.decorator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { ConsentService } from './consent.service';
import { ConsentType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

class GrantConsentDto {
  consentType!: ConsentType;
  version!: string;
  source!: string;
  purposes?: string[];
  projectId?: string;
}

// Текущая версия текста согласия на использование внешнего AI —
// показывается пользователю на фронтенде перед первым вызовом (§3.36
// ТЗ — принцип "слово тоже оружие", то же самое применимо и здесь:
// пользователь должен явно понимать, что данные уходят внешнему
// провайдеру, не только один раз нажать кнопку не глядя).
//
// Пункт [written-for-the-person-never-delivered] 2026-09-30: этот
// реестр был написан РАДИ ЧЕЛОВЕКА — и не отдавался ни одним
// маршрутом, ни один клиент его не читал. Версию текста согласия TMA
// держала своей копией: `CURRENT_EXTERNAL_AI_CONSENT_VERSION = 'v1'` в
// `lib/features.ts`. Две копии одного значения, из которых серверная
// была единственной «настоящей» и при этом недостижимой: правка здесь
// разошлась бы с тем, что клиент записывает в `ConsentRecord.version`,
// МОЛЧА — и продукт начал бы хранить согласие на текст, которого
// человек не видел. Теперь реестр уезжает маршрутом ниже, а копии на
// клиенте нет.
export const CURRENT_CONSENT_VERSIONS: Record<string, string> = {
  EXTERNAL_AI: 'v1',
};

@Controller('consent')
@UseGuards(TelegramAuthGuard)
@UseInterceptors(ApiResponseInterceptor)
export class ConsentController {
  constructor(
    private readonly consent: ConsentService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(@CurrentUser() userId: string) {
    const records = await this.prisma.consentRecord.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return records;
  }

  /** Версии текстов согласия — те, что клиент обязан записать вместе
   * с согласием. Отдаётся отдельным маршрутом, а не внутри списка
   * согласий: список читают после входа, а версия нужна ДО первого
   * согласия, когда списка ещё нет. */
  @Get('versions')
  async versions() {
    return { versions: { ...CURRENT_CONSENT_VERSIONS } };
  }

  @Post('grant')
  async grant(@CurrentUser() userId: string, @Body() dto: GrantConsentDto) {
    return this.consent.grant({
      userId,
      consentType: dto.consentType,
      version: dto.version,
      source: dto.source,
      purposes: dto.purposes,
      projectId: dto.projectId,
    });
  }

  /** Пункт [consent-revocation] 2026-09-04: возвращалось `{ revoked: true }`
   * независимо от того, было ли что отзывать и что при этом произошло.
   * Теперь — отчёт: сколько записей отозвано, что сделано СВЕРХ пометки
   * (закрыты публичные ссылки, удалён голосовой отпечаток) и чего отзыв
   * НЕ отменяет. Последнее важнее прочего: «только на будущее» —
   * законный ответ, но человек должен услышать его словами, а не
   * додумать. */
  @Delete(':type')
  async revoke(@CurrentUser() userId: string, @Param('type') type: ConsentType) {
    return this.consent.revoke(userId, type);
  }
}

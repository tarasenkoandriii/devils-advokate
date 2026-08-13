// ConsentService — первая реализация сервисного слоя поверх
// ConsentRecord (чекпоинт 1, пункт 8). Закрывает TODO, оставленный в
// AIRouterService: "проверить ConsentRecord(consentType=EXTERNAL_AI)
// перед вызовом внешнего провайдера".
//
// Namespace выбора: считаем согласие активным, если granted=true И
// revokedAt=null. version не участвует в проверке "активно ли" —
// она нужна только чтобы понимать, под какой редакцией политики
// пользователь согласился (для юридического аудита), не для решения
// "пускать ли сейчас".

import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConsentType } from '@prisma/client';

export interface GrantConsentInput {
  userId: string;
  consentType: ConsentType;
  version: string;
  source: string;
  purposes?: string[];
  projectId?: string;
}

@Injectable()
export class ConsentService {
  constructor(private readonly prisma: PrismaService) {}

  async hasActiveConsent(
    userId: string,
    consentType: ConsentType,
    projectId?: string,
  ): Promise<boolean> {
    const record = await this.prisma.consentRecord.findFirst({
      where: {
        userId,
        consentType,
        granted: true,
        revokedAt: null,
        // Глобальное согласие (projectId=null) действует для любого
        // проекта; согласие, привязанное к конкретному projectId,
        // действует только для него — поэтому ищем оба варианта.
        OR: [{ projectId: null }, { projectId: projectId ?? undefined }],
      },
      orderBy: { createdAt: 'desc' },
    });
    return record !== null;
  }

  /** Бросает ForbiddenException, если согласие не дано — используется
   * в местах, где отсутствие согласия должно останавливать операцию
   * (например AIRouterService перед вызовом внешнего провайдера),
   * а не просто молча пропускать шаг. */
  async requireConsent(
    userId: string,
    consentType: ConsentType,
    projectId?: string,
  ): Promise<void> {
    const has = await this.hasActiveConsent(userId, consentType, projectId);
    if (!has) {
      throw new ForbiddenException(
        `Consent required: ${consentType} (userId=${userId}${projectId ? `, projectId=${projectId}` : ''})`,
      );
    }
  }

  async grant(input: GrantConsentInput) {
    return this.prisma.consentRecord.create({
      data: {
        userId: input.userId,
        consentType: input.consentType,
        version: input.version,
        source: input.source,
        purposes: input.purposes ?? [],
        projectId: input.projectId,
        granted: true,
        grantedAt: new Date(),
      },
    });
  }

  /** Отзыв — не удаляет запись (юридический след важнее), только
   * помечает revokedAt. Если consentType=LOCATION, это отзывает ВСЕ
   * purposes разом (§3.32 ТЗ) — потому что purposes хранятся на одной
   * записи, а не на трёх отдельных (см. Prisma-README, пункт 8,
   * инвариант 24). */
  async revoke(userId: string, consentType: ConsentType, projectId?: string): Promise<void> {
    await this.prisma.consentRecord.updateMany({
      where: {
        userId,
        consentType,
        revokedAt: null,
        OR: [{ projectId: null }, { projectId: projectId ?? undefined }],
      },
      data: { revokedAt: new Date(), granted: false },
    });
  }
}

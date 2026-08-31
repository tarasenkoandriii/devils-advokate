// Пункт [health-budget] — той самий шаблон, що DtpV2Service/
// FamilyLawV2Service (§3.4 обох companion-ТЗ), звужений до бюджету —
// health не має учасників/статусу процесу, не запитано.
//
// Уроки, застосовані ОДРАЗУ з першого проходу (не через окремий
// аудит-прохід постфактум, як довелось для базового DTP/health):
// валідація category/direction проти enum перед записом (знайдено й
// виправлено двічі — спершу mediaType у ДТП, потім category/direction/
// source у DTP v2/family-law v2), порядок перевірок — дешеве спершу.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { sumMoney } from '../common/money';
import { HealthBudgetCategory, HealthBudgetDirection } from '@prisma/client';
import { assertOwnedHealthProject } from './health-access';

@Injectable()
export class HealthV2Service {
  constructor(private readonly prisma: PrismaService) {}

  async createBudgetLineItem(
    userId: string,
    configId: string,
    category: string,
    direction: string,
    amount: number,
    currency?: string,
    description?: string,
    consultationId?: string,
  ) {
    await this.assertOwnedConfig(userId, configId);

    if (!Object.values(HealthBudgetCategory).includes(category as any)) {
      throw new BadRequestException(`Unknown category: ${category}`);
    }
    if (!Object.values(HealthBudgetDirection).includes(direction as any)) {
      throw new BadRequestException(`Unknown direction: ${direction}`);
    }
    if (amount < 0) {
      throw new BadRequestException('amount не может быть отрицательным');
    }
    if (consultationId) {
      const consultation = await this.prisma.healthConsultation.findUnique({
        where: { id: consultationId },
        include: { provider: true },
      });
      if (!consultation || consultation.provider.configId !== configId) {
        throw new NotFoundException(`HealthConsultation ${consultationId} not found`);
      }
    }

    return this.prisma.healthBudgetLineItem.create({
      data: { configId, category: category as any, direction: direction as any, amount, currency, description, consultationId },
    });
  }

  /** §3.4 ТЗ (за зразком DTP v2/family-law v2) — byCurrency:
   * групування, НЕ наївна сума. hasLegacyEstimatedCosts — видимість
   * ризику подвійного обліку з HealthConsultation.estimatedCost. */
  async getBudget(userId: string, configId: string) {
    const config = await this.assertOwnedConfig(userId, configId);

    const [lineItems, legacyConsultations] = await Promise.all([
      this.prisma.healthBudgetLineItem.findMany({ where: { configId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.healthConsultation.findMany({
        where: { provider: { configId }, estimatedCost: { not: null } },
        select: { id: true },
      }),
    ]);

    const byCurrencyMap = new Map<string, { totalExpense: number; totalCoverage: number }>();
    for (const item of lineItems) {
      const key = item.currency ?? 'UNSPECIFIED';
      const bucket = byCurrencyMap.get(key) ?? { totalExpense: 0, totalCoverage: 0 };
      if (item.direction === 'EXPENSE') bucket.totalExpense = sumMoney([bucket.totalExpense, item.amount]);
      else bucket.totalCoverage = sumMoney([bucket.totalCoverage, item.amount]);
      byCurrencyMap.set(key, bucket);
    }
    const byCurrency = [...byCurrencyMap.entries()].map(([currency, v]) => ({
      currency,
      totalExpense: v.totalExpense,
      totalCoverage: v.totalCoverage,
      netBudget: sumMoney([v.totalExpense, -v.totalCoverage]),
    }));

    return {
      lineItems,
      byCurrency,
      targetBudget: config.targetBudget,
      currency: config.currency,
      hasLegacyEstimatedCosts: legacyConsultations.length > 0,
    };
  }

  private async assertOwnedConfig(userId: string, configId: string) {
    const config = await this.prisma.healthConfig.findUnique({ where: { id: configId } });
    if (!config) {
      throw new NotFoundException(`HealthConfig ${configId} not found`);
    }
    await assertOwnedHealthProject(this.prisma, userId, config.projectId);
    return config;
  }
}

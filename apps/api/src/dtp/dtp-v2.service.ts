// Пункт [dtp-v2] (devils-advocate-dtp-v2-tz.md).
//
// НАЙВАЖЛИВІШІ ГАРАНТІЇ: DtpFaultDetermination заповнюється ВИКЛЮЧНО
// користувачем — жоден метод тут не викликає AIRouterService для
// запису статусу вини (§3.2 ТЗ). cross-consultation-check делегує
// повністю в доменно-агностичний CriteriaComparisonService (амендмент,
// devils-advocate-family-law-v2-tz.md §3.5) — тут немає власного
// AI-виклику для порівняння.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { sumMoney } from '../common/money';
import { CriteriaComparisonService, CrossConsultationCheckResult, NOT_DISCUSSED_PLACEHOLDER } from '../criteria-comparison/criteria-comparison.service';
import { DtpParticipantRole, DtpEvidenceAccessAction, DtpFaultSource, DtpBudgetCategory, DtpBudgetDirection } from '@prisma/client';
import { assertOwnedDtpProject } from './dtp-access';

const CROSS_CHECK_TASK_TYPE = 'dtp-cross-consultation-check';

@Injectable()
export class DtpV2Service {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: CriteriaComparisonService,
  ) {}

  // ── Учасники (§3.1 ТЗ) ──

  /** §3.1 ТЗ — не більше одного SELF на конфіг. Сервісна перевірка +
   * частковий унікальний індекс бази даних як останній рубіж проти
   * стану гонитви (§0 ТЗ, оптимізація). */
  async createParticipant(userId: string, configId: string, role: DtpParticipantRole, displayName?: string, hasFledScene?: boolean) {
    await this.assertOwnedConfig(userId, configId);

    if (!Object.values(DtpParticipantRole).includes(role)) {
      throw new BadRequestException(`Unknown role: ${role}`);
    }
    if (role === DtpParticipantRole.SELF) {
      const existing = await this.prisma.dtpParticipant.findFirst({ where: { configId, role: DtpParticipantRole.SELF } });
      if (existing) {
        throw new BadRequestException('У цього конфігу вже є учасник з role=SELF');
      }
    }

    try {
      return await this.prisma.dtpParticipant.create({
        data: { configId, role, displayName, hasFledScene: hasFledScene ?? false },
      });
    } catch (err: any) {
      // Частковий унікальний індекс бази даних (§3.1 ТЗ) — останній
      // рубіж на випадок паралельних запитів, що обидва пройшли
      // сервісну перевірку вище до створення запису.
      if (err?.code === 'P2010' || err?.code === 'P2002') {
        throw new BadRequestException('У цього конфігу вже є учасник з role=SELF');
      }
      throw err;
    }
  }

  async listParticipants(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    // include insurance — доменная вёрстка TMA показывает страховку в карточке участника одним запросом, не N+1
    return this.prisma.dtpParticipant.findMany({ where: { configId }, orderBy: { createdAt: 'asc' }, include: { insurance: true } });
  }

  // ── Страхування учасника (§3.3 ТЗ) — UPSERT, свідомий виняток із create-once ──

  async upsertParticipantInsurance(
    userId: string,
    participantId: string,
    hasInsurance: boolean,
    insurerName?: string,
    policyType?: string,
    coverageAmount?: number,
    currency?: string,
  ) {
    const participant = await this.assertOwnedParticipant(userId, participantId);
    if (coverageAmount !== undefined && coverageAmount < 0) {
      throw new BadRequestException('coverageAmount не может быть отрицательным');
    }
    return this.prisma.dtpParticipantInsurance.upsert({
      where: { participantId: participant.id },
      create: { participantId: participant.id, hasInsurance, insurerName, policyType, coverageAmount, currency },
      update: { hasInsurance, insurerName, policyType, coverageAmount, currency },
    });
  }

  async getParticipantInsurance(userId: string, participantId: string) {
    await this.assertOwnedParticipant(userId, participantId);
    const insurance = await this.prisma.dtpParticipantInsurance.findUnique({ where: { participantId } });
    if (!insurance) {
      throw new NotFoundException(`Insurance for participant ${participantId} not found`);
    }
    return insurance;
  }

  // ── Статус вини (§3.2 ТЗ) — виключно user-input, СПИСОК записів ──

  async createFaultDetermination(
    userId: string,
    configId: string,
    source: string,
    statusText: string,
    determinedAt: string,
    isOfficial?: boolean,
    referenceDocumentNumber?: string,
  ) {
    await this.assertOwnedConfig(userId, configId);
    if (!Object.values(DtpFaultSource).includes(source as any)) {
      throw new BadRequestException(`Unknown source: ${source}`);
    }
    if (!statusText.trim()) {
      throw new BadRequestException('statusText не может быть пустым');
    }
    return this.prisma.dtpFaultDetermination.create({
      data: {
        configId,
        source: source as any,
        statusText: statusText.trim(),
        determinedAt: new Date(determinedAt),
        isOfficial: isOfficial ?? false,
        referenceDocumentNumber,
      },
    });
  }

  async listFaultDeterminations(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    return this.prisma.dtpFaultDetermination.findMany({ where: { configId }, orderBy: { determinedAt: 'asc' } });
  }

  // ── Бюджет (§3.4 ТЗ) — структуровані статті, групування по валюті ──

  async createBudgetLineItem(
    userId: string,
    configId: string,
    category: string,
    direction: string,
    amount: number,
    currency?: string,
    description?: string,
    participantId?: string,
    consultationId?: string,
  ) {
    await this.assertOwnedConfig(userId, configId);
    if (!Object.values(DtpBudgetCategory).includes(category as any)) {
      throw new BadRequestException(`Unknown category: ${category}`);
    }
    if (!Object.values(DtpBudgetDirection).includes(direction as any)) {
      throw new BadRequestException(`Unknown direction: ${direction}`);
    }
    if (amount < 0) {
      throw new BadRequestException('amount не может быть отрицательным');
    }
    if (participantId) {
      const participant = await this.prisma.dtpParticipant.findUnique({ where: { id: participantId } });
      if (!participant || participant.configId !== configId) {
        throw new NotFoundException(`DtpParticipant ${participantId} not found`);
      }
    }
    if (consultationId) {
      const consultation = await this.prisma.dtpConsultation.findUnique({ where: { id: consultationId }, include: { advisor: true } });
      if (!consultation || consultation.advisor.configId !== configId) {
        throw new NotFoundException(`DtpConsultation ${consultationId} not found`);
      }
    }
    return this.prisma.dtpBudgetLineItem.create({
      data: { configId, category: category as any, direction: direction as any, amount, currency, description, participantId, consultationId },
    });
  }

  /** §3.4/§0 ТЗ — byCurrency: групування, НЕ наївна сума. Плюс
   * hasLegacyEstimatedCosts — видимість ризику подвійного обліку з
   * DtpConsultation.estimatedCost (оптимізація, §0 ТЗ). */
  async getBudget(userId: string, configId: string) {
    const config = await this.assertOwnedConfig(userId, configId);

    const [lineItems, legacyConsultations] = await Promise.all([
      this.prisma.dtpBudgetLineItem.findMany({ where: { configId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.dtpConsultation.findMany({
        where: { advisor: { configId }, estimatedCost: { not: null } },
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

  // ── Чернетка-компіляція ──

  async getSettlementProtocolDraft(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    const [participants, faultDeterminations, budget] = await Promise.all([
      this.prisma.dtpParticipant.findMany({ where: { configId }, include: { insurance: true } }),
      this.prisma.dtpFaultDetermination.findMany({ where: { configId }, orderBy: { determinedAt: 'desc' }, take: 1 }),
      this.getBudget(userId, configId),
    ]);

    const disclaimer =
      'Це чернетка-компіляція фактів, зафіксованих користувачем у продукті — НЕ юридично завершений документ, ' +
      'вимагає перегляду ліцензованим юристом перед використанням чи підписанням.';

    const latestFault = faultDeterminations[0];
    const lines: string[] = [
      `Учасники: ${participants.map((p: any) => `${p.role}${p.displayName ? ` (${p.displayName})` : ''}`).join(', ') || 'не зазначено'}`,
      latestFault
        ? `Статус вини: ${latestFault.statusText} (${latestFault.isOfficial ? 'офіційно підтверджено' : 'попередньо, не підтверджено документом'})`
        : 'Статус вини: не зафіксовано',
      `Бюджет: ${budget.byCurrency.map((b: any) => `${b.netBudget} ${b.currency}`).join(', ') || 'не зафіксовано'}`,
    ];

    return { text: [disclaimer, '', ...lines].join('\n'), generatedAt: new Date().toISOString(), disclaimer };
  }

  // ── Зіставлення слів між консультаціями (амендмент — спільний сервіс) ──

  async crossConsultationCheck(userId: string, criterionId: string): Promise<CrossConsultationCheckResult> {
    const criterion = await this.prisma.dtpCriterion.findUnique({ where: { id: criterionId }, include: { config: true } });
    if (!criterion) {
      throw new NotFoundException(`DtpCriterion ${criterionId} not found`);
    }
    await assertOwnedDtpProject(this.prisma, userId, criterion.config.projectId);

    const consultations = await this.prisma.dtpConsultation.findMany({
      where: { advisor: { configId: criterion.configId } },
      include: { advisor: true },
    });

    const statements = consultations
      .map((c: any) => {
        const breakdown = (c.criteriaBreakdown as any[]) ?? [];
        const entry = breakdown.find((b) => b.criterionId === criterionId);
        // АУДИТ: "не піднімалось у розмові" — це чесна деградація
        // generateBreakdown(), НЕ реальне джерело для порівняння.
        // Без цього фільтра консультація, де фахівець просто не
        // торкнувся теми, могла б викликати хибний DISCREPANCY_FOUND
        // проти консультації, де тему дійсно обговорили.
        if (!entry || !entry.whatWasSaid || entry.whatWasSaid.trim() === NOT_DISCUSSED_PLACEHOLDER) return null;
        return { consultationId: c.id, sourceLabel: c.advisor.label, whatWasSaid: entry.whatWasSaid, sourceSegmentId: entry.sourceSegmentId };
      })
      .filter((s: any): s is NonNullable<typeof s> => s !== null);

    return this.comparison.compare(userId, criterion.config.projectId, CROSS_CHECK_TASK_TYPE, statements);
  }

  async crossConsultationCheckAll(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    const criteria = await this.prisma.dtpCriterion.findMany({ where: { configId } });
    return Promise.all(
      criteria.map(async (c: any) => ({ criterionId: c.id, ...(await this.crossConsultationCheck(userId, c.id)) })),
    );
  }

  // ── Журнал цілісності доказів (§3.8 ТЗ) ──

  async logEvidenceAccess(userId: string, evidenceId: string, action: DtpEvidenceAccessAction) {
    await this.prisma.dtpEvidenceAccessLog.create({ data: { evidenceId, userId, action } });
  }

  async getEvidenceAccessLog(userId: string, evidenceId: string) {
    const evidence = await this.prisma.dtpEvidenceItem.findUnique({ where: { id: evidenceId }, include: { config: true } });
    if (!evidence) {
      throw new NotFoundException(`DtpEvidenceItem ${evidenceId} not found`);
    }
    await assertOwnedDtpProject(this.prisma, userId, evidence.config.projectId);
    return this.prisma.dtpEvidenceAccessLog.findMany({ where: { evidenceId }, orderBy: { occurredAt: 'asc' } });
  }

  // ── Приватні перевірки власності ──

  private async assertOwnedConfig(userId: string, configId: string) {
    const config = await this.prisma.dtpConfig.findUnique({ where: { id: configId } });
    if (!config) {
      throw new NotFoundException(`DtpConfig ${configId} not found`);
    }
    await assertOwnedDtpProject(this.prisma, userId, config.projectId);
    return config;
  }

  private async assertOwnedParticipant(userId: string, participantId: string) {
    const participant = await this.prisma.dtpParticipant.findUnique({ where: { id: participantId }, include: { config: true } });
    if (!participant) {
      throw new NotFoundException(`DtpParticipant ${participantId} not found`);
    }
    await assertOwnedDtpProject(this.prisma, userId, participant.config.projectId);
    return participant;
  }
}

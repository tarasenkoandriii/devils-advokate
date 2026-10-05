// Пункт [family-law-v2] (devils-advocate-family-law-v2-tz.md).
//
// НАЙВАЖЛИВІШІ ГАРАНТІЇ: FamilyLawStatusDetermination заповнюється
// ВИКЛЮЧНО користувачем — жоден метод тут не викликає AIRouterService
// для запису статусу процесу (§3.2 ТЗ). cross-consultation-check
// делегує повністю в спільний CriteriaComparisonService (§3.5 ТЗ) —
// той самий сервіс, що DtpV2Service, не паралельна копія.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FAMILY_ROLE_LABEL, labelFor } from '../common/document-labels';
import { PrismaService } from '../prisma/prisma.service';
import { budgetByCurrency, moneyWithCurrency, normalizeCurrency } from '../common/money';
import { CriteriaComparisonService, CrossConsultationCheckResult, NOT_DISCUSSED_PLACEHOLDER } from '../criteria-comparison/criteria-comparison.service';
import { FamilyLawPartyRole, FamilyLawStatusSource, FamilyLawBudgetCategory, FamilyLawBudgetDirection } from '@prisma/client';
import { assertOwnedFamilyLawProject } from './family-law-access';
import { withScopeLock } from '../common/ceiling-lock';

const CROSS_CHECK_TASK_TYPE = 'family-law-cross-consultation-check';

@Injectable()
export class FamilyLawV2Service {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: CriteriaComparisonService,
  ) {}

  // ── Сторони (§3.1 ТЗ) — той самий захист "лише один SELF", що ДТП v2 ──

  /** Пункт [the-first-row-was-whichever] 2026-10-05 — тот же мёртвый
   * `catch`, что в ДТП v2, и по той же причине: уникального ограничения
   * на `(configId, role=SELF)` в базе не было, значит `P2002` никто не
   * бросал. «Той самий захист, що ДТП v2» было правдой — защиты не было
   * ни там, ни тут.
   *
   * Цена дубля: `listParties` вернёт две «себя», а сводка разложит
   * имущество и бюджет человека по двум его собственным сторонам —
   * часть активов окажется не его. В разводном деле это не косметика.
   *
   * Теперь проверка и запись — одно событие под замком; частичный
   * уникальный индекс заведён файлом
   * `prisma/manual-migrations/one_active_row_2026_10_05.sql` и
   * применяется владельцем. */
  async createParty(userId: string, configId: string, role: FamilyLawPartyRole, displayName?: string) {
    await this.assertOwnedConfig(userId, configId);

    if (!Object.values(FamilyLawPartyRole).includes(role)) {
      throw new BadRequestException(`Неизвестная роль участника: ${role}`);
    }

    try {
      if (role === FamilyLawPartyRole.SELF) {
        return await withScopeLock(this.prisma, `family-law-self|${configId}`, async (tx) => {
          const existing = await tx.familyLawParty.findFirst({ where: { configId, role: FamilyLawPartyRole.SELF } });
          if (existing) {
            throw new BadRequestException('У этого конфига уже есть сторона с role=SELF');
          }
          return tx.familyLawParty.create({ data: { configId, role, displayName } });
        });
      }
      return await this.prisma.familyLawParty.create({ data: { configId, role, displayName } });
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      if (err?.code === 'P2010' || err?.code === 'P2002') {
        throw new BadRequestException('У этого конфига уже есть сторона с role=SELF');
      }
      throw err;
    }
  }

  async listParties(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    return this.prisma.familyLawParty.findMany({ where: { configId }, orderBy: { createdAt: 'asc' } });
  }

  // ── Реєстр активів (§3.3 ТЗ) — консервативний дефолт isMaritalProperty=true ──

  async createAsset(
    userId: string,
    configId: string,
    assetType: string,
    description?: string,
    ownerId?: string,
    isMaritalProperty?: boolean,
    estimatedValue?: number,
    currency?: string,
  ) {
    await this.assertOwnedConfig(userId, configId);
    if (!assetType.trim()) {
      throw new BadRequestException('assetType не может быть пустым');
    }
    if (estimatedValue !== undefined && estimatedValue < 0) {
      throw new BadRequestException('estimatedValue не может быть отрицательным');
    }
    if (ownerId) {
      const owner = await this.prisma.familyLawParty.findUnique({ where: { id: ownerId } });
      if (!owner || owner.configId !== configId) {
        throw new NotFoundException(`FamilyLawParty ${ownerId} not found`);
      }
    }
    return this.prisma.familyLawAsset.create({
      data: {
        configId,
        assetType: assetType.trim(),
        description,
        ownerId,
        isMaritalProperty: isMaritalProperty ?? true,
        estimatedValue,
        currency,
      },
    });
  }

  async listAssets(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    return this.prisma.familyLawAsset.findMany({ where: { configId }, orderBy: { createdAt: 'asc' } });
  }

  // ── Статус процесу (§3.2 ТЗ) — виключно user-input, СПИСОК записів ──

  async createStatusDetermination(
    userId: string,
    configId: string,
    source: string,
    statusText: string,
    determinedAt: string,
    isOfficial?: boolean,
    referenceDocumentNumber?: string,
  ) {
    await this.assertOwnedConfig(userId, configId);
    if (!Object.values(FamilyLawStatusSource).includes(source as any)) {
      throw new BadRequestException(`Неизвестный источник: ${source}`);
    }
    if (!statusText.trim()) {
      throw new BadRequestException('statusText не может быть пустым');
    }
    return this.prisma.familyLawStatusDetermination.create({
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

  async listStatusDeterminations(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    return this.prisma.familyLawStatusDetermination.findMany({ where: { configId }, orderBy: { determinedAt: 'asc' } });
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
    partyId?: string,
    consultationId?: string,
  ) {
    await this.assertOwnedConfig(userId, configId);
    if (!Object.values(FamilyLawBudgetCategory).includes(category as any)) {
      throw new BadRequestException(`Неизвестная категория: ${category}`);
    }
    if (!Object.values(FamilyLawBudgetDirection).includes(direction as any)) {
      throw new BadRequestException(`Неизвестное направление: ${direction}`);
    }
    if (amount < 0) {
      throw new BadRequestException('amount не может быть отрицательным');
    }
    if (partyId) {
      const party = await this.prisma.familyLawParty.findUnique({ where: { id: partyId } });
      if (!party || party.configId !== configId) {
        throw new NotFoundException(`FamilyLawParty ${partyId} not found`);
      }
    }
    if (consultationId) {
      const consultation = await this.prisma.familyLawConsultation.findUnique({ where: { id: consultationId }, include: { advisor: true } });
      if (!consultation || consultation.advisor.configId !== configId) {
        throw new NotFoundException(`FamilyLawConsultation ${consultationId} not found`);
      }
    }
    return this.prisma.familyLawBudgetLineItem.create({
      // Пункт [budget-invented-a-currency] — см. `dtp-v2.service.ts`.
      data: { configId, category: category as any, direction: direction as any, amount, currency: normalizeCurrency(currency), description, partyId, consultationId },
    });
  }

  /** §3.4/§0 ТЗ — той самий фікс, що ДТП v2, з першого проходу. */
  async getBudget(userId: string, configId: string) {
    const config = await this.assertOwnedConfig(userId, configId);

    const [lineItems, legacyConsultations] = await Promise.all([
      this.prisma.familyLawBudgetLineItem.findMany({ where: { configId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.familyLawConsultation.findMany({
        where: { advisor: { configId }, estimatedCost: { not: null } },
        select: { id: true },
      }),
    ]);

    // Пункт [budget-invented-a-currency] 2026-09-24: группировка была
    // своя в каждом из трёх доменов и одинаково неверная — строка без
    // валюты уходила в корзину со словом-заглушкой вместо валюты
    // проекта, регистр не приводился, а сравнение с целью считалось на
    // экране. Теперь всё это одно общее правило в `common/money.ts`.
    const byCurrency = budgetByCurrency(lineItems, config.currency, config.targetBudget);

    return {
      lineItems,
      byCurrency,
      targetBudget: config.targetBudget,
      currency: config.currency,
      hasLegacyEstimatedCosts: legacyConsultations.length > 0,
    };
  }

  // ── Чернетка-компіляція (§3.6 ТЗ) — з явною позначкою чутливості активів ──

  async getSettlementProtocolDraft(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    const [parties, assets, statusDeterminations, budget] = await Promise.all([
      this.prisma.familyLawParty.findMany({ where: { configId } }),
      this.prisma.familyLawAsset.findMany({ where: { configId } }),
      this.prisma.familyLawStatusDetermination.findMany({ where: { configId }, orderBy: [{ determinedAt: 'desc' }, { id: 'desc' }], take: 1 }),
      this.getBudget(userId, configId),
    ]);

    // Пункт [draft-spoke-machine] 2026-09-24 — см. тот же разбор в
    // `dtp-v2.service.ts`. Здесь цена выше: в документе финансовые
    // данные обеих сторон, и предупреждение об осторожности человек
    // должен прочитать на своём языке.
    const disclaimer =
      'Это черновик-компиляция фактов, записанных вами в продукте, — НЕ юридически завершённый документ, ' +
      'он требует проверки лицензированным юристом перед использованием или подписанием. ' +
      'Реестр активов ниже содержит финансовые данные обеих сторон — обращайтесь с этим документом с повышенной осторожностью.';

    const latestStatus = statusDeterminations[0];
    const lines: string[] = [
      `Стороны: ${parties.map((p: any) => `${labelFor(FAMILY_ROLE_LABEL, p.role)}${p.displayName ? ` (${p.displayName})` : ''}`).join(', ') || 'не указаны'}`,
      latestStatus
        ? `Статус процесса: ${latestStatus.statusText} (${latestStatus.isOfficial ? 'официально подтверждено' : 'предварительно, документом не подтверждено'})`
        : 'Статус процесса: не зафиксирован',
      // `assetType` — свободная строка, которую вводит сам человек
      // (не перечисление), поэтому подписи для неё нет и не нужно:
      // подставлять словарь к пользовательскому тексту значило бы
      // переписывать его слова.
      `Активы: ${assets.map((a: any) => `${a.assetType}${a.estimatedValue ? ` (~${a.estimatedValue} ${a.currency ?? ''})` : ''}`).join(', ') || 'не зафиксированы'}`,
      `Бюджет: ${budget.byCurrency.map((b: any) => moneyWithCurrency(b.netBudget, b.currency)).join(', ') || 'не зафиксирован'}`,
    ];

    return { text: [disclaimer, '', ...lines].join('\n'), generatedAt: new Date().toISOString(), disclaimer };
  }

  // ── Історія повістки питання (§3.7 ТЗ) — нова знахідка, немає аналога в ДТП ──

  async updateGoal(userId: string, configId: string, goalDescription: string) {
    await this.assertOwnedConfig(userId, configId);
    if (!goalDescription.trim()) {
      throw new BadRequestException('goalDescription не может быть пустым');
    }
    return this.prisma.$transaction(async (tx) => {
      const config = await tx.familyLawConfig.update({
        where: { id: configId },
        data: { goalDescription: goalDescription.trim() },
      });
      await tx.familyLawGoalRevision.create({
        data: { configId, goalDescription: goalDescription.trim() },
      });
      return config;
    });
  }

  async getGoalHistory(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    return this.prisma.familyLawGoalRevision.findMany({ where: { configId }, orderBy: { changedAt: 'asc' } });
  }

  // ── Зіставлення слів між консультаціями (§3.5 ТЗ) — спільний сервіс ──

  async crossConsultationCheck(userId: string, criterionId: string): Promise<CrossConsultationCheckResult> {
    const criterion = await this.prisma.familyLawCriterion.findUnique({ where: { id: criterionId }, include: { config: true } });
    if (!criterion) {
      throw new NotFoundException(`FamilyLawCriterion ${criterionId} not found`);
    }
    await assertOwnedFamilyLawProject(this.prisma, userId, criterion.config.projectId);

    const consultations = await this.prisma.familyLawConsultation.findMany({
      where: { advisor: { configId: criterion.configId } },
      include: { advisor: true },
    });

    const statements = consultations
      .map((c: any) => {
        const breakdown = (c.criteriaBreakdown as any[]) ?? [];
        const entry = breakdown.find((b) => b.criterionId === criterionId);
        // АУДИТ (той самий фікс, що DtpV2Service): "не піднімалось у
        // розмові" — чесна деградація generateBreakdown(), не реальне
        // джерело для порівняння.
        if (!entry || !entry.whatWasSaid || entry.whatWasSaid.trim() === NOT_DISCUSSED_PLACEHOLDER) return null;
        return { consultationId: c.id, sourceLabel: c.advisor.label, whatWasSaid: entry.whatWasSaid, sourceSegmentId: entry.sourceSegmentId };
      })
      .filter((s: any): s is NonNullable<typeof s> => s !== null);

    return this.comparison.compare(userId, criterion.config.projectId, CROSS_CHECK_TASK_TYPE, statements);
  }

  async crossConsultationCheckAll(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    const criteria = await this.prisma.familyLawCriterion.findMany({ where: { configId } });
    return Promise.all(
      criteria.map(async (c: any) => ({ criterionId: c.id, ...(await this.crossConsultationCheck(userId, c.id)) })),
    );
  }

  // ── Приватні перевірки власності ──

  private async assertOwnedConfig(userId: string, configId: string) {
    const config = await this.prisma.familyLawConfig.findUnique({ where: { id: configId } });
    if (!config) {
      throw new NotFoundException(`FamilyLawConfig ${configId} not found`);
    }
    await assertOwnedFamilyLawProject(this.prisma, userId, config.projectId);
    return config;
  }
}

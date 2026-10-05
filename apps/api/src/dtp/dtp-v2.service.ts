// Пункт [dtp-v2] (devils-advocate-dtp-v2-tz.md).
//
// НАЙВАЖЛИВІШІ ГАРАНТІЇ: DtpFaultDetermination заповнюється ВИКЛЮЧНО
// користувачем — жоден метод тут не викликає AIRouterService для
// запису статусу вини (§3.2 ТЗ). cross-consultation-check делегує
// повністю в доменно-агностичний CriteriaComparisonService (амендмент,
// devils-advocate-family-law-v2-tz.md §3.5) — тут немає власного
// AI-виклику для порівняння.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DTP_ROLE_LABEL, labelFor } from '../common/document-labels';
import { PrismaService } from '../prisma/prisma.service';
import { budgetByCurrency, moneyWithCurrency, normalizeCurrency } from '../common/money';
import { CriteriaComparisonService, CrossConsultationCheckResult, NOT_DISCUSSED_PLACEHOLDER } from '../criteria-comparison/criteria-comparison.service';
import { DtpParticipantRole, DtpEvidenceAccessAction, DtpFaultSource, DtpBudgetCategory, DtpBudgetDirection } from '@prisma/client';
import { assertOwnedDtpProject } from './dtp-access';
import { withScopeLock } from '../common/ceiling-lock';

const CROSS_CHECK_TASK_TYPE = 'dtp-cross-consultation-check';

@Injectable()
export class DtpV2Service {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: CriteriaComparisonService,
  ) {}

  // ── Учасники (§3.1 ТЗ) ──

  /** §3.1 ТЗ — не більше одного SELF на конфіг.
   *
   * Пункт [the-first-row-was-whichever] 2026-10-05 — ЗАЩИТЫ, НАЗВАННОЙ
   * ЗДЕСЬ, В БАЗЕ НЕ СУЩЕСТВОВАЛО. Шапка обещала «сервісна перевірка +
   * частковий унікальний індекс бази даних як останній рубіж», и ТЗ
   * (§3.1) предписывает ровно такой индекс. В репозитории его не было
   * ни в одной миграции: `CREATE UNIQUE INDEX` встречался дважды и оба
   * раза про другие таблицы, а `WHERE role` не встречался ни разу.
   * Значит `catch` ниже ловил `P2002`, которого никто не бросит, —
   * мёртвый код, который читается как защита. Это худший вид пробела:
   * следующий читатель решает, что место закрыто.
   *
   * Теперь защиты две и обе настоящие: проверка и запись — одно событие
   * под замком по `configId`, а частичный уникальный индекс заведён
   * файлом `prisma/manual-migrations/one_active_row_2026_10_05.sql`
   * (применяет владелец; он может не создаться, если дубли SELF в базе
   * уже есть). Замок держит единственность у тех, кто его берёт;
   * строку, заведённую мимо — ручным SQL, сидом, будущим новым
   * путём, — остановит только индекс. Поэтому нужны оба, и `catch`
   * ниже перестанет быть мёртвым ровно после применения файла.
   *
   * Цена дубля названа, а не предположена: `getSettlementProtocolDraft`
   * печатает участников перебором, то есть в черновике протокола,
   * который человек несёт юристу, он сам был бы указан дважды, а
   * расходы по `DtpBudgetLineItem.participantId` разложились бы по двум
   * «мне». */
  async createParticipant(userId: string, configId: string, role: DtpParticipantRole, displayName?: string, hasFledScene?: boolean) {
    await this.assertOwnedConfig(userId, configId);

    if (!Object.values(DtpParticipantRole).includes(role)) {
      throw new BadRequestException(`Неизвестная роль участника: ${role}`);
    }

    try {
      if (role === DtpParticipantRole.SELF) {
        return await withScopeLock(this.prisma, `dtp-self|${configId}`, async (tx) => {
          const existing = await tx.dtpParticipant.findFirst({ where: { configId, role: DtpParticipantRole.SELF } });
          if (existing) {
            throw new BadRequestException('У этого конфига уже есть участник с role=SELF');
          }
          return tx.dtpParticipant.create({
            data: { configId, role, displayName, hasFledScene: hasFledScene ?? false },
          });
        });
      }
      return await this.prisma.dtpParticipant.create({
        data: { configId, role, displayName, hasFledScene: hasFledScene ?? false },
      });
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      // Частичный уникальный индекс базы — второй рубеж, на случай
      // строки, заведённой мимо замка.
      if (err?.code === 'P2010' || err?.code === 'P2002') {
        throw new BadRequestException('У этого конфига уже есть участник с role=SELF');
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
      throw new BadRequestException(`Неизвестный источник: ${source}`);
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
      throw new BadRequestException(`Неизвестная категория: ${category}`);
    }
    if (!Object.values(DtpBudgetDirection).includes(direction as any)) {
      throw new BadRequestException(`Неизвестное направление: ${direction}`);
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
      // Пункт [budget-invented-a-currency]: нормализация применялась
      // на ПРЕЖНЕМ денежном поле (estimatedCost консультации) и не
      // применялась на том, которое его заменило.
      data: { configId, category: category as any, direction: direction as any, amount, currency: normalizeCurrency(currency), description, participantId, consultationId },
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

  // ── Чернетка-компіляція ──

  async getSettlementProtocolDraft(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    const [participants, faultDeterminations, budget] = await Promise.all([
      this.prisma.dtpParticipant.findMany({ where: { configId }, include: { insurance: true } }),
      this.prisma.dtpFaultDetermination.findMany({ where: { configId }, orderBy: [{ determinedAt: 'desc' }, { id: 'desc' }], take: 1 }),
      this.getBudget(userId, configId),
    ]);

    // Пункт [draft-spoke-machine] 2026-09-24: шаблон был написан
    // по-украински, а всё содержимое документа — по-русски (слова
    // пользователя и вывод модели, которому язык задан централизованно).
    // Документ из двух языков человек несёт юристу.
    const disclaimer =
      'Это черновик-компиляция фактов, записанных вами в продукте, — НЕ юридически завершённый документ, ' +
      'он требует проверки лицензированным юристом перед использованием или подписанием.';

    const latestFault = faultDeterminations[0];
    const lines: string[] = [
      // И роль участника подставлялась машинной константой: «Участники:
      // OTHER_PARTY (Иван Петров)». У экрана словарь подписей есть с
      // самого начала, у документа не было.
      `Участники: ${participants.map((p: any) => `${labelFor(DTP_ROLE_LABEL, p.role)}${p.displayName ? ` (${p.displayName})` : ''}`).join(', ') || 'не указаны'}`,
      latestFault
        ? `Статус вины: ${latestFault.statusText} (${latestFault.isOfficial ? 'официально подтверждено' : 'предварительно, документом не подтверждено'})`
        : 'Статус вины: не зафиксирован',
      `Бюджет: ${budget.byCurrency.map((b: any) => moneyWithCurrency(b.netBudget, b.currency)).join(', ') || 'не зафиксирован'}`,
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

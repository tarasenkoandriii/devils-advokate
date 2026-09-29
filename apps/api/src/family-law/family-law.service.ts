// Пункт [family-law] (devils-advocate-family-law-tz.md §3.2/3.3/5.2-5.4).
//
// НАЙСУВОРІШЕ "РАДНИК, НЕ СУДДЯ" З П'ЯТИ ПОДІБНИХ МОДУЛІВ (§2.1/2.5
// ТЗ): unauthorized practice of law — не тільки регуляторний ризик,
// а живий судовий процес (Nippon Life v. OpenAI, §2.1 ТЗ). НІКОЛИ
// жодного скорингу/сортування/UPL-формулювання, БЕЗ ЖОДНОГО ВИНЯТКУ.

import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation } from '../common/unique-violation';
import { numberedTranscript, resolveSegmentRef } from '../common/transcript-prompt';
import { normalizeCurrency } from '../common/money';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { FamilyLawCriterionCategory } from '@prisma/client';
import { assertOwnedFamilyLawProject } from './family-law-access';
import { ExtractedFamilyLawConfigDraft } from './family-law-onboarding.service';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { allFilled, substanceSite } from '../common/claim-substance';

const BREAKDOWN_TASK_TYPE = 'family-law-consultation-breakdown';

// §3.2 ТЗ, буквально — ЛИШЕ criterionId/whatWasSaid/sourceSegmentId,
// НІЯКОГО covered/score/recommended полів — той самий формат, що
// health.service.ts CriterionStatement.
export interface CriterionStatement {
  criterionId: string;
  whatWasSaid: string;
  sourceSegmentId?: string | null;
}

interface RawBreakdown {
  criteriaBreakdown: CriterionStatement[];
}

// Экспортируется ради проверки на ПОВЕДЕНИИ: спека вызывает сам
// валидатор, а не ищет в его тексте слово `allFilled`
// (Пункт [finding-without-substance-2] 2026-09-26).
export function isValidBreakdown(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.criteriaBreakdown)) return false;
    return parsed.criteriaBreakdown.every(
      // Пункт [finding-without-substance-2] 2026-09-26: `criterionId`
      // пустым не совпадёт ни с одним критерием домена, а вот
      // `whatWasSaid` сохраняется как есть — разбор существует ради этой
      // строки. Одна из ЧЕТЫРЁХ идентичных копий (dtp, health,
      // family-law, investment); реестр — `common/claim-substance.ts`.
      (c: any) =>
        typeof c?.criterionId === 'string' &&
        allFilled(c, substanceSite('isValidBreakdown').required.map((f) => f.field)),
    );
  } catch {
    return false;
  }
}

// §2.1/3.2 ТЗ — заборона на UPL-формулювання, симетрична до заборони
// на медичну оцінку в Пункті [health].
const BREAKDOWN_SYSTEM_PROMPT =
  'Тебе дано транскрипт консультації з сімейним юристом/медіатором та перелік критеріїв, важливих для користувача. ' +
  'Для КОЖНОГО критерію виклади НЕЙТРАЛЬНО, що САМЕ сказав юрист/медіатор по цьому пункту — whatWasSaid, з sourceSegmentId (НОМЕР репліки-джерела — число у квадратних дужках перед реплікою), якщо застосовно. ' +
  'КРИТИЧНО ВАЖЛИВО: НІКОЛИ не формулюй, на що "має право" користувач, як "вирішить суд", чи є умова "справедливою", НЕ став оцінку чи бал, НЕ давай юридичну пораду від свого імені. ' +
  'Якщо юрист/медіатор взагалі не торкнувся критерію — чесно напиши "не піднімалось у розмові", не вигадуй. ' +
  'Відповідай СТРОГО валідним JSON вида {"criteriaBreakdown": [{"criterionId": string, "whatWasSaid": string, "sourceSegmentId": string|null}]}. Без пояснень поза ним.';

// §2.2/3.3 ТЗ — статичний, попередньо написаний текст, НЕ AI-
// генерований (юридичний факт про природу медіації, не той клас
// контенту для AI-судження, той самий принцип, що LEGAL_REFERENCE_SEED
// у Пункті [legal-disclaimer]).
const MEDIATION_NOTICE_TEXT =
  'Комунікації під час медіації в багатьох юрисдикціях юридично привілейовані/конфіденційні — ' +
  'саме тому сторони готові говорити відверто, знаючи, що сказане не буде використане в суді пізніше. ' +
  'Запис і транскрибування цієї сесії потенційно можуть вплинути на цей юридичний захист незалежно від того, як використовується запис. ' +
  'Перед записом медіації рекомендується явна згода медіатора та ознайомлення з правилами конфіденційності конкретної медіації у вашій юрисдикції.';

@Injectable()
export class FamilyLawService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  // ── Конфіг (§5.1 ТЗ — фіксація чернетки онбордингу) ──

  async createConfig(userId: string, projectId: string, draft: ExtractedFamilyLawConfigDraft) {
    await assertOwnedFamilyLawProject(this.prisma, userId, projectId);

    const existing = await this.prisma.familyLawConfig.findUnique({ where: { projectId } });
    if (existing) {
      throw new BadRequestException(`Семейно-правовой разбор для этого проекта уже настроен`);
    }
    // АУДИТ (повний аудит проєкту): та сама відсутня валідація, що
    // виправлена в investment/health/dtp.
    for (const c of draft.criteria) {
      if (!Object.values(FamilyLawCriterionCategory).includes(c.category)) {
        throw new BadRequestException(`Неизвестная категория критерия: ${c.category}`);
      }
    }

    // Пункт [check-then-create] 2026-09-04: проверка выше остаётся, но
    // она НЕ гарантия — между ней и вставкой есть окно, и два
    // одновременных нажатия (двойной тап, повтор при плохой связи)
    // проходили её оба. `projectId` уникален, поэтому второй вызов падал
    // с P2002, и человек читал внутреннюю ошибку сервера вместо того же
    // «уже настроено», что и при обычном повторе. Гонку здесь не
    // исключить без блокировки, но ответ обязан быть один и тот же
    // независимо от того, кто успел раньше.
    try {
      // `return await`, а не `return`: без await промис уходит из
      // try/catch, и отказ базы летит мимо обработчика — ошибка
      // была бы «поймана» только на бумаге.
      return await this.prisma.familyLawConfig.create({
        data: {
          projectId,
          goalDescription: draft.goalDescription,
          targetBudget: draft.targetBudget ?? undefined,
          currency: draft.currency ?? undefined,
          criteria: {
            create: draft.criteria.map((c) => ({
              text: c.text,
              category: c.category,
              isRequired: c.isRequired,
              orderIndex: c.orderIndex,
            })),
          },
          // Пункт [family-law-v2] §3.7 ТЗ — перший запис історії повістки
          // питання створюється одразу, історія повна з моменту
          // створення, не тільки з моменту першої зміни.
          goalRevisions: {
            create: { goalDescription: draft.goalDescription },
          },
        },
        include: { criteria: { orderBy: { orderIndex: 'asc' } } },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new BadRequestException(`Семейно-правовой разбор для этого проекта уже настроен`);
      throw err;
    }
  }

  async getConfig(userId: string, projectId: string) {
    await assertOwnedFamilyLawProject(this.prisma, userId, projectId);
    const config = await this.prisma.familyLawConfig.findUnique({
      where: { projectId },
      include: { criteria: { orderBy: { orderIndex: 'asc' } }, project: { select: { contractType: true } } }, // contractType — для обзора в TMA
    });
    if (!config) {
      throw new NotFoundException(`FamilyLawConfig for project ${projectId} not found`);
    }
    return config;
  }

  // ── Юристи/медіатори (§5.2 ТЗ — "джерело юридичної думки", не "сторона спору") ──

  async createAdvisor(userId: string, configId: string, label: string, advisorName?: string, role?: string) {
    await this.assertOwnedConfig(userId, configId);
    if (!label.trim()) {
      throw new BadRequestException('label не может быть пустым');
    }
    return this.prisma.familyLawAdvisor.create({
      data: { configId, label: label.trim(), advisorName, role },
    });
  }

  async listAdvisors(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    return this.prisma.familyLawAdvisor.findMany({ where: { configId }, orderBy: { createdAt: 'asc' } });
  }

  // ── Консультації (§5.2 ТЗ) ──

  async createConsultation(
    userId: string,
    advisorId: string,
    conversationId: string | undefined,
    occurredAt: string,
    estimatedCost?: number,
    // Аудит денег 2026-09-03 — то же, что в DTP: поле в схеме было, писать
    // его было некому.
    currency?: string | null,
    isMediationSession?: boolean,
  ) {
    const advisor = await this.assertOwnedAdvisor(userId, advisorId);
    if (conversationId) {
      const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
      if (!conversation || conversation.projectId !== advisor.config.projectId) {
        throw new NotFoundException(`Conversation ${conversationId} not found`);
      }
    }
    if (estimatedCost !== undefined && estimatedCost < 0) {
      throw new BadRequestException('estimatedCost не может быть отрицательным');
    }
    return this.prisma.familyLawConsultation.create({
      data: { advisorId, conversationId, occurredAt: new Date(occurredAt), estimatedCost, currency: normalizeCurrency(currency), isMediationSession: isMediationSession ?? false },
    });
  }

  async listConsultations(userId: string, advisorId: string) {
    await this.assertOwnedAdvisor(userId, advisorId);
    return this.prisma.familyLawConsultation.findMany({ where: { advisorId }, orderBy: { occurredAt: 'desc' } });
  }

  async getConsultation(userId: string, consultationId: string) {
    return this.assertOwnedConsultation(userId, consultationId);
  }

  /** §3.2 ТЗ — нейтральний виклад того, що сказав юрист/медіатор, БЕЗ
   * жодної UPL-оцінки/рекомендації. */
  async generateBreakdown(userId: string, consultationId: string) {
    const consultation = await this.assertOwnedConsultation(userId, consultationId);
    if (!consultation.conversationId) {
      throw new BadRequestException('У этой консультации нет связанного разговора — нечего анализировать');
    }

    const [segments, criteria] = await Promise.all([
      this.prisma.transcriptSegment.findMany({
        where: { transcript: { conversationId: consultation.conversationId } },
        orderBy: { startMs: 'asc' },
      }),
      this.prisma.familyLawCriterion.findMany({
        where: { configId: consultation.advisor.configId },
        orderBy: { orderIndex: 'asc' },
      }),
    ]);
    if (segments.length === 0) {
      throw new BadRequestException('Транскрипт этой консультации ещё пуст — нечего анализировать');
    }

    const transcript = numberedTranscript(segments);
    const transcriptText = transcript.text;
    const criteriaText = criteria
      .map((c: any) => `[id=${c.id}] (${c.category}) ${c.text}${c.isRequired ? ' (критично)' : ''}`)
      .join('\n');

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId: consultation.advisor.config.projectId,
        taskType: BREAKDOWN_TASK_TYPE,
        systemPrompt: BREAKDOWN_SYSTEM_PROMPT,
        userPrompt: `Критерії:\n${criteriaText}\n\nТранскрипт консультації:\n${transcriptText}`,
        jsonMode: true,
        maxTokens: 2000,
        validateOutput: isValidBreakdown,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Генерация разбора отклонена проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось сгенерировать разбор — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const parsed: RawBreakdown = JSON.parse(result.text);
    // Сверка «ссылка на реплику» 2026-09-04: раньше `sourceSegmentId`
    // сохранялся как есть. Модель могла назвать реплику, которой нет, и
    // разбор сослался бы на слова, которых собеседник не говорил.
    // Теперь номер переводится в настоящий id, а несуществующий —
    // становится «источник не указан»: у утверждения будет честное
    // отсутствие ссылки вместо выдуманной.
    const criteriaBreakdown = parsed.criteriaBreakdown.map((b) => ({
      ...b,
      sourceSegmentId: resolveSegmentRef(transcript.byRef, b.sourceSegmentId),
    }));
    return this.prisma.familyLawConsultation.update({
      where: { id: consultationId },
      data: {
        criteriaBreakdown: criteriaBreakdown as any,
        draftedAt: new Date(),
        // Той самий фікс, що вже знайдений аудитом у Пункті [health]
        // — повторна генерація очищує старий reviewedAt/reviewNotes,
        // не лишає їх прив'язаними до нового, ще не переглянутого
        // контенту. Застосовано тут одразу з першого проходу.
        reviewedAt: null,
        reviewNotes: null,
      },
    });
  }

  /** Той самий гейт, що всюди в продукті — вимагає draftedAt. */
  async reviewConsultation(userId: string, consultationId: string, reviewNotes?: string) {
    const consultation = await this.assertOwnedConsultation(userId, consultationId);
    if (!consultation.draftedAt) {
      throw new BadRequestException('Нельзя подтвердить разбор, который никогда не был сгенерирован — сначала вызовите generate-breakdown');
    }
    return this.prisma.familyLawConsultation.update({
      where: { id: consultationId },
      data: { reviewedAt: new Date(), reviewNotes: reviewNotes ?? undefined },
    });
  }

  // ── Попередження про медіацію (§2.2/3.3/5.3 ТЗ) ──

  /** Тільки коли isMediationSession=true — NotFoundException інакше
   * (§7 acceptance-тест ТЗ, той самий принцип, що всюди в продукті
   * для "це не застосовується тут"). */
  async getMediationNotice(userId: string, consultationId: string) {
    const consultation = await this.assertOwnedConsultation(userId, consultationId);
    if (!consultation.isMediationSession) {
      throw new NotFoundException(`Consultation ${consultationId} is not a mediation session`);
    }
    return { text: MEDIATION_NOTICE_TEXT };
  }

  // ── Порівняльний вивід (§3.2/5.4 ТЗ) — БЕЗ жодного score/rank, без винятку ──

  async getComparisonTable(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);

    const [advisors, criteria] = await Promise.all([
      this.prisma.familyLawAdvisor.findMany({
        where: { configId },
        include: { consultations: { orderBy: { occurredAt: 'desc' } } },
      }),
      this.prisma.familyLawCriterion.findMany({ where: { configId }, orderBy: { orderIndex: 'asc' } }),
    ]);

    return {
      criteria,
      // Структурно ВІДСУТНЄ будь-яке поле score/rank/sortedBy.
      advisors: advisors.map((a: any) => ({
        id: a.id,
        label: a.label,
        advisorName: a.advisorName,
        role: a.role,
        consultationsCount: a.consultations.length,
        latestBreakdown: a.consultations[0]?.criteriaBreakdown ?? null,
      })),
    };
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

  private async assertOwnedAdvisor(userId: string, advisorId: string) {
    const advisor = await this.prisma.familyLawAdvisor.findUnique({
      where: { id: advisorId },
      include: { config: true },
    });
    if (!advisor) {
      throw new NotFoundException(`FamilyLawAdvisor ${advisorId} not found`);
    }
    await assertOwnedFamilyLawProject(this.prisma, userId, advisor.config.projectId);
    return advisor;
  }

  private async assertOwnedConsultation(userId: string, consultationId: string) {
    const consultation = await this.prisma.familyLawConsultation.findUnique({
      where: { id: consultationId },
      include: { advisor: { include: { config: true } } },
    });
    if (!consultation) {
      throw new NotFoundException(`FamilyLawConsultation ${consultationId} not found`);
    }
    await assertOwnedFamilyLawProject(this.prisma, userId, consultation.advisor.config.projectId);
    return consultation;
  }
}

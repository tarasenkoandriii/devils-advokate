// Пункт [investment] (devils-advocate-investment-tz.md §3.2/3.3/5.2-5.4).
//
// НАЙВАЖЛИВІШЕ АРХІТЕКТУРНЕ ОБМЕЖЕННЯ ЦЬОГО ФАЙЛУ (§2.2/3.2 ТЗ,
// MiFID II "personal recommendation"): НІКОЛИ жодного скорингу/
// сортування варіантів між собою, НІКОЛИ поля covered/score/rank —
// структурна відсутність у типах нижче, не програмна заборона.

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { InvestmentCriterionCategory } from '@prisma/client';
import { fetchUrlText, UnsafeUrlError, UrlFetchError } from '../common/safe-url-fetch';
import { assertInvestmentProjectAccess } from './investment-access';
import { ExtractedInvestmentConfigDraft } from './investment-onboarding.service';

const BREAKDOWN_TASK_TYPE = 'investment-meeting-breakdown';

// §3.2 ТЗ, буквально — ЛИШЕ criterionId/whatWasSaid/sourceSegmentId,
// НІЯКОГО covered/score/recommended полів у жодному з трьох рівнів
// (тип, Prisma-JSON, AI-промпт).
export interface CriterionStatement {
  criterionId: string;
  whatWasSaid: string;
  sourceSegmentId?: string | null;
}

interface RawBreakdown {
  criteriaBreakdown: CriterionStatement[];
}

function isValidBreakdown(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.criteriaBreakdown)) return false;
    return parsed.criteriaBreakdown.every(
      (c: any) => typeof c?.criterionId === 'string' && typeof c?.whatWasSaid === 'string',
    );
  } catch {
    return false;
  }
}

// §3.3 ТЗ — явна заборона на рекомендаційні формулювання, симетрична
// до заборони на дискримінаційні критерії в Пункті [interview-pool]
// §2.4, перевіряється тим самим методом (перехоплення реального
// тексту промпту, не постфактум-вивід).
const BREAKDOWN_SYSTEM_PROMPT =
  'Тебе дано транскрипт зустрічі з фінансовим радником/представником та перелік критеріїв, важливих для користувача. ' +
  'Для КОЖНОГО критерію викладі НЕЙТРАЛЬНО, що САМЕ сказав радник по цьому пункту — whatWasSaid, з sourceSegmentId (id репліки-джерела), якщо застосовно. ' +
  'КРИТИЧНО ВАЖЛИВО: НІКОЛИ не формулюй висновок як "варто"/"не варто", "рекомендую"/"не рекомендую", "цей варіант кращий", НЕ став оцінку чи бал — ' +
  'тільки буквальний, нейтральний переказ того, що прозвучало. Якщо радник взагалі не торкнувся критерію — чесно напиши "не піднімалось у розмові", не вигадуй. ' +
  'Відповідай СТРОГО валідним JSON вида {"criteriaBreakdown": [{"criterionId": string, "whatWasSaid": string, "sourceSegmentId": string|null}]}. Без пояснень поза ним.';

@Injectable()
export class InvestmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  // ── Конфіг (§5.1 ТЗ — фіксація чернетки онбордингу) ──

  async createConfig(userId: string, projectId: string, draft: ExtractedInvestmentConfigDraft) {
    await assertInvestmentProjectAccess(this.prisma, userId, projectId);

    const existing = await this.prisma.investmentConfig.findUnique({ where: { projectId } });
    if (existing) {
      throw new BadRequestException(`InvestmentConfig for project ${projectId} already exists`);
    }
    // АУДИТ (повний аудит проєкту): раніше category критеріїв не
    // звірялась з InvestmentCriterionCategory перед записом — клієнт
    // міг надіслати довільний рядок напряму в config-confirm, минаючи
    // валідацію онбордінг-екстракції. Той самий клас гарантії, що вже
    // застосований до mediaType/category/direction/source у DTP/family-law v2.
    for (const c of draft.criteria) {
      if (!Object.values(InvestmentCriterionCategory).includes(c.category)) {
        throw new BadRequestException(`Unknown criterion category: ${c.category}`);
      }
    }

    return this.prisma.investmentConfig.create({
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
      },
      include: { criteria: { orderBy: { orderIndex: 'asc' } } },
    });
  }

  async getConfig(userId: string, projectId: string) {
    await assertInvestmentProjectAccess(this.prisma, userId, projectId);
    const config = await this.prisma.investmentConfig.findUnique({
      where: { projectId },
      include: { criteria: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!config) {
      throw new NotFoundException(`InvestmentConfig for project ${projectId} not found`);
    }
    return config;
  }

  // ── Варіанти (§5.2 ТЗ — "InvestmentOpportunity", не "переможець") ──

  async createOpportunity(userId: string, configId: string, label: string, advisorName?: string, advisorCompany?: string) {
    await this.assertOwnedConfig(userId, configId);
    if (!label.trim()) {
      throw new BadRequestException('label не может быть пустым');
    }
    return this.prisma.investmentOpportunity.create({
      data: { configId, label: label.trim(), advisorName, advisorCompany },
    });
  }

  async listOpportunities(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    return this.prisma.investmentOpportunity.findMany({ where: { configId }, orderBy: { createdAt: 'asc' } });
  }

  // ── Зустрічі (§5.2 ТЗ) ──

  async createMeeting(userId: string, opportunityId: string, conversationId: string | undefined, occurredAt: string) {
    const opportunity = await this.assertOwnedOpportunity(userId, opportunityId);
    if (conversationId) {
      const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
      if (!conversation || conversation.projectId !== opportunity.config.projectId) {
        throw new NotFoundException(`Conversation ${conversationId} not found`);
      }
    }
    return this.prisma.investmentMeeting.create({
      data: { opportunityId, conversationId, occurredAt: new Date(occurredAt) },
    });
  }

  /** §3.2/3.3 ТЗ — нейтральний виклад того, що сказав радник, БЕЗ
   * жодної оцінки/балу/рекомендації. */
  async generateBreakdown(userId: string, meetingId: string) {
    const meeting = await this.assertOwnedMeeting(userId, meetingId);
    if (!meeting.conversationId) {
      throw new BadRequestException('У этой встречи нет связанного разговора — нечего анализировать');
    }

    const [segments, criteria] = await Promise.all([
      this.prisma.transcriptSegment.findMany({
        where: { transcript: { conversationId: meeting.conversationId } },
        orderBy: { startMs: 'asc' },
      }),
      this.prisma.investmentQuizCriterion.findMany({
        where: { configId: meeting.opportunity.configId },
        orderBy: { orderIndex: 'asc' },
      }),
    ]);
    if (segments.length === 0) {
      throw new BadRequestException('Транскрипт цієї розмови ще порожній — нечего аналізувати');
    }

    const transcriptText = segments.map((s: { id: string; text: string }) => `[id=${s.id}] ${s.text}`).join('\n');
    const criteriaText = criteria
      .map((c: any) => `[id=${c.id}] (${c.category}) ${c.text}${c.isRequired ? ' (критично)' : ''}`)
      .join('\n');

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId: meeting.opportunity.config.projectId,
        taskType: BREAKDOWN_TASK_TYPE,
        systemPrompt: BREAKDOWN_SYSTEM_PROMPT,
        userPrompt: `Критерії:\n${criteriaText}\n\nТранскрипт зустрічі:\n${transcriptText}`,
        jsonMode: true,
        maxTokens: 2000,
        validateOutput: isValidBreakdown,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Генерация разбора отклонена проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось сгенерировать разбор — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const parsed: RawBreakdown = JSON.parse(result.text);
    return this.prisma.investmentMeeting.update({
      where: { id: meetingId },
      data: { criteriaBreakdown: parsed.criteriaBreakdown as any, draftedAt: new Date() },
    });
  }

  /** Той самий гейт, що всюди в продукті — вимагає draftedAt, не
   * дозволяє "рев'ю" того, чого AI ніколи не пропонував. */
  async reviewMeeting(userId: string, meetingId: string, reviewNotes?: string) {
    const meeting = await this.assertOwnedMeeting(userId, meetingId);
    if (!meeting.draftedAt) {
      throw new BadRequestException('Нельзя подтвердить разбор, который никогда не был сгенерирован — сначала вызовите generate-breakdown');
    }
    return this.prisma.investmentMeeting.update({
      where: { id: meetingId },
      data: { reviewedAt: new Date(), reviewNotes: reviewNotes ?? undefined },
    });
  }

  // ── Звірка тверджень радника (§5.3 ТЗ) — user-supplied URL, НЕ скрапінг ──

  async addSourceComparison(userId: string, opportunityId: string, sourceUrl: string) {
    await this.assertOwnedOpportunity(userId, opportunityId);

    let sourceText: string;
    try {
      sourceText = await fetchUrlText(sourceUrl);
    } catch (err) {
      if (err instanceof UnsafeUrlError || err instanceof UrlFetchError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    // §3.2 ТЗ — НЕМАЄ AI-екстракції ціни/оцінки тут навмисно (на
    // відміну від MarketComparison у major-purchase) — фінансовий
    // продукт складніший за нерухомість/авто, "вирахувана ціна" тут
    // легко стала б імпліцитною оцінкою вигідності. Тільки сирий
    // текст для власного прочитання користувачем.
    return this.prisma.investmentSourceComparison.create({
      data: { opportunityId, sourceUrl, sourceText },
    });
  }

  // ── Порівняльний вивід (§3.2/5.4 ТЗ) — БЕЗ жодного score/rank ──

  async getComparisonTable(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);

    const [opportunities, criteria] = await Promise.all([
      this.prisma.investmentOpportunity.findMany({
        where: { configId },
        include: {
          meetings: { orderBy: { occurredAt: 'desc' } },
          comparisons: true,
        },
      }),
      this.prisma.investmentQuizCriterion.findMany({ where: { configId }, orderBy: { orderIndex: 'asc' } }),
    ]);

    return {
      criteria,
      // Структурно ВІДСУТНЄ будь-яке поле score/rank/sortedBy — не
      // приховане на фронтенді, фізично не обчислюється тут.
      opportunities: opportunities.map((o: any) => ({
        id: o.id,
        label: o.label,
        advisorName: o.advisorName,
        advisorCompany: o.advisorCompany,
        meetingsCount: o.meetings.length,
        comparisonCount: o.comparisons.length,
        latestBreakdown: o.meetings[0]?.criteriaBreakdown ?? null,
      })),
    };
  }

  // ── Приватні перевірки власності ──

  private async assertOwnedConfig(userId: string, configId: string) {
    const config = await this.prisma.investmentConfig.findUnique({ where: { id: configId } });
    if (!config) {
      throw new NotFoundException(`InvestmentConfig ${configId} not found`);
    }
    await assertInvestmentProjectAccess(this.prisma, userId, config.projectId);
    return config;
  }

  /** Доменная вёрстка TMA — полная история встреч и сверок предложения.
   * До этого были только POST (bug class «create-only API missing read endpoint»). */
  async getOpportunity(userId: string, opportunityId: string) {
    const opportunity = await this.assertOwnedOpportunity(userId, opportunityId);
    return this.prisma.investmentOpportunity.findUnique({
      where: { id: opportunity.id },
      include: {
        meetings: { orderBy: { occurredAt: 'desc' } },
        comparisons: { orderBy: { createdAt: 'desc' } },
      },
    });
  }

  private async assertOwnedOpportunity(userId: string, opportunityId: string) {
    const opportunity = await this.prisma.investmentOpportunity.findUnique({
      where: { id: opportunityId },
      include: { config: true },
    });
    if (!opportunity) {
      throw new NotFoundException(`InvestmentOpportunity ${opportunityId} not found`);
    }
    await assertInvestmentProjectAccess(this.prisma, userId, opportunity.config.projectId);
    return opportunity;
  }

  private async assertOwnedMeeting(userId: string, meetingId: string) {
    const meeting = await this.prisma.investmentMeeting.findUnique({
      where: { id: meetingId },
      include: { opportunity: { include: { config: true } } },
    });
    if (!meeting) {
      throw new NotFoundException(`InvestmentMeeting ${meetingId} not found`);
    }
    await assertInvestmentProjectAccess(this.prisma, userId, meeting.opportunity.config.projectId);
    return meeting;
  }
}

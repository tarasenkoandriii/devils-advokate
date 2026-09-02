// Пункт [major-purchase] (devils-advocate-major-purchase-tz.md §5.2-5.6).

import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConsentService } from '../consent/consent.service';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentType, PurchaseCategory } from '@prisma/client';
import { fetchUrlText, UnsafeUrlError, UrlFetchError } from '../common/safe-url-fetch';
import { searchNearestByDistance, searchByText, getPlaceDetails } from '../venue-recommendation/google-places-client';
import { ExtractedConfigDraft } from './major-purchase-onboarding.service';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const GOOGLE_PLACES_API_KEY_REF = 'GOOGLE_PLACES_API_KEY';
// Пункт [major-purchase] §2.2 ТЗ — офіційні значення Google Places API,
// не вигадані.
const PLACE_TYPE_BY_CATEGORY: Record<PurchaseCategory, string> = {
  REAL_ESTATE: 'real_estate_agency',
  VEHICLE: 'car_dealer',
};

// Пункт [major-purchase] §2.1 ТЗ — уніфікована LOCATION-згода (§3.32
// implementation-ready, Пункт 77 "Unified Geo Permission"), НЕ окрема
// незалежна ціль. АУДИТ ПЕРЕД РЕАЛІЗАЦІЄЮ: ТЗ обіцяв "відкликання цієї
// конкретної цілі не чіпає інші цілі LOCATION" — перевірено в
// ConsentService.revoke() прямо перед написанням цього файлу: відзив
// LOCATION-згоди навмисно відкликає ВСІ purposes разом (одна
// ConsentRecord, не три незалежні — задокументоване архітектурне
// рішення §3.32, не недогляд). Обіцянка ТЗ виявилась хибною проти вже
// свідомо збудованої архітектури — реалізовано через вже наявний
// requireConsent() як є, БЕЗ окремого purpose-специфічного методу,
// щоб не суперечити прийнятому раніше рішенню "один екран згоди на
// всі geo-фічі". purposes["major_purchase_viewings"] і далі
// записується при grant() для аудиту, просто не є окремою гранульованою
// перевіркою.
const LOCATION_PURPOSE = 'major_purchase_viewings';

const CONCLUSION_TASK_TYPE = 'major-purchase-meeting-conclusion';
const PRICE_EXTRACT_TASK_TYPE = 'major-purchase-price-extraction';

interface RawConclusion {
  conclusion: string;
  criteriaBreakdown: Array<{ criterionId: string; covered: 'yes' | 'partial' | 'no' | 'unknown'; note: string }>;
}

function isValidConclusion(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.conclusion !== 'string' || parsed.conclusion.trim().length === 0) return false;
    if (!Array.isArray(parsed.criteriaBreakdown)) return false;
    return parsed.criteriaBreakdown.every(
      (c: any) =>
        typeof c?.criterionId === 'string' &&
        ['yes', 'partial', 'no', 'unknown'].includes(c?.covered) &&
        typeof c?.note === 'string',
    );
  } catch {
    return false;
  }
}

interface RawPriceExtraction {
  extractedPrice: number | null;
}

function isValidPriceExtraction(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && (parsed.extractedPrice === null || typeof parsed.extractedPrice === 'number');
  } catch {
    return false;
  }
}

@Injectable()
export class MajorPurchaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
    private readonly consent: ConsentService,
    private readonly secrets: SecretsService,
  ) {}

  // ── Конфіг (фіксація чернетки онбордінгу, §5.1 ТЗ) ──

  async createConfig(
    userId: string,
    projectId: string,
    category: PurchaseCategory,
    draft: ExtractedConfigDraft,
  ) {
    await this.assertOwnedProject(userId, projectId);

    const existing = await this.prisma.majorPurchaseConfig.findUnique({ where: { projectId } });
    if (existing) {
      throw new BadRequestException(`MajorPurchaseConfig for project ${projectId} already exists`);
    }

    return this.prisma.majorPurchaseConfig.create({
      data: {
        projectId,
        category,
        goalDescription: draft.goalDescription,
        budgetMin: draft.budgetMin ?? undefined,
        budgetMax: draft.budgetMax ?? undefined,
        currency: draft.currency ?? undefined,
        financingMethod: draft.financingMethod ?? undefined,
        timeline: draft.timeline ?? undefined,
        criteria: {
          create: draft.criteria.map((c) => ({ text: c.text, isRequired: c.isRequired, orderIndex: c.orderIndex })),
        },
      },
      include: { criteria: { orderBy: { orderIndex: 'asc' } } },
    });
  }

  // ── Варіанти (§5.2 ТЗ) ──

  async createVariant(userId: string, configId: string, label: string, askingPrice?: number, currency?: string) {
    await this.assertOwnedConfig(userId, configId);
    if (!label.trim()) {
      throw new BadRequestException('label не может быть пустым');
    }
    return this.prisma.purchaseVariant.create({
      data: { configId, label: label.trim(), askingPrice, currency },
    });
  }

  /** Ручний ввід адреси/назви — НЕ вимагає ConsentType.LOCATION (§5.2
   * ТЗ: "той самий принцип, що WeatherForecastService.generateByCity"). */
  async setLocationByPlaceId(userId: string, variantId: string, placeId: string) {
    await this.assertOwnedVariant(userId, variantId);
    const apiKey = await this.secrets.resolve(GOOGLE_PLACES_API_KEY_REF);

    let details;
    try {
      details = await getPlaceDetails(placeId, apiKey);
    } catch (err) {
      throw new BadGatewayException(err instanceof Error ? err.message : 'Google Places недоступен');
    }

    return this.prisma.purchaseVariant.update({
      where: { id: variantId },
      data: {
        placeId,
        placeName: details.name,
        placeAddress: details.address,
        latitude: details.location?.latitude,
        longitude: details.location?.longitude,
      },
    });
  }

  /** Автовизначення через геолокацію пристрою — ВИМАГАЄ ConsentType.LOCATION
   * (§5.2/§2.1 ТЗ). Шукає НАЙБЛИЖЧЕ місце ЗА КАТЕГОРІЄЮ покупки
   * (real_estate_agency/car_dealer) через searchNearestByDistance() —
   * АУДИТ ЗНАЙШОВ БАГ: раніше використовувався searchNearbyVenues()
   * (prominence-ранжування, не за відстанню) — виправлено, див.
   * коментар над searchNearestByDistance() в google-places-client.ts. */
  async setLocationByGeolocation(userId: string, variantId: string, latitude: number, longitude: number) {
    const variant = await this.assertOwnedVariant(userId, variantId);
    await this.consent.requireConsent(userId, ConsentType.LOCATION, variant.config.projectId);

    const apiKey = await this.secrets.resolve(GOOGLE_PLACES_API_KEY_REF);
    const placeType = PLACE_TYPE_BY_CATEGORY[variant.config.category];

    let candidates;
    try {
      candidates = await searchNearestByDistance(latitude, longitude, apiKey, placeType);
    } catch (err) {
      throw new BadGatewayException(err instanceof Error ? err.message : 'Google Places недоступен');
    }
    if (candidates.length === 0) {
      // Чесна деградація — зберігаємо сирі координати без прив'язки до
      // конкретного місця, не вигадуємо назву/адресу.
      return this.prisma.purchaseVariant.update({
        where: { id: variantId },
        data: { latitude, longitude },
      });
    }

    const nearest = candidates[0];
    let details;
    try {
      details = await getPlaceDetails(nearest.placeId, apiKey);
    } catch {
      return this.prisma.purchaseVariant.update({
        where: { id: variantId },
        data: { placeId: nearest.placeId, placeName: nearest.name, latitude, longitude },
      });
    }

    return this.prisma.purchaseVariant.update({
      where: { id: variantId },
      data: {
        placeId: nearest.placeId,
        placeName: details.name,
        placeAddress: details.address,
        latitude,
        longitude,
      },
    });
  }

  /** Реєстрація саме цільового LOCATION-consent (§2.1/3 ТЗ,
   * purposes ["major_purchase_viewings"]) — не заміна загального
   * consent-флоу, окремий явний виклик перед першим використанням
   * геолокації в цьому use case. */
  async grantLocationConsent(userId: string, version: string) {
    return this.consent.grant({
      userId,
      consentType: ConsentType.LOCATION,
      version,
      source: 'major-purchase-onboarding',
      purposes: [LOCATION_PURPOSE],
    });
  }

  /** Пошук локації за текстом (назва салону/агентства) — той самий
   * "ручний ввід не вимагає згоди" принцип, окремий шлях для UI-пошуку
   * перед вибором конкретного placeId. */
  async searchLocationByText(userId: string, variantId: string, query: string) {
    const variant = await this.assertOwnedVariant(userId, variantId);
    const apiKey = await this.secrets.resolve(GOOGLE_PLACES_API_KEY_REF);
    const typedQuery = `${query} ${PLACE_TYPE_BY_CATEGORY[variant.config.category] === 'car_dealer' ? 'автосалон' : 'агентство нерухомості'}`;
    try {
      return await searchByText(typedQuery, apiKey);
    } catch (err) {
      throw new BadGatewayException(err instanceof Error ? err.message : 'Google Places недоступен');
    }
  }

  // ── Зустрічі (§5.2/5.5 ТЗ) ──

  async createMeeting(userId: string, variantId: string, conversationId: string | undefined, occurredAt: string) {
    const variant = await this.assertOwnedVariant(userId, variantId);
    if (conversationId) {
      const conversation = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { project: true },
      });
      if (!conversation || conversation.project.ownerId !== userId || conversation.projectId !== variant.config.projectId) {
        throw new NotFoundException(`Conversation ${conversationId} not found`);
      }
    }
    return this.prisma.purchaseMeeting.create({
      data: { variantId, conversationId, occurredAt: new Date(occurredAt) },
    });
  }

  /** §5.5 ТЗ — AI формує ЧЕРНЕТКУ, враховуючи знайдені ConversationSignal
   * цієї розмови + вже накопичені MarketComparison варіанту + покриття
   * QuizCriterion[]. НЕ викликає ManipulationDetectorService/
   * DiscrepancyAnalysisService напряму (уникнення зайвої міжмодульної
   * залежності заради одного читання) — читає вже створені ними
   * ConversationSignal прямо з БД, той самий результат. */
  async generateConclusion(userId: string, meetingId: string) {
    const meeting = await this.assertOwnedMeeting(userId, meetingId);
    if (!meeting.conversationId) {
      throw new BadRequestException('У этой встречи нет связанного разговора — нечего анализировать');
    }

    const [signals, comparisons, criteria] = await Promise.all([
      this.prisma.conversationSignal.findMany({
        where: { transcriptSegment: { transcript: { conversationId: meeting.conversationId } } },
        select: { signalType: true, severity: true, transcriptSegment: { select: { text: true } } },
      }),
      this.prisma.marketComparison.findMany({ where: { variantId: meeting.variantId } }),
      this.prisma.quizCriterion.findMany({ where: { configId: meeting.variant.configId }, orderBy: { orderIndex: 'asc' } }),
    ]);

    const contextParts = [
      `Варіант: ${meeting.variant.label}${meeting.variant.askingPrice ? `, заявлена ціна ${meeting.variant.askingPrice} ${meeting.variant.currency ?? ''}` : ''}`,
      meeting.variant.placeAddress ? `Локація: ${meeting.variant.placeAddress}` : '',
      `Критерії пошуку (використовуй саме ці id у criteriaBreakdown): ${criteria.map((c: any) => `[id=${c.id}] ${c.text}${c.isRequired ? ' (критично)' : ''}`).join('; ')}`,
      signals.length > 0
        ? `Знайдені сигнали під час зустрічі: ${signals.map((s: any) => `${s.signalType}${s.severity ? `/${s.severity}` : ''}: "${s.transcriptSegment?.text ?? ''}"`).join('; ')}`
        : 'Жодних розбіжностей/маніпуляцій не знайдено під час аналізу цієї зустрічі.',
      comparisons.length > 0
        ? `Порівняння з іншими лістингами: ${comparisons.map((c: any) => `${c.sourceUrl}${c.extractedPrice ? ` (ціна ${c.extractedPrice})` : ''}`).join('; ')}`
        : 'Порівнянь з іншими лістингами користувач ще не додав.',
    ].filter(Boolean).join('\n');

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId: meeting.variant.config.projectId,
        taskType: CONCLUSION_TASK_TYPE,
        systemPrompt:
          'На основе данных о встрече (вариант покупки, критерии поиска с их id, найденные сигналы разговора, сравнения с другими объявлениями) сформулируй: ' +
          '(1) conclusion — краткий связный вывод-черновик для пользователя, что стоит взять на заметку, БЕЗ вердикта "покупать/не покупать" (это решение пользователя, не системы); ' +
          '(2) criteriaBreakdown — массив по КАЖДОМУ критерию из списка (используй именно переданные id, не выдумывай новые) с полями criterionId, covered ("yes" если явно подтверждено разговором/сравнениями, "partial" если частично, "no" если явно НЕ соответствует, "unknown" если тема просто не поднималась — НЕ угадывай "no", если информации недостаточно) и note (короткое обоснование). ' +
          'Ответь СТРОГО валидным JSON вида {"conclusion": string, "criteriaBreakdown": [{"criterionId": string, "covered": string, "note": string}]}. Без пояснений вне JSON.',
        userPrompt: contextParts,
        jsonMode: true,
        maxTokens: 1200,
        validateOutput: isValidConclusion,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Генерация вывода отклонена проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось сгенерировать вывод — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const parsed: RawConclusion = JSON.parse(result.text);
    return this.prisma.purchaseMeeting.update({
      where: { id: meetingId },
      data: {
        conclusionDraft: parsed.conclusion,
        draftedAt: new Date(),
        criteriaBreakdown: parsed.criteriaBreakdown as any,
      },
    });
  }

  /** §5.5 ТЗ — технічний гейт: conclusionFinal недоступний, поки
   * reviewedAt не заповнено явним викликом, той самий принцип, що
   * ClientReport у документі Пункту [interview-pool] (документ, не
   * реалізація — але принцип відтворено тут насправді в коді).
   *
   * АУДИТ ЗНАЙШОВ ГАП: раніше не перевірялось, чи взагалі існує
   * conclusionDraft — можна було викликати review-conclusion одразу,
   * ЖОДНОГО разу не викликавши generate-conclusion, зводячи нанівець
   * весь сенс "AI пропонує чернетку, людина підтверджує" (людина
   * підтверджувала б те, чого AI ніколи не пропонував). Виправлено —
   * вимагає draftedAt, той самий принцип, що вже застосований в
   * PromptRegistryService.promoteToActive() (не можна активувати
   * версію, що ніколи не проходила evaluation). */
  async reviewConclusion(userId: string, meetingId: string, conclusionFinal: string) {
    const meeting = await this.assertOwnedMeeting(userId, meetingId);
    if (!meeting.draftedAt) {
      throw new BadRequestException(
        'Нельзя подтвердить вывод, который никогда не был сгенерирован — сначала вызовите generate-conclusion',
      );
    }
    if (!conclusionFinal.trim()) {
      throw new BadRequestException('conclusionFinal не может быть пустым');
    }
    return this.prisma.purchaseMeeting.update({
      where: { id: meetingId },
      data: { conclusionFinal: conclusionFinal.trim(), reviewedAt: new Date() },
    });
  }

  // ── Порівняння з лістингами (§2.3/5.4 ТЗ) ──

  /** СВІДОМО user-supplied URL, НЕ автоматичний скрапінг маркетплейсів
   * (§2.3 ТЗ — юридична причина, активний клас судового ризику,
   * задокументований для Zillow/Redfin/AutoTrader). Переюз
   * fetchUrlText()/safe-url-fetch.ts (SSRF-захист) — той самий, що вже
   * використовується в checkAgainstUserSource. */
  async addComparison(userId: string, variantId: string, sourceUrl: string) {
    const variant = await this.assertOwnedVariant(userId, variantId);

    let sourceText: string;
    try {
      sourceText = await fetchUrlText(sourceUrl);
    } catch (err) {
      if (err instanceof UnsafeUrlError || err instanceof UrlFetchError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    // Пункт [fact-check-source-closure] §5.3a ТЗ: Fact Check Tools API
    // НЕ застосовний для ціни (фактчекери не публікують ClaimReview на
    // тему вартості об'єктів) — ціна виділяється тут звичайним
    // AI-викликом синтезу з тексту сторінки, не через Fact Check API.
    let extractedPrice: number | null = null;
    try {
      const result = await this.aiRouter.execute({
        userId,
        projectId: variant.config.projectId,
        taskType: PRICE_EXTRACT_TASK_TYPE,
        systemPrompt:
          'Тебе дан текст страницы объявления о продаже недвижимости/автомобиля. Попробуй найти цену. Если однозначно определить цену не удаётся — верни null, НЕ угадывай. Ответь СТРОГО валидным JSON вида {"extractedPrice": number|null}. Без пояснений вне JSON.',
        userPrompt: sourceText,
        jsonMode: true,
        maxTokens: 200,
        validateOutput: isValidPriceExtraction,
      });
      const parsed: RawPriceExtraction = JSON.parse(result.text);
      extractedPrice = parsed.extractedPrice;
    } catch {
      // Чесна деградація — порівняння зберігається без ціни, не падає
      // весь запит через збій одного допоміжного AI-виклику.
      extractedPrice = null;
    }

    return this.prisma.marketComparison.create({
      data: { variantId, sourceUrl, sourceText, extractedPrice },
    });
  }

  // ── Порівняльний вивід (§5.6 ТЗ) ──

  async getComparisonTable(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);

    const [variants, criteria] = await Promise.all([
      this.prisma.purchaseVariant.findMany({
        where: { configId },
        include: {
          meetings: { orderBy: { occurredAt: 'desc' }, take: 1 },
          comparisons: true,
        },
      }),
      this.prisma.quizCriterion.findMany({ where: { configId }, orderBy: { orderIndex: 'asc' } }),
    ]);

    return {
      criteria,
      variants: variants.map((v: any) => {
        const latestMeeting = v.meetings[0];
        return {
          id: v.id,
          label: v.label,
          askingPrice: v.askingPrice,
          currency: v.currency,
          placeName: v.placeName,
          placeAddress: v.placeAddress,
          latitude: v.latitude,
          longitude: v.longitude,
          comparisonCount: v.comparisons.length,
          latestConclusion: latestMeeting?.conclusionFinal ?? latestMeeting?.conclusionDraft ?? null,
          // Пункт [major-purchase] (аудит) — раніше цього поля не було
          // взагалі, "структурований розбір по критеріях" з §5.6 ТЗ не
          // виконувався. Береться з ОСТАННЬОЇ зустрічі варіанту (якщо
          // зустрічей кілька — найсвіжіший розбір актуальніший).
          // null, якщо для варіанту ще жодного разу не викликали
          // generate-conclusion — чесно, не порожній масив, що виглядав
          // би як "усі критерії unknown", коли насправді аналіз просто
          // не запускався.
          criteriaBreakdown: latestMeeting?.criteriaBreakdown ?? null,
        };
      }),
    };
  }

  // ── Читання (аудит: раніше не було жодного read-методу окрім
  // агрегованої getComparisonTable — неможливо було прочитати сам
  // конфіг, список варіантів чи деталь одного варіанту/зустрічі
  // окремо, тільки створювати) ──

  async getConfig(userId: string, projectId: string) {
    await this.assertOwnedProject(userId, projectId);
    const config = await this.prisma.majorPurchaseConfig.findUnique({
      where: { projectId },
      include: { criteria: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!config) {
      throw new NotFoundException(`MajorPurchaseConfig for project ${projectId} not found`);
    }
    return config;
  }

  async listVariants(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    return this.prisma.purchaseVariant.findMany({
      where: { configId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** На відміну від getComparisonTable (тільки остання зустріч) —
   * повна історія meetings[]/comparisons[] цього варіанту. */
  async getVariant(userId: string, variantId: string) {
    const variant = await this.assertOwnedVariant(userId, variantId);
    return this.prisma.purchaseVariant.findUnique({
      where: { id: variant.id },
      include: {
        meetings: { orderBy: { occurredAt: 'desc' } },
        comparisons: { orderBy: { createdAt: 'desc' } },
      },
    });
  }

  async getMeeting(userId: string, meetingId: string) {
    return this.assertOwnedMeeting(userId, meetingId);
  }



  private async assertOwnedProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, ownerId: userId } });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    return project;
  }

  private async assertOwnedConfig(userId: string, configId: string) {
    const config = await this.prisma.majorPurchaseConfig.findUnique({
      where: { id: configId },
      include: { project: true },
    });
    if (!config || config.project.ownerId !== userId) {
      throw new NotFoundException(`MajorPurchaseConfig ${configId} not found`);
    }
    return config;
  }

  private async assertOwnedVariant(userId: string, variantId: string) {
    const variant = await this.prisma.purchaseVariant.findUnique({
      where: { id: variantId },
      include: { config: { include: { project: true } } },
    });
    if (!variant || variant.config.project.ownerId !== userId) {
      throw new NotFoundException(`PurchaseVariant ${variantId} not found`);
    }
    return variant;
  }

  private async assertOwnedMeeting(userId: string, meetingId: string) {
    const meeting = await this.prisma.purchaseMeeting.findUnique({
      where: { id: meetingId },
      include: { variant: { include: { config: { include: { project: true } } } } },
    });
    if (!meeting || meeting.variant.config.project.ownerId !== userId) {
      throw new NotFoundException(`PurchaseMeeting ${meetingId} not found`);
    }
    return meeting;
  }
}

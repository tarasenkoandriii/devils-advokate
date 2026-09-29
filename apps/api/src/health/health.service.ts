// Пункт [health] (devils-advocate-health-tz.md §3.2/3.3/5.2-5.4).
//
// НАЙЖОРСТКІШЕ АРХІТЕКТУРНЕ ОБМЕЖЕННЯ З ЧОТИРЬОХ ПОДІБНИХ МОДУЛІВ
// (§2.1/2.4 ТЗ): FDA non-device CDS виняток структурно недоступний
// продукту (пацієнт-орієнтований) — НІКОЛИ жодного скорингу/
// сортування/оцінки, БЕЗ ЖОДНОГО ВИНЯТКУ (на відміну від Пункту
// [interview-pool], де був виняток для фізично важкої праці, і
// Пункту [investment], де Fact Check API мав окремий дозволений шлях).

import { intakeNote, type SourceIntake } from '../common/source-intake';
import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation } from '../common/unique-violation';
import { numberedTranscript, resolveSegmentRef } from '../common/transcript-prompt';
import { normalizeCurrency } from '../common/money';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { fetchUrlText, UnsafeUrlError, UrlFetchError } from '../common/safe-url-fetch';
import { extractTextFromImage, OcrError } from '../common/vision-ocr-client';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentService } from '../consent/consent.service';
import { ConsentType, HealthCriterionCategory } from '@prisma/client';
import { assertOwnedHealthProject } from './health-access';
import { ExtractedHealthConfigDraft } from './health-onboarding.service';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { allFilled, substanceSite } from '../common/claim-substance';

const BREAKDOWN_TASK_TYPE = 'health-consultation-breakdown';

// Пункт [health-lab-ocr] — за прямим запитом, після явного
// обговорення архітектурного ризику. Той самий клас суворих лімітів,
// що PhotoVerificationService (§4.4 major ТЗ) — навмисно низьке
// число, не для масового використання.
const OCR_DAILY_LIMIT_PER_USER = 10;
const MAX_IMAGE_BASE64_BYTES = 8_000_000; // ~8MB base64, той самий поріг, що PhotoVerificationService
const VISION_API_KEY_REF = 'GOOGLE_VISION_API_KEY';

// §3.2 ТЗ, буквально — ЛИШЕ criterionId/whatWasSaid/sourceSegmentId,
// НІЯКОГО covered/score/recommended полів у жодному з трьох рівнів
// (тип, Prisma-JSON, AI-промпт) — той самий формат, що
// investment.service.ts CriterionStatement, тут без жодного винятку.
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

// §3.2/3.3 ТЗ — заборона на медичну оцінку, розширена порівняно з
// investment: ТАКОЖ заборона самостійно інтерпретувати результати
// аналізів (§2.1 критерій 2 non-device CDS).
const BREAKDOWN_SYSTEM_PROMPT =
  'Тебе дано транскрипт консультації з лікарем/спеціалістом та перелік критеріїв, важливих для користувача. ' +
  'Для КОЖНОГО критерію виклади НЕЙТРАЛЬНО, що САМЕ сказав лікар по цьому пункту — whatWasSaid, з sourceSegmentId (НОМЕР репліки-джерела — число у квадратних дужках перед реплікою), якщо застосовно. ' +
  'КРИТИЧНО ВАЖЛИВО: НІКОЛИ не формулюй висновок як "варто робити операцію"/"не варто", "цей лікар правий", "цей метод лікування безпечніший чи кращий", НЕ став оцінку чи бал. ' +
  'ТАКОЖ НІКОЛИ не інтерпретуй результати аналізів/знімків самостійно — фіксуй ЛИШЕ те, що лікар сам сказав про них уголос у розмові, не роби власних медичних висновків з жодних даних. ' +
  'Якщо лікар взагалі не торкнувся критерію — чесно напиши "не піднімалось у розмові", не вигадуй. ' +
  'Відповідай СТРОГО валідним JSON вида {"criteriaBreakdown": [{"criterionId": string, "whatWasSaid": string, "sourceSegmentId": string|null}]}. Без пояснень поза ним.';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
    private readonly secrets: SecretsService,
    private readonly consent: ConsentService,
  ) {}

  // ── Конфіг (§5.1 ТЗ — фіксація чернетки онбордингу) ──

  async createConfig(userId: string, projectId: string, draft: ExtractedHealthConfigDraft) {
    await assertOwnedHealthProject(this.prisma, userId, projectId);

    const existing = await this.prisma.healthConfig.findUnique({ where: { projectId } });
    if (existing) {
      throw new BadRequestException(`Медицинский разбор для этого проекта уже настроен`);
    }
    // АУДИТ (повний аудит проєкту): та сама відсутня валідація, що
    // виправлена в investment/family-law/dtp.
    for (const c of draft.criteria) {
      if (!Object.values(HealthCriterionCategory).includes(c.category)) {
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
      return await this.prisma.healthConfig.create({
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
    } catch (err) {
      if (isUniqueViolation(err)) throw new BadRequestException(`Медицинский разбор для этого проекта уже настроен`);
      throw err;
    }
  }

  async getConfig(userId: string, projectId: string) {
    await assertOwnedHealthProject(this.prisma, userId, projectId);
    const config = await this.prisma.healthConfig.findUnique({
      where: { projectId },
      include: { criteria: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!config) {
      throw new NotFoundException(`HealthConfig for project ${projectId} not found`);
    }
    return config;
  }

  // ── Провайдери (§5.2 ТЗ — "джерело медичної думки", не "варіант лікування") ──

  async createProvider(userId: string, configId: string, label: string, providerName?: string, specialty?: string) {
    await this.assertOwnedConfig(userId, configId);
    if (!label.trim()) {
      throw new BadRequestException('label не может быть пустым');
    }
    return this.prisma.healthProvider.create({
      data: { configId, label: label.trim(), providerName, specialty },
    });
  }

  async listProviders(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    return this.prisma.healthProvider.findMany({ where: { configId }, orderBy: { createdAt: 'asc' } });
  }

  // ── Консультації (§5.2 ТЗ) ──

  async createConsultation(
    userId: string,
    providerId: string,
    conversationId: string | undefined,
    occurredAt: string,
    estimatedCost?: number,
    // Аудит денег 2026-09-03 — третий домен с тем же полем и той же
    // историей: в схеме есть, писать было некому.
    currency?: string | null,
  ) {
    const provider = await this.assertOwnedProvider(userId, providerId);
    if (conversationId) {
      const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
      if (!conversation || conversation.projectId !== provider.config.projectId) {
        throw new NotFoundException(`Conversation ${conversationId} not found`);
      }
    }
    if (estimatedCost !== undefined && estimatedCost < 0) {
      throw new BadRequestException('estimatedCost не может быть отрицательным');
    }
    return this.prisma.healthConsultation.create({
      data: { providerId, conversationId, occurredAt: new Date(occurredAt), estimatedCost, currency: normalizeCurrency(currency) },
    });
  }

  /** §3.2/3.3 ТЗ — нейтральний виклад того, що сказав лікар, БЕЗ
   * жодної оцінки/балу/рекомендації/власної інтерпретації аналізів. */
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
      this.prisma.healthQuizCriterion.findMany({
        where: { configId: consultation.provider.configId },
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
        projectId: consultation.provider.config.projectId,
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
    return this.prisma.healthConsultation.update({
      where: { id: consultationId },
      data: {
        criteriaBreakdown: criteriaBreakdown as any,
        draftedAt: new Date(),
        // АУДИТ (свіжий прохід одразу після реалізації): якщо
        // консультацію вже раз підтвердили (reviewedAt був
        // заповнений), повторна генерація розбору мовчки лишала б
        // старий reviewedAt прив'язаним до НОВОГО, ще не переглянутого
        // контенту — вводить в оману, ніби нове вже перевірено. Той
        // самий патерн успадкований з InvestmentService.generateBreakdown()
        // (сам скопійований з MajorPurchaseService.generateConclusion()),
        // не унікальний для health — виправлено тут, варте окремого
        // проходу для двох інших модулів поза обсягом цього завдання.
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
    return this.prisma.healthConsultation.update({
      where: { id: consultationId },
      data: { reviewedAt: new Date(), reviewNotes: reviewNotes ?? undefined },
    });
  }

  async listConsultations(userId: string, providerId: string) {
    await this.assertOwnedProvider(userId, providerId);
    return this.prisma.healthConsultation.findMany({ where: { providerId }, orderBy: { occurredAt: 'desc' } });
  }

  async getConsultation(userId: string, consultationId: string) {
    return this.assertOwnedConsultation(userId, consultationId);
  }

  async listSourceReferences(userId: string, providerId: string) {
    await this.assertOwnedProvider(userId, providerId);
    return this.prisma.healthSourceReference.findMany({ where: { providerId }, orderBy: { createdAt: 'desc' } });
  }

  // ── Публічні джерела (§3.3 ТЗ, знайдено при реалізації — відсутнє в §6 первинного документа) ──

  /** user-supplied URL, НЕ файл власного медичного запису (§3.3 ТЗ,
   * §2.1 критерій 2 non-device CDS) — жодної AI-екстракції з тексту,
   * тільки сирий витяг для власного прочитання користувачем. */
  async addSourceReference(userId: string, providerId: string, sourceUrl: string) {
    await this.assertOwnedProvider(userId, providerId);

    let sourceText: string;
    let sourceIntake: SourceIntake;
    try {
      ({ text: sourceText, intake: sourceIntake } = await fetchUrlText(sourceUrl));
    } catch (err) {
      if (err instanceof UnsafeUrlError || err instanceof UrlFetchError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    // Пункт [stored-text-cut] 2026-09-06: если страница вошла не
    // целиком, человек узнаёт об этом рядом с самим текстом, а не
    // догадывается по обрыву на полуслове.
    const created = await this.prisma.healthSourceReference.create({
      data: { providerId, sourceUrl, sourceText },
    });
    return { ...created, intakeNote: intakeNote(sourceIntake) };
  }

  // ── Чернетка OCR результатів аналізів (Пункт [health-lab-ocr], за прямим запитом) ──
  //
  // НАЙВАЖЛИВІША ГАРАНТІЯ ЦЬОГО РОЗДІЛУ: жоден метод тут НІКОЛИ не
  // викликається з generateBreakdown() чи будь-якого іншого AI-виклику
  // цього сервісу. HealthLabDocumentDraft — повністю ізольована модель,
  // не має жодного зв'язку з HealthConsultation. Це свідома, явно
  // обговорена зміна первинного архітектурного рішення §3.3 ТЗ
  // ("продукт НЕ приймає файл результату аналізу") — ризик названо
  // прямо, підтверджено користувачем, реалізовано з максимально
  // жорсткими гарантіями: чернетка НІКОЛИ не вважається фактом
  // (`verified` за замовчуванням false), НІКОЛИ не персистує сам
  // файл/зображення (тільки видобутий текст), НІКОЛИ не потрапляє в
  // жоден AI-промпт цього сервісу.

  /** base64Content — БЕЗ префіксу "data:image/...;base64,". Сам
   * контент НІКОЛИ не персистується — передається напряму в OCR-
   * провайдер і одразу відкидається, зберігається тільки видобутий
   * текст. */
  async uploadLabDocument(userId: string, configId: string, base64Content: string) {
    const config = await this.assertOwnedConfig(userId, configId);

    if (base64Content.length > MAX_IMAGE_BASE64_BYTES) {
      throw new BadRequestException('Файл занадто великий (максимум ~8MB)');
    }

    // Зображення йде зовнішньому OCR-провайдеру (Google Cloud
    // Vision) — той самий клас ризику, що вже покриває EXTERNAL_AI
    // для будь-якого AI-виклику продукту, не новий тип згоди.
    await this.consent.requireConsent(userId, ConsentType.EXTERNAL_AI, config.projectId);
    await this.assertUnderOcrRateLimit(userId);

    const apiKey = await this.secrets.resolve(VISION_API_KEY_REF);
    let ocrText: string;
    try {
      ocrText = await extractTextFromImage(base64Content, apiKey);
    } catch (err) {
      if (err instanceof OcrError) {
        throw new BadGatewayException(`Не удалось распознать текст: ${err.message}`);
      }
      throw err;
    }

    // verified: false ЗАВЖДИ при створенні — жодного шляху обійти
    // явне підтвердження користувача.
    return this.prisma.healthLabDocumentDraft.create({
      data: { configId, ocrText, verified: false },
    });
  }

  async listLabDocuments(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    return this.prisma.healthLabDocumentDraft.findMany({ where: { configId }, orderBy: { createdAt: 'desc' } });
  }

  /** Єдина дія, що змінює verified — виключно явний, окремий виклик
   * користувача. Жодного побічного шляху (наприклад через review
   * консультації) не встановлює це поле. */
  async verifyLabDocument(userId: string, draftId: string) {
    const draft = await this.prisma.healthLabDocumentDraft.findUnique({ where: { id: draftId } });
    if (!draft) {
      throw new NotFoundException(`HealthLabDocumentDraft ${draftId} not found`);
    }
    await this.assertOwnedConfig(userId, draft.configId);
    return this.prisma.healthLabDocumentDraft.update({
      where: { id: draftId },
      data: { verified: true, verifiedAt: new Date() },
    });
  }

  // Лимит OCR — на пользователя, не на проект (см. SANDBOX-COVERAGE.md):
  // projectId в подсчёте не участвовал и убран из сигнатуры, чтобы не
  // выглядело лимитом «10 в сутки на каждый проект».
  private async assertUnderOcrRateLimit(userId: string) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.prisma.healthLabDocumentDraft.count({
      where: { config: { project: { ownerId: userId } }, createdAt: { gte: since } },
    });
    if (count >= OCR_DAILY_LIMIT_PER_USER) {
      throw new ForbiddenException(`Достигнут суточный лимит распознавания документов (${OCR_DAILY_LIMIT_PER_USER}/сутки)`);
    }
  }

  // ── Порівняльний вивід (§3.2/5.4 ТЗ) — БЕЗ жодного score/rank, без винятку ──

  async getComparisonTable(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);

    const [providers, criteria] = await Promise.all([
      this.prisma.healthProvider.findMany({
        where: { configId },
        include: {
          consultations: { orderBy: { occurredAt: 'desc' } },
          sourceReferences: true,
        },
      }),
      this.prisma.healthQuizCriterion.findMany({ where: { configId }, orderBy: { orderIndex: 'asc' } }),
    ]);

    return {
      criteria,
      // Структурно ВІДСУТНЄ будь-яке поле score/rank/sortedBy.
      providers: providers.map((p: any) => ({
        id: p.id,
        label: p.label,
        providerName: p.providerName,
        specialty: p.specialty,
        consultationsCount: p.consultations.length,
        sourceReferenceCount: p.sourceReferences.length,
        latestBreakdown: p.consultations[0]?.criteriaBreakdown ?? null,
      })),
    };
  }

  // ── Приватні перевірки власності ──

  private async assertOwnedConfig(userId: string, configId: string) {
    const config = await this.prisma.healthConfig.findUnique({ where: { id: configId } });
    if (!config) {
      throw new NotFoundException(`HealthConfig ${configId} not found`);
    }
    await assertOwnedHealthProject(this.prisma, userId, config.projectId);
    return config;
  }

  private async assertOwnedProvider(userId: string, providerId: string) {
    const provider = await this.prisma.healthProvider.findUnique({
      where: { id: providerId },
      include: { config: true },
    });
    if (!provider) {
      throw new NotFoundException(`HealthProvider ${providerId} not found`);
    }
    await assertOwnedHealthProject(this.prisma, userId, provider.config.projectId);
    return provider;
  }

  private async assertOwnedConsultation(userId: string, consultationId: string) {
    const consultation = await this.prisma.healthConsultation.findUnique({
      where: { id: consultationId },
      include: { provider: { include: { config: true } } },
    });
    if (!consultation) {
      throw new NotFoundException(`HealthConsultation ${consultationId} not found`);
    }
    await assertOwnedHealthProject(this.prisma, userId, consultation.provider.config.projectId);
    return consultation;
  }
}

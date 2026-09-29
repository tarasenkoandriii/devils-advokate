// Пункт [dtp] (devils-advocate-dtp-tz.md §3.1-3.5/5.2-5.5).
//
// НАЙВАЖЛИВІШЕ ОБМЕЖЕННЯ ЦЬОГО ФАЙЛУ: `DtpEvidenceItem` НІКОЛИ не
// проходить через жоден AI-виклик — чисте зберігання з метаданими
// (§3.3 ТЗ). AI-виклик generateBreakdown() НІКОЛИ не формулює
// висновок про винуватця ДТП (§1/§3.2 ТЗ, той самий принцип "радник,
// не суддя", що в чотирьох попередніх модулях).

import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation } from '../common/unique-violation';
import { numberedTranscript, resolveSegmentRef } from '../common/transcript-prompt';
import { MoneyLike, sumByCurrency, normalizeCurrency } from '../common/money';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConsentService } from '../consent/consent.service';
import { SecretsService } from '../secrets/secrets.service';
import { putPrivateBlob, VercelBlobError } from '../common/vercel-blob';
import { ConsentType, DtpEvidenceMediaType, DtpCriterionCategory } from '@prisma/client';
import { assertOwnedDtpProject } from './dtp-access';
import { ExtractedDtpConfigDraft } from './dtp-onboarding.service';
import { resolveBlobToken } from '../common/blob-token';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { LOCATION_PURPOSES } from '../consent/location-purposes';
import { allFilled, substanceSite } from '../common/claim-substance';

const BREAKDOWN_TASK_TYPE = 'dtp-consultation-breakdown';
// 2026-08-31: резолв токена перенесён в common/blob-token.ts — Vercel
// сам создаёт переменную под именем BLOB_READ_WRITE_TOKEN (без
// префикса), см. объяснение там.
const MAX_EVIDENCE_BASE64_BYTES = 60_000_000; // ~60MB base64 — з запасом під коротке відео, суворіший ліміт за фото (Пункт [health-lab-ocr] 8MB)

// §3.3 ТЗ, буквально — ЛИШЕ criterionId/whatWasSaid/sourceSegmentId,
// той самий формат, що health/family-law/investment.
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

// §1/§3.2 ТЗ — заборона на висновок про винуватця, той самий метод,
// що UPL-заборона в family-law/медична заборона в health.
const BREAKDOWN_SYSTEM_PROMPT =
  'Тебе дано транскрипт консультації зі страховим агентом/юристом/експертом-оцінювачем та перелік критеріїв, важливих для користувача. ' +
  'Для КОЖНОГО критерію виклади НЕЙТРАЛЬНО, що САМЕ сказав фахівець по цьому пункту — whatWasSaid, з sourceSegmentId (НОМЕР репліки-джерела — число у квадратних дужках перед реплікою), якщо застосовно. ' +
  'КРИТИЧНО ВАЖЛИВО: НІКОЛИ не формулюй власний висновок про те, хто винен у ДТП, НЕ став оцінку чи бал, НЕ давай юридичну пораду від свого імені. ' +
  'Якщо фахівець взагалі не торкнувся критерію — чесно напиши "не піднімалось у розмові", не вигадуй. ' +
  'Відповідай СТРОГО валідним JSON вида {"criteriaBreakdown": [{"criterionId": string, "whatWasSaid": string, "sourceSegmentId": string|null}]}. Без пояснень поза ним.';

@Injectable()
export class DtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
    private readonly consent: ConsentService,
    private readonly secrets: SecretsService,
  ) {}

  // ── Конфіг (§5.1 ТЗ) ──

  async createConfig(userId: string, projectId: string, draft: ExtractedDtpConfigDraft) {
    await assertOwnedDtpProject(this.prisma, userId, projectId);

    const existing = await this.prisma.dtpConfig.findUnique({ where: { projectId } });
    if (existing) {
      throw new BadRequestException(`Разбор ДТП для этого проекта уже настроен`);
    }
    // АУДИТ (повний аудит проєкту): та сама відсутня валідація, що
    // виправлена в investment/health/family-law.
    for (const c of draft.criteria) {
      if (!Object.values(DtpCriterionCategory).includes(c.category)) {
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
      return await this.prisma.dtpConfig.create({
        data: {
          projectId,
          goalDescription: draft.goalDescription,
          targetBudget: draft.targetBudget ?? undefined,
          currency: draft.currency ?? undefined,
          occurredAt: draft.occurredAt ? new Date(draft.occurredAt) : undefined,
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
      if (isUniqueViolation(err)) throw new BadRequestException(`Разбор ДТП для этого проекта уже настроен`);
      throw err;
    }
  }

  async getConfig(userId: string, projectId: string) {
    await assertOwnedDtpProject(this.prisma, userId, projectId);
    const config = await this.prisma.dtpConfig.findUnique({
      where: { projectId },
      include: { criteria: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!config) {
      throw new NotFoundException(`DtpConfig for project ${projectId} not found`);
    }
    return config;
  }

  // ── Фахівці (§5.3 ТЗ — "джерело фахової думки") ──

  async createAdvisor(userId: string, configId: string, label: string, advisorName?: string, role?: string) {
    await this.assertOwnedConfig(userId, configId);
    if (!label.trim()) {
      throw new BadRequestException('label не может быть пустым');
    }
    return this.prisma.dtpAdvisor.create({
      data: { configId, label: label.trim(), advisorName, role },
    });
  }

  async listAdvisors(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    return this.prisma.dtpAdvisor.findMany({ where: { configId }, orderBy: { createdAt: 'asc' } });
  }

  // ── Консультації (§5.3 ТЗ) ──

  async createConsultation(
    userId: string,
    advisorId: string,
    conversationId: string | undefined,
    occurredAt: string,
    estimatedCost?: number,
    // Аудит денег 2026-09-03: поле есть в схеме с ТЗ dtp-v2, но его никто
    // не записывал — то есть «своя валюта расхода» существовала только на
    // бумаге. null = валюта проекта, это документированное значение.
    currency?: string | null,
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
    return this.prisma.dtpConsultation.create({
      data: { advisorId, conversationId, occurredAt: new Date(occurredAt), estimatedCost, currency: normalizeCurrency(currency) },
    });
  }

  async listConsultations(userId: string, advisorId: string) {
    await this.assertOwnedAdvisor(userId, advisorId);
    return this.prisma.dtpConsultation.findMany({ where: { advisorId }, orderBy: { occurredAt: 'desc' } });
  }

  async getConsultation(userId: string, consultationId: string) {
    return this.assertOwnedConsultation(userId, consultationId);
  }

  /** §3.2/§1 ТЗ — нейтральний виклад того, що сказав фахівець, БЕЗ
   * жодного висновку про винуватця/оцінки/рекомендації. */
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
      this.prisma.dtpCriterion.findMany({
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
    return this.prisma.dtpConsultation.update({
      where: { id: consultationId },
      data: {
        criteriaBreakdown: criteriaBreakdown as any,
        draftedAt: new Date(),
        // Той самий фікс, що вже застосований у health/family-law з
        // першого проходу — повторна генерація очищує старий
        // reviewedAt/reviewNotes.
        reviewedAt: null,
        reviewNotes: null,
      },
    });
  }

  async reviewConsultation(userId: string, consultationId: string, reviewNotes?: string) {
    const consultation = await this.assertOwnedConsultation(userId, consultationId);
    if (!consultation.draftedAt) {
      throw new BadRequestException('Нельзя подтвердить разбор, который никогда не был сгенерирован — сначала вызовите generate-breakdown');
    }
    return this.prisma.dtpConsultation.update({
      where: { id: consultationId },
      data: { reviewedAt: new Date(), reviewNotes: reviewNotes ?? undefined },
    });
  }

  // ── Доказова фіксація (§3.1/3.3/3.4/5.2 ТЗ) ──

  /** §3.1 ТЗ, центральне рішення документа — video-only за
   * замовчуванням. §0 ТЗ, аудит-фікс: mediaType="PHOTO" ПРИМУСОВО
   * скидає hasAudio до false незалежно від вхідного значення.
   *
   * АУДИТ ОДРАЗУ ПІСЛЯ РЕАЛІЗАЦІЇ, свіжий прохід, знайшов найважливішу
   * знахідку цього проходу: первинна версія приймала `blobUrl` як
   * рядок ВІД КЛІЄНТА й довіряла йому — `putPrivateBlob()` (§3.4 ТЗ)
   * була реалізована, але НІКОЛИ не викликалась. Клієнт фізично не
   * може мати секретний BLOB_READ_WRITE_TOKEN, тож client-supplied
   * blobUrl не гарантував, що доказ справді пройшов через приватне
   * сховище продукту — міг вказувати куди завгодно. Переписано:
   * метод приймає СИРИЙ base64-вміст, обчислює SHA-256 на СЕРВЕРІ (не
   * довіряє клієнтському хешу — той самий клас проблеми довіри),
   * завантажує через putPrivateBlob(), і лише тоді створює запис. */
  async createEvidence(
    userId: string,
    configId: string,
    mediaType: DtpEvidenceMediaType,
    hasAudioInput: boolean,
    base64Content: string,
    contentType: string,
    capturedAt: string,
    latitude?: number,
    longitude?: number,
  ) {
    const config = await this.assertOwnedConfig(userId, configId);

    if (!Object.values(DtpEvidenceMediaType).includes(mediaType)) {
      throw new BadRequestException(`Неизвестный тип медиа: ${mediaType}`);
    }
    if (!base64Content.trim()) {
      throw new BadRequestException('base64Content не может быть пустым');
    }
    if (base64Content.length > MAX_EVIDENCE_BASE64_BYTES) {
      throw new BadRequestException('Файл занадто великий (максимум ~60MB)');
    }
    if ((latitude === undefined) !== (longitude === undefined)) {
      throw new BadRequestException('latitude и longitude должны передаваться вместе, не по отдельности');
    }

    const hasAudio = mediaType === DtpEvidenceMediaType.PHOTO ? false : hasAudioInput;

    if (hasAudio) {
      // §3.2 ТЗ — окремий тип згоди, не RECORDING/EXTERNAL_AI.
      await this.consent.requireConsent(userId, ConsentType.THIRD_PARTY_AUDIO_RECORDING, config.projectId);
    }
    if (latitude !== undefined) {
      // Той самий принцип, що решта продукту — гео вимагає ConsentType.LOCATION.
      await this.consent.requireConsent(userId, ConsentType.LOCATION, config.projectId, LOCATION_PURPOSES.DTP_EVIDENCE);
    }

    const buffer = Buffer.from(base64Content, 'base64');
    // Хеш обчислюється на СЕРВЕРІ з реального вмісту — гарантія
    // цілісності, не клієнтське твердження (§3.4 ТЗ "chain of custody").
    const fileHash = createHash('sha256').update(buffer).digest('hex');

    const token = await resolveBlobToken(this.secrets);
    const pathname = `dtp-evidence/${configId}/${fileHash}`;
    let blobResult;
    try {
      blobResult = await putPrivateBlob(token, pathname, buffer, contentType);
    } catch (err) {
      if (err instanceof VercelBlobError) {
        // Пункт [letters-were-not-the-language] 2026-09-24: вторая из
        // двух фраз, которые прежняя сверка языка не видела.
        throw new BadGatewayException(`Не удалось сохранить доказательство: ${err.message}`);
      }
      throw err;
    }

    return this.prisma.dtpEvidenceItem.create({
      data: {
        configId,
        mediaType,
        hasAudio,
        blobUrl: blobResult.url,
        fileHash,
        capturedAt: new Date(capturedAt),
        latitude,
        longitude,
      },
    });
  }

  async listEvidence(userId: string, configId: string) {
    await this.assertOwnedConfig(userId, configId);
    return this.prisma.dtpEvidenceItem.findMany({ where: { configId }, orderBy: { capturedAt: 'desc' } });
  }

  async getEvidence(userId: string, evidenceId: string) {
    const evidence = await this.prisma.dtpEvidenceItem.findUnique({
      where: { id: evidenceId },
      include: { config: true },
    });
    if (!evidence) {
      throw new NotFoundException(`DtpEvidenceItem ${evidenceId} not found`);
    }
    await assertOwnedDtpProject(this.prisma, userId, evidence.config.projectId);
    return evidence;
  }

  // ── Порівняльний вивід + бюджет (§5.4/5.5 ТЗ, аудит-фікс) — БЕЗ жодного score/rank ──

  async getComparisonTable(userId: string, configId: string) {
    const config = await this.assertOwnedConfig(userId, configId);

    const [advisors, criteria, consultations] = await Promise.all([
      this.prisma.dtpAdvisor.findMany({
        where: { configId },
        include: { consultations: { orderBy: { occurredAt: 'desc' } } },
      }),
      this.prisma.dtpCriterion.findMany({ where: { configId }, orderBy: { orderIndex: 'asc' } }),
      this.prisma.dtpConsultation.findMany({ where: { advisor: { configId } } }),
    ]);

    // §5.5 ТЗ — чиста арифметична сума, той самий принцип, що
    // InvestmentGroupService.getProjectProgress().
    //
    // АУДИТ ДЕНЕГ 2026-09-03: раньше это была ОДНА сумма по всем
    // консультациям, а показывалась она с валютой проекта. При этом у
    // самой консультации есть своя валюта — поле добавлено ТЗ dtp-v2
    // именно затем, чтобы прекратить молчаливое допущение «всё в валюте
    // конфига», — и его никто не читал. Оценка юриста в долларах и оценка
    // эксперта в гривнах складывались в одно число с подписью «₴»: не
    // «неточность», а уверенно показанная неправда.
    const estimatedCostByCurrency = sumByCurrency(
      consultations.map((c: { estimatedCost: MoneyLike; currency?: string | null }) => ({ amount: c.estimatedCost, currency: c.currency })),
      config.currency,
    );
    // Одно число отдаём ТОЛЬКО когда валюта одна: иначе интерфейсу нечего
    // подписать, и он обязан показать разбивку, а не «итого».
    const totalEstimatedCost = estimatedCostByCurrency.length === 1 ? estimatedCostByCurrency[0].total : null;

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
      budget: {
        targetBudget: config.targetBudget,
        currency: config.currency,
        totalEstimatedCost,
        estimatedCostByCurrency,
      },
    };
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

  private async assertOwnedAdvisor(userId: string, advisorId: string) {
    const advisor = await this.prisma.dtpAdvisor.findUnique({
      where: { id: advisorId },
      include: { config: true },
    });
    if (!advisor) {
      throw new NotFoundException(`DtpAdvisor ${advisorId} not found`);
    }
    await assertOwnedDtpProject(this.prisma, userId, advisor.config.projectId);
    return advisor;
  }

  private async assertOwnedConsultation(userId: string, consultationId: string) {
    const consultation = await this.prisma.dtpConsultation.findUnique({
      where: { id: consultationId },
      include: { advisor: { include: { config: true } } },
    });
    if (!consultation) {
      throw new NotFoundException(`DtpConsultation ${consultationId} not found`);
    }
    await assertOwnedDtpProject(this.prisma, userId, consultation.advisor.config.projectId);
    return consultation;
  }
}

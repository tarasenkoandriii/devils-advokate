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
import { MoneyLike, sumMoney } from '../common/money';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConsentService } from '../consent/consent.service';
import { SecretsService } from '../secrets/secrets.service';
import { putPrivateBlob, VercelBlobError } from '../common/vercel-blob';
import { ConsentType, DtpEvidenceMediaType, DtpCriterionCategory } from '@prisma/client';
import { assertOwnedDtpProject } from './dtp-access';
import { ExtractedDtpConfigDraft } from './dtp-onboarding.service';
import { resolveBlobToken } from '../common/blob-token';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

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

// §1/§3.2 ТЗ — заборона на висновок про винуватця, той самий метод,
// що UPL-заборона в family-law/медична заборона в health.
const BREAKDOWN_SYSTEM_PROMPT =
  'Тебе дано транскрипт консультації зі страховим агентом/юристом/експертом-оцінювачем та перелік критеріїв, важливих для користувача. ' +
  'Для КОЖНОГО критерію виклади НЕЙТРАЛЬНО, що САМЕ сказав фахівець по цьому пункту — whatWasSaid, з sourceSegmentId (id репліки-джерела), якщо застосовно. ' +
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
      throw new BadRequestException(`DtpConfig for project ${projectId} already exists`);
    }
    // АУДИТ (повний аудит проєкту): та сама відсутня валідація, що
    // виправлена в investment/health/family-law.
    for (const c of draft.criteria) {
      if (!Object.values(DtpCriterionCategory).includes(c.category)) {
        throw new BadRequestException(`Unknown criterion category: ${c.category}`);
      }
    }

    return this.prisma.dtpConfig.create({
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
      data: { advisorId, conversationId, occurredAt: new Date(occurredAt), estimatedCost },
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
      throw new BadRequestException('Транскрипт цієї консультації ще порожній — нечего аналізувати');
    }

    const transcriptText = segments.map((s: { id: string; text: string }) => `[id=${s.id}] ${s.text}`).join('\n');
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
    return this.prisma.dtpConsultation.update({
      where: { id: consultationId },
      data: {
        criteriaBreakdown: parsed.criteriaBreakdown as any,
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
      throw new BadRequestException(`Unknown mediaType: ${mediaType}`);
    }
    if (!base64Content.trim()) {
      throw new BadRequestException('base64Content не может быть пустым');
    }
    if (base64Content.length > MAX_EVIDENCE_BASE64_BYTES) {
      throw new BadRequestException('Файл занадто великий (максимум ~60MB)');
    }
    if ((latitude === undefined) !== (longitude === undefined)) {
      throw new BadRequestException('latitude і longitude мають бути передані разом, не окремо');
    }

    const hasAudio = mediaType === DtpEvidenceMediaType.PHOTO ? false : hasAudioInput;

    if (hasAudio) {
      // §3.2 ТЗ — окремий тип згоди, не RECORDING/EXTERNAL_AI.
      await this.consent.requireConsent(userId, ConsentType.THIRD_PARTY_AUDIO_RECORDING, config.projectId);
    }
    if (latitude !== undefined) {
      // Той самий принцип, що решта продукту — гео вимагає ConsentType.LOCATION.
      await this.consent.requireConsent(userId, ConsentType.LOCATION, config.projectId);
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
        throw new BadGatewayException(`Не вдалося зберегти доказ: ${err.message}`);
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

    // §5.5 ТЗ — АУДИТ-ФІКС: чиста арифметична сума, той самий
    // принцип, що InvestmentGroupService.getProjectProgress().
    const totalEstimatedCost = sumMoney(consultations.map((c: { estimatedCost: MoneyLike }) => c.estimatedCost));

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

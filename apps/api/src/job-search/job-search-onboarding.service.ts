// Пункт [job-search] 2026-09-01 — онбординг домена кандидата на поиск
// работы (по прямому запросу: «формирование CV + ИИ-поиск работы под
// это CV по локальным джоб-сайтам в том же регионе/городе со
// статистикой вакансий»). Тот же текстовый путь без STT, что уже
// четырежды реализован (major-purchase/interview-pool/investment/
// family-law): Project создаётся ПЕРЕД онбордингом, ответы —
// TranscriptSegment'ами, extract — один LLM-вызов со строгой схемой.

import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ProjectMode, JobSearchCriterionCategory } from '@prisma/client';
import { assertOwnedJobSearchProject } from './job-search-access';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { ensureOnboardingConversation } from '../common/onboarding-conversation';

const TASK_TYPE = 'job-search-onboarding-extract';

export interface ExtractedJobCriterion {
  text: string;
  category: JobSearchCriterionCategory;
  isRequired: boolean;
  orderIndex: number;
}

export interface ExtractedJobSearchConfigDraft {
  desiredRole: string;
  city: string | null;
  region: string | null;
  salaryExpectation: number | null;
  currency: string | null;
  employmentFormat: string | null;
  experienceSummary: string | null;
  criteria: ExtractedJobCriterion[];
}

interface RawExtraction {
  desiredRole: string;
  city?: string | null;
  region?: string | null;
  salaryExpectation?: number | null;
  currency?: string | null;
  employmentFormat?: string | null;
  experienceSummary?: string | null;
  criteria: Array<{ text: string; category?: string; isRequired?: boolean }>;
}

function isValidExtraction(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return false;
    if (typeof parsed.desiredRole !== 'string' || parsed.desiredRole.trim().length === 0) return false;
    if (!Array.isArray(parsed.criteria)) return false;
    return parsed.criteria.every((c: any) => typeof c?.text === 'string' && c.text.trim().length > 0);
  } catch {
    return false;
  }
}

// Город/регион извлекаются В ТОМ ВИДЕ, в каком их назвал пользователь —
// без обогащения (никаких «угаданных» областей по городу: тот же
// принцип stated-not-inferred, что во всём проекте). Критерии — по
// четырём категориям, честная деградация до меньшего числа.
const SYSTEM_PROMPT =
  'Тебе дан транскрипт онбординг-разговора кандидата, который ищет работу. Извлеки: desiredRole (желаемая роль/должность, коротко), ' +
  'city и region (город и регион поиска РОВНО так, как их назвал кандидат; если не называл — null, НЕ угадывай регион по городу), ' +
  'salaryExpectation/currency (ожидания по зарплате, если названы, иначе null), employmentFormat (офис/гибрид/удалёнка/график — как сказано, иначе null), ' +
  'experienceSummary (краткая связная выжимка опыта и навыков кандидата ИЗ ЕГО СЛОВ — материал для CV, 3-6 предложений; если об опыте не говорил — null), ' +
  'и criteria — массив критериев поиска, каждый с category: "ROLE_FIT" (соответствие роли/стеку), "COMPENSATION" (зарплата/бонусы), ' +
  '"LOCATION" (город/удалёнка), "CONDITIONS" (график/формат/соцпакет), "OTHER", и isRequired (true если кандидат назвал это обязательным). ' +
  'НЕ добавляй критериев, которых не было в разговоре — меньше критериев честнее выдуманных. ' +
  'Ответь СТРОГО валидным JSON без пояснений вне него.';

@Injectable()
export class JobSearchOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async createProject(userId: string, question: string) {
    if (!question.trim()) {
      throw new BadRequestException('question не может быть пустым');
    }
    return this.prisma.project.create({
      data: { ownerId: userId, question: question.trim(), mode: ProjectMode.JOB_SEARCH },
    });
  }

  async createOnboardingConversation(userId: string, projectId: string) {
    await assertOwnedJobSearchProject(this.prisma, userId, projectId);

    // Пункт [onboarding-continuity] 2026-09-02: разговор ОДИН на проект.
    // Раньше каждый вызов создавал новый, и ответы голосового квиза
    // оставались в первом, недостижимом с экрана домена (см. хелпер).
    return ensureOnboardingConversation(this.prisma, projectId);
  }

  async appendAnswer(userId: string, conversationId: string, text: string) {
    if (!text.trim()) {
      throw new BadRequestException('text не может быть пустым');
    }
    await this.assertOwnedConversation(userId, conversationId);
    const transcript = await this.prisma.transcript.findUnique({ where: { conversationId } });
    if (!transcript) {
      throw new NotFoundException(`Transcript for conversation ${conversationId} not found`);
    }
    const participant = await this.prisma.conversationParticipant.findFirst({ where: { conversationId, isSelf: true } });
    const lastSegment = await this.prisma.transcriptSegment.findFirst({
      where: { transcriptId: transcript.id },
      orderBy: { endMs: 'desc' },
    });
    const startMs = (lastSegment?.endMs ?? 0) + 1;

    return this.prisma.transcriptSegment.create({
      data: { transcriptId: transcript.id, participantId: participant?.id ?? null, text: text.trim(), startMs, endMs: startMs },
    });
  }

  async extract(userId: string, conversationId: string): Promise<ExtractedJobSearchConfigDraft> {
    const conversation = await this.assertOwnedConversation(userId, conversationId);
    const transcript = await this.prisma.transcript.findUnique({
      where: { conversationId },
      include: { segments: { orderBy: { startMs: 'asc' } } },
    });
    if (!transcript || transcript.segments.length === 0) {
      throw new BadRequestException('В этом онбординг-разговоре пока нет ответов — нечего извлекать');
    }

    const transcriptText = transcript.segments.map((s: { text: string }) => s.text).join('\n');

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId: conversation.projectId,
        taskType: TASK_TYPE,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: transcriptText,
        jsonMode: true,
        maxTokens: 1500,
        validateOutput: isValidExtraction,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Извлечение отклонено проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось извлечь конфиг — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const raw: RawExtraction = JSON.parse(result.text);
    const validCategories = Object.values(JobSearchCriterionCategory) as string[];
    return {
      desiredRole: raw.desiredRole.trim(),
      city: raw.city?.trim() || null,
      region: raw.region?.trim() || null,
      salaryExpectation: typeof raw.salaryExpectation === 'number' ? raw.salaryExpectation : null,
      currency: raw.currency?.trim() || null,
      employmentFormat: raw.employmentFormat?.trim() || null,
      experienceSummary: raw.experienceSummary?.trim() || null,
      criteria: raw.criteria.map((c, i) => ({
        text: c.text.trim(),
        category: (validCategories.includes(c.category ?? '') ? c.category : JobSearchCriterionCategory.OTHER) as JobSearchCriterionCategory,
        isRequired: c.isRequired ?? false,
        orderIndex: i,
      })),
    };
  }

  private async assertOwnedConversation(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { project: true },
    });
    if (!conversation || conversation.project.ownerId !== userId || conversation.project.mode !== ProjectMode.JOB_SEARCH) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }
}

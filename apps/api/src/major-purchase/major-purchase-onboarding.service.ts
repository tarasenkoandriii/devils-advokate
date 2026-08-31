// Пункт [major-purchase] (devils-advocate-major-purchase-tz.md §5.1):
// онбордінг-квіз — "дуже важливо, буквально по запросу" (найвищий
// пріоритет реалізації в самому ТЗ).
//
// ТЕКСТОВИЙ ШЛЯХ, НЕ ГОЛОСОВИЙ — свідомий вибір при реалізації, не
// буквальне прочитання ТЗ. §5.1 документа описував "жива розмова АБО
// текстова форма — рівноправні альтернативи". Голосовий шлях вимагав
// би підключення STT-конвеєра (окрема, вже наявна в проекті
// інфраструктура з іншими залежностями) лише заради одного onboarding-
// кроку — тут переюзано вже наявний паттерн TEXT_IMPORT
// (ChatImportService) для прямого запису тексту як TranscriptSegment
// без STT, той самий підхід, що вже задокументований у коментарі над
// ChatImportService: "TEXT_IMPORT — той самий аналітичний конвеєр, що
// аудіо, але без кроку транскрибації, текст вже текст".
//
// PROJECT СТВОРЮЄТЬСЯ ПЕРЕД ONBOARDING-РОЗМОВОЮ, НЕ ПІСЛЯ — реальна
// розбіжність з ТЗ, знайдена при реалізації: Conversation.projectId
// обов'язковий (не nullable) у схемі, ТЗ §6 API contract помилково
// проєктував projectId як опційний параметр onboarding-ендпоінта
// (ніби розмова може передувати проєкту). Виправлено: окремий
// ендпоінт createProject() спершу створює Project(mode=MAJOR_PURCHASE),
// онбордінг-розмова далі прив'язана до вже існуючого проєкту.

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConversationProcessingStatus, ConversationSourceType, ProjectMode, PurchaseCategory } from '@prisma/client';
import { getOnboardingChecklist } from './major-purchase-checklist';

const TASK_TYPE = 'major-purchase-onboarding-extract';
const CHECKLIST_TASK_TYPE = 'major-purchase-onboarding-checklist';

function isValidChecklist(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === 'string' && item.trim().length > 0);
  } catch {
    return false;
  }
}

function buildChecklistSystemPrompt(category: PurchaseCategory): string {
  const categoryLabel = category === PurchaseCategory.REAL_ESTATE ? 'нерухомості' : 'автомобіля';
  return (
    `Тебе дано короткий бриф користувача про мету й бюджет покупки ${categoryLabel}. ` +
    'Сформуй персоналізований чек-лист із 8-12 пунктів для подальшої розмови — тем, які варто ' +
    'обов\'язково уточнити саме під ЦЕЙ конкретний бюджет/ціль (наприклад, для дорогого сегменту ' +
    'варто питати про додаткові сервіси/статусні деталі, для економного — про приховані витрати/ризики). ' +
    'НЕ повертай узагальнений список тем, які підійшли б будь-кому — кожен пункт має бути релевантний ' +
    'саме до того, що сказав користувач у брифі. Відповідай СТРОГО валідним JSON-масивом рядків. Без пояснень поза ним.'
  );
}


export interface ExtractedCriterion {
  text: string;
  isRequired: boolean;
  orderIndex: number;
}

export interface ExtractedConfigDraft {
  goalDescription: string;
  budgetMin: number | null;
  budgetMax: number | null;
  currency: string | null;
  financingMethod: string | null;
  timeline: string | null;
  criteria: ExtractedCriterion[];
}

interface RawExtraction {
  goalDescription: string;
  budgetMin?: number | null;
  budgetMax?: number | null;
  currency?: string | null;
  financingMethod?: string | null;
  timeline?: string | null;
  criteria: Array<{ text: string; isRequired?: boolean }>;
}

function isValidExtraction(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return false;
    if (typeof parsed.goalDescription !== 'string' || parsed.goalDescription.trim().length === 0) return false;
    if (!Array.isArray(parsed.criteria) || parsed.criteria.length === 0) return false;
    return parsed.criteria.every((c: any) => typeof c?.text === 'string' && c.text.trim().length > 0);
  } catch {
    return false;
  }
}

function buildSystemPrompt(category: PurchaseCategory): string {
  const categoryLabel = category === PurchaseCategory.REAL_ESTATE ? 'нерухомості' : 'автомобіля';
  return (
    `Тебе дано транскрипт онбордінг-розмови про пошук ${categoryLabel} для покупки. ` +
    'Витягни структуровану чернетку цілі покупки: goalDescription (короткий опис того, що саме шукає користувач, вільним текстом), ' +
    'budgetMin/budgetMax (числа, якщо названі, інакше null), currency (код валюти, якщо названо), ' +
    'financingMethod (спосіб фінансування, якщо згадано), timeline (терміновість, якщо згадано), ' +
    'і criteria — масив з 10-20 конкретних критеріїв пошуку, кожен з text (сам критерій) та isRequired (true, якщо користувач назвав це критично важливим, false якщо "бажано"/"було б непогано"). ' +
    'НЕ додавай критеріїв, яких не було в розмові — якщо інформації мало, поверни менше критеріїв, чесно, не вигадуй. ' +
    'Відповідай СТРОГО валідним JSON без пояснень поза ним.'
  );
}

@Injectable()
export class MajorPurchaseOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  /** Окремий крок перед онбордінгом (розбіжність із ТЗ §6, виправлена
   * при реалізації — див. коментар над файлом). */
  async createProject(userId: string, question: string) {
    if (!question.trim()) {
      throw new BadRequestException('question не может быть пустым');
    }
    return this.prisma.project.create({
      data: { ownerId: userId, question: question.trim(), mode: ProjectMode.MAJOR_PURCHASE },
    });
  }

  /** По прямому запросу — чек-лист став ДИНАМІЧНИМ, не тільки фінальні
   * QuizCriterion[] (котрі й раніше вже генерувались AI з транскрипту).
   * Раніше: getChecklist(category) — синхронний, статичний, той самий
   * список незалежно від бюджету/цілі. Тепер: якщо в розмові вже є
   * хоча б одна відповідь користувача (бриф про ціль/бюджет) — AI
   * генерує 8-12 пунктів, релевантних САМЕ цьому бюджету/цілі
   * (наприклад для дорогого сегменту — статусні деталі, для
   * економного — приховані витрати/ризики). Якщо брифу ще немає, або
   * AI-виклик не вдався/повернув невалідний результат — ЧЕСНА
   * ДЕГРАДАЦІЯ до статичного категорійного чек-листа
   * (getOnboardingChecklist), не помилка користувачу: чек-лист —
   * допоміжна підказка для розмови, не критичний шлях, немає сенсу
   * блокувати онбордінг через збій одного допоміжного AI-виклику. */
  async getChecklist(userId: string, conversationId: string, category: PurchaseCategory): Promise<string[]> {
    const conversation = await this.assertOwnedConversation(userId, conversationId);
    const transcript = await this.prisma.transcript.findUnique({
      where: { conversationId },
      include: { segments: { orderBy: { startMs: 'asc' } } },
    });

    const staticFallback = getOnboardingChecklist(category);
    if (!transcript || transcript.segments.length === 0) {
      return staticFallback;
    }

    const briefText = transcript.segments.map((s: { text: string }) => s.text).join('\n');

    try {
      const result = await this.aiRouter.execute({
        userId,
        projectId: conversation.projectId,
        taskType: CHECKLIST_TASK_TYPE,
        systemPrompt: buildChecklistSystemPrompt(category),
        userPrompt: briefText,
        jsonMode: true,
        maxTokens: 600,
        validateOutput: isValidChecklist,
      });
      const parsed = JSON.parse(result.text) as string[];
      return parsed;
    } catch (err) {
      // ForbiddenException (например отсутствует ConsentType.EXTERNAL_AI)
      // НЕ проглатывается в фолбэк — это реальная проблема прав
      // доступа, не сбой AI-вызова, скрывать её за "успешным"
      // статическим чек-листом было бы вводящим в заблуждение.
      if (err instanceof ForbiddenException) throw err;
      // Остальное — честная деградация: сбой AI-провайдера/невалидный
      // ответ не должны блокировать онбординг ради вспомогательной
      // подсказки.
      return staticFallback;
    }
  }

  /** Створює порожню TEXT_IMPORT-розмову, готову приймати відповіді
   * користувача по чек-лист-пунктах як окремі TranscriptSegment. */
  async createOnboardingConversation(userId: string, projectId: string) {
    await this.assertOwnedMajorPurchaseProject(userId, projectId);

    return this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({
        data: {
          projectId,
          sourceType: ConversationSourceType.TEXT_IMPORT,
          status: ConversationProcessingStatus.TRANSCRIBED,
          occurredAt: new Date(),
        },
      });
      const participant = await tx.conversationParticipant.create({
        data: { conversationId: conversation.id, diarizationLabel: 'SELF', isSelf: true },
      });
      const transcript = await tx.transcript.create({ data: { conversationId: conversation.id } });
      return { conversation, participant, transcript };
    });
  }

  /** Додає одну відповідь користувача (на один пункт чек-листа або
   * вільним текстом) як TranscriptSegment — той самий принцип, що
   * ChatImportService для TEXT_IMPORT, без STT. */
  async appendAnswer(userId: string, conversationId: string, text: string) {
    if (!text.trim()) {
      throw new BadRequestException('text не может быть пустым');
    }
    const conversation = await this.assertOwnedConversation(userId, conversationId);
    const transcript = await this.prisma.transcript.findUnique({ where: { conversationId } });
    if (!transcript) {
      throw new NotFoundException(`Transcript for conversation ${conversationId} not found`);
    }
    const participant = await this.prisma.conversationParticipant.findFirst({
      where: { conversationId, isSelf: true },
    });

    const lastSegment = await this.prisma.transcriptSegment.findFirst({
      where: { transcriptId: transcript.id },
      orderBy: { endMs: 'desc' },
    });
    const startMs = (lastSegment?.endMs ?? 0) + 1;

    return this.prisma.transcriptSegment.create({
      data: {
        transcriptId: transcript.id,
        participantId: participant?.id ?? null,
        text: text.trim(),
        startMs,
        endMs: startMs,
      },
    });
  }

  async extract(userId: string, conversationId: string, category: PurchaseCategory): Promise<ExtractedConfigDraft> {
    const conversation = await this.assertOwnedConversation(userId, conversationId);
    const transcript = await this.prisma.transcript.findUnique({
      where: { conversationId },
      include: { segments: { orderBy: { startMs: 'asc' } } },
    });
    if (!transcript || transcript.segments.length === 0) {
      throw new BadRequestException('В этой онбординг-разговоре пока нет ответов — нечего извлекать');
    }

    const transcriptText = transcript.segments.map((s: { text: string }) => s.text).join('\n');

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId: conversation.projectId,
        taskType: TASK_TYPE,
        systemPrompt: buildSystemPrompt(category),
        userPrompt: transcriptText,
        jsonMode: true,
        maxTokens: 1500,
        validateOutput: isValidExtraction,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Извлечение отклонено проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось извлечь чернетку — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const parsed: RawExtraction = JSON.parse(result.text);
    return {
      goalDescription: parsed.goalDescription,
      budgetMin: parsed.budgetMin ?? null,
      budgetMax: parsed.budgetMax ?? null,
      currency: parsed.currency ?? null,
      financingMethod: parsed.financingMethod ?? null,
      timeline: parsed.timeline ?? null,
      criteria: parsed.criteria.map((c, i) => ({ text: c.text, isRequired: c.isRequired ?? true, orderIndex: i })),
    };
  }

  private async assertOwnedMajorPurchaseProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, ownerId: userId } });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    return project;
  }

  private async assertOwnedConversation(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { project: true },
    });
    if (!conversation || conversation.project.ownerId !== userId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }
}

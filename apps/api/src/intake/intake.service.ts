// ТЗ devils-advocate-domain-ui-and-voice-intake-tz.md §2 — универсальный
// квиз на входе. Собирает описание ситуации (голос/текст — для backend
// это всегда текст), классифицирует через AIRouter, при подтверждении
// пользователем dispatch-ит в выбранный сценарий, replay-я накопленные
// ответы через appendAnswer() домена — extract() домена дальше работает
// на них как на своих. Ниже порога — универсальный сценарий, не ошибка.
import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { IntakeStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ProjectsService } from '../projects/projects.service';
import { DtpOnboardingService } from '../dtp/dtp-onboarding.service';
import { FamilyLawOnboardingService } from '../family-law/family-law-onboarding.service';
import { HealthOnboardingService } from '../health/health-onboarding.service';
import { InterviewPoolOnboardingService } from '../interview-pool/interview-pool-onboarding.service';
import { InvestmentOnboardingService } from '../investment/investment-onboarding.service';
import { MajorPurchaseOnboardingService } from '../major-purchase/major-purchase-onboarding.service';
import { JobSearchOnboardingService } from '../job-search/job-search-onboarding.service';

export const INTAKE_TASK_TYPE = 'intake-classify';
/** Порог уверенности, ниже которого — UNIVERSAL (ТЗ §2.2 п.4; тест на границу). */
export const INTAKE_CONFIDENCE_THRESHOLD = 0.6;
/** Жёсткий потолок уточняющих вопросов (ТЗ §2.2 п.2). */
export const INTAKE_MAX_FOLLOW_UPS = 3;
/** Сессии без dispatch дольше этого — ABANDONED (ТЗ §2.2 п.7). */
export const INTAKE_ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

export const INTAKE_SCENARIOS = ['UNIVERSAL', 'dtp', 'family-law', 'health', 'interview-pool', 'investment', 'major-purchase', 'job-search'] as const;
export type IntakeScenario = (typeof INTAKE_SCENARIOS)[number];

export interface IntakeAnswer { question: string | null; text: string; at: string }
export interface IntakeExtracted { question: string; goal?: string | null; facts: string[]; contractType?: 'PRENUP' | 'DIVORCE_SETTLEMENT' | null }
export interface IntakeClassification { scenario: IntakeScenario; confidence: number; followUpQuestion: string | null; extracted: IntakeExtracted }

/** Дефолт, пока в реестре нет ACTIVE-версии `intake-classify`. */
export const INTAKE_DEFAULT_SYSTEM_PROMPT = `Ты — модуль первичной оценки ситуации в приложении «Адвокат дьявола».
Пользователь описывает, что у него происходит. Определи, какой сценарий подходит:
- "dtp" — дорожно-транспортное происшествие: вина, ущерб, страховая, ремонт.
- "family-law" — брачный договор или раздел имущества/условия при разводе.
- "health" — медицинские рекомендации, второе мнение врача, анализы, стоимость лечения.
- "interview-pool" — подбор персонала: вакансия, собеседования, кандидаты.
- "investment" — инвестиционные предложения, советники, доходность, комиссии.
- "major-purchase" — покупка жилья или автомобиля: варианты, встречи с продавцами.
- "job-search" — человек сам ищет работу: составить резюме, оценить вакансии, куда откликаться.
- "UNIVERSAL" — любой другой спор, переговоры или решение.
Отвечай ТОЛЬКО JSON без пояснений:
{"scenario": string, "confidence": number 0..1, "followUpQuestion": string|null,
 "extracted": {"question": string, "goal": string|null, "facts": string[], "contractType": "PRENUP"|"DIVORCE_SETTLEMENT"|null}}
Правила: "question" — ситуация одной фразой словами пользователя; "goal" — чего он хочет добиться, если сказал;
"facts" — конкретные факты (даты, суммы, стороны) по одному; "followUpQuestion" — ОДИН короткий вопрос,
только если он реально меняет выбор сценария или его уверенность, иначе null;
"contractType" — только для family-law, если понятно, иначе null. Не ставь диагнозов и не давай советов.`;

function isValidClassification(text: string): boolean {
  try {
    const p = JSON.parse(text);
    return (
      p && typeof p === 'object' && INTAKE_SCENARIOS.includes(p.scenario) &&
      typeof p.confidence === 'number' && p.confidence >= 0 && p.confidence <= 1 &&
      (p.followUpQuestion === null || typeof p.followUpQuestion === 'string') &&
      p.extracted && typeof p.extracted.question === 'string' && Array.isArray(p.extracted.facts)
    );
  } catch {
    return false;
  }
}

export function decideScenario(suggested: IntakeScenario, confidence: number): IntakeScenario {
  return confidence >= INTAKE_CONFIDENCE_THRESHOLD ? suggested : 'UNIVERSAL';
}

@Injectable()
export class IntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
    private readonly projects: ProjectsService,
    private readonly dtp: DtpOnboardingService,
    private readonly familyLaw: FamilyLawOnboardingService,
    private readonly health: HealthOnboardingService,
    private readonly interviewPool: InterviewPoolOnboardingService,
    private readonly investment: InvestmentOnboardingService,
    private readonly majorPurchase: MajorPurchaseOnboardingService,
    private readonly jobSearch: JobSearchOnboardingService,
  ) {}

  private async findOwnedSession(userId: string, sessionId: string) {
    const session = await this.prisma.intakeSession.findFirst({ where: { id: sessionId, userId } });
    if (!session) throw new NotFoundException(`IntakeSession ${sessionId} not found`);
    return session;
  }

  private async classify(userId: string, answers: IntakeAnswer[]): Promise<IntakeClassification> {
    const userPrompt = answers
      .map((a, i) => (a.question ? `Вопрос ${i + 1}: ${a.question}\nОтвет: ${a.text}` : `Пользователь: ${a.text}`))
      .join('\n\n');
    // Тот же паттерн, что у argument-generation: ACTIVE-версия в PromptRegistry
    // (promptId = taskType) переопределяет константу; promptVersionId уходит в
    // телеметрию, чтобы матрица «предложил × выбрал» в /admin/intake была
    // сопоставима с конкретной версией промпта.
    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: INTAKE_TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        taskType: INTAKE_TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt: activePrompt?.template ?? INTAKE_DEFAULT_SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 800,
        validateOutput: isValidClassification,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Описание отклонено проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось оценить ситуацию — AI-провайдер недоступен. Можно продолжить в универсальном сценарии.');
    }
    const parsed = JSON.parse(result.text) as IntakeClassification;
    return {
      scenario: parsed.scenario,
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      followUpQuestion: parsed.followUpQuestion?.trim() || null,
      extracted: {
        question: parsed.extracted.question.trim(),
        goal: parsed.extracted.goal?.trim() || null,
        facts: parsed.extracted.facts.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim()),
        contractType: parsed.extracted.contractType === 'PRENUP' || parsed.extracted.contractType === 'DIVORCE_SETTLEMENT' ? parsed.extracted.contractType : null,
      },
    };
  }

  /** Публичное представление: следующий вопрос ИЛИ решение. Оба поля никогда не
   * одновременно — клиенту не нужно угадывать состояние. */
  private present(session: { id: string; status: IntakeStatus; answers: unknown; suggestedScenario: string | null; confidence: number | null; followUpQuestion: string | null; extracted: unknown; chosenScenario: string | null; dispatchedProjectId: string | null }) {
    const answers = (session.answers as unknown as IntakeAnswer[]) ?? [];
    const followUpsAsked = answers.filter((a) => a.question).length;
    const canAskMore = followUpsAsked < INTAKE_MAX_FOLLOW_UPS;
    const suggested = (session.suggestedScenario ?? 'UNIVERSAL') as IntakeScenario;
    const confidence = session.confidence ?? 0;
    const decision = decideScenario(suggested, confidence);
    const nextQuestion = session.status === IntakeStatus.IN_PROGRESS && canAskMore && session.followUpQuestion ? session.followUpQuestion : null;
    return {
      id: session.id,
      status: session.status,
      answers,
      followUpsAsked,
      followUpsLeft: Math.max(0, INTAKE_MAX_FOLLOW_UPS - followUpsAsked),
      nextQuestion,
      decision: nextQuestion ? null : { scenario: decision, suggestedScenario: suggested, confidence, belowThreshold: decision !== suggested },
      extracted: (session.extracted as IntakeExtracted | null) ?? null,
      chosenScenario: session.chosenScenario,
      dispatchedProjectId: session.dispatchedProjectId,
    };
  }

  async start(userId: string, text: string) {
    if (!text.trim()) throw new BadRequestException('text не может быть пустым');
    const answers: IntakeAnswer[] = [{ question: null, text: text.trim(), at: new Date().toISOString() }];
    const cls = await this.classify(userId, answers);
    const session = await this.prisma.intakeSession.create({
      data: { userId, answers: answers as any, suggestedScenario: cls.scenario, confidence: cls.confidence, followUpQuestion: cls.followUpQuestion, extracted: cls.extracted as any },
    });
    return this.present(session);
  }

  async answer(userId: string, sessionId: string, text: string) {
    if (!text.trim()) throw new BadRequestException('text не может быть пустым');
    const session = await this.findOwnedSession(userId, sessionId);
    if (session.status !== IntakeStatus.IN_PROGRESS) throw new BadRequestException('Сессия уже завершена');
    const answers = [...((session.answers as unknown as IntakeAnswer[]) ?? [])];
    const pending = this.present(session).nextQuestion;
    answers.push({ question: pending, text: text.trim(), at: new Date().toISOString() });
    const cls = await this.classify(userId, answers);
    const updated = await this.prisma.intakeSession.update({
      where: { id: session.id },
      data: { answers: answers as any, suggestedScenario: cls.scenario, confidence: cls.confidence, followUpQuestion: cls.followUpQuestion, extracted: cls.extracted as any },
    });
    return this.present(updated);
  }

  async get(userId: string, sessionId: string) {
    return this.present(await this.findOwnedSession(userId, sessionId));
  }

  /** ТЗ §2.2 п.6 — dispatch по ПОДТВЕРЖДЁННОМУ пользователем сценарию. AI
   * предложил, пользователь выбрал; выбор может отличаться от предложения —
   * оба сохраняются. */
  async dispatch(userId: string, sessionId: string, scenario: IntakeScenario, options: { contractType?: 'PRENUP' | 'DIVORCE_SETTLEMENT' } = {}) {
    if (!INTAKE_SCENARIOS.includes(scenario)) throw new BadRequestException(`Unknown scenario: ${scenario}`);
    const session = await this.findOwnedSession(userId, sessionId);
    if (session.status === IntakeStatus.DISPATCHED) throw new BadRequestException('Сессия уже передана в сценарий');
    const answers = (session.answers as unknown as IntakeAnswer[]) ?? [];
    const extracted = (session.extracted as IntakeExtracted | null) ?? { question: answers[0]?.text ?? '', goal: null, facts: [] };
    const question = extracted.question || answers[0]?.text || '';
    if (!question.trim()) throw new BadRequestException('Нечего передавать — нет ни одного ответа');

    let projectId: string;
    let conversationId: string | null = null;

    if (scenario === 'UNIVERSAL') {
      // Факты — в goal, если цели нет: ProjectLog в проекте derived-only, своей записи нет.
      const goal = extracted.goal ?? (extracted.facts.length ? `Контекст из квиза: ${extracted.facts.join('; ')}` : undefined);
      const project = await this.projects.create(userId, { question, goal });
      projectId = project.id;
    } else {
      const onboarding = this.onboardingFor(scenario);
      let project: { id: string };
      if (scenario === 'family-law') {
        const contractType = options.contractType ?? extracted.contractType ?? null;
        if (!contractType) throw new BadRequestException('Для семейного права нужен contractType (PRENUP | DIVORCE_SETTLEMENT) — выберите на экране подтверждения');
        project = await this.familyLaw.createProject(userId, question, contractType as any);
      } else {
        project = await (onboarding as { createProject(userId: string, question: string): Promise<{ id: string }> }).createProject(userId, question);
      }
      projectId = project.id;
      const conv = await onboarding.createOnboardingConversation(userId, projectId);
      conversationId = conv.conversation.id;
      // Replay: ответы квиза в исходном порядке — ровно то, что домен получил бы
      // от пользователя напрямую. Вопросы квиза не пишутся (домен хранит только ответы).
      for (const a of answers) {
        await onboarding.appendAnswer(userId, conversationId, a.text);
      }
    }

    const updated = await this.prisma.intakeSession.update({
      where: { id: session.id },
      data: { status: IntakeStatus.DISPATCHED, chosenScenario: scenario, dispatchedProjectId: projectId, dispatchedAt: new Date() },
    });
    return { ...this.present(updated), projectId, conversationId };
  }

  private onboardingFor(scenario: Exclude<IntakeScenario, 'UNIVERSAL'>) {
    switch (scenario) {
      case 'dtp': return this.dtp;
      case 'family-law': return this.familyLaw;
      case 'health': return this.health;
      case 'interview-pool': return this.interviewPool;
      case 'investment': return this.investment;
      case 'major-purchase': return this.majorPurchase;
      case 'job-search': return this.jobSearch;
    }
  }

  /** ТЗ §2.2 п.7 — вызывается планировщиком (pg_cron → HTTP, как reminders). */
  async abandonStale(now = new Date()) {
    const cutoff = new Date(now.getTime() - INTAKE_ABANDON_AFTER_MS);
    const result = await this.prisma.intakeSession.updateMany({
      where: { status: IntakeStatus.IN_PROGRESS, updatedAt: { lt: cutoff } },
      data: { status: IntakeStatus.ABANDONED },
    });
    return { abandoned: result.count };
  }
}

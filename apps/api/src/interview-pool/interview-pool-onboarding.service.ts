// Пункт [interview-pool] (devils-advocate-interview-pool-tz.md §4.8):
// онбордінг-розмова на пошук — з'ясування, кого шукати.
//
// ТЕКСТОВИЙ ШЛЯХ — той самий свідомий вибір, що вже застосований у
// Пункті [major-purchase]: TEXT_IMPORT-конвеєр без STT, замість
// підключення голосового конвеєра лише заради одного onboarding-кроку.
//
// PROJECT СТВОРЮЄТЬСЯ ПЕРЕД ONBOARDING-РОЗМОВОЮ — та сама розбіжність
// з ТЗ, що вже знайдена й виправлена в Пункті [major-purchase]:
// Conversation.projectId обов'язковий, §5 ТЗ помилково проєктував
// projectId як опційний параметр.

import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import {
  ProjectMode,
  EmploymentLoad,
  WorkArrangement,
  GenderRequirement,
  AgeRequirement,
} from '@prisma/client';
import { assertInterviewPoolProjectAccess } from './interview-pool-access';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { ensureOnboardingConversation } from '../common/onboarding-conversation';

const TASK_TYPE = 'interview-pool-onboarding-extract';

// §4.8 ТЗ, буквальний перелік пунктів 1-10.
export const ONBOARDING_CHECKLIST = [
  'Службові обов\'язки',
  'Зарплата (вилка/діапазон)',
  'Повна/неповна зайнятість',
  'Формат роботи — офіс/remote/гібрид (+ локація, якщо не remote)',
  'Стать кандидата — критично важлива вимога, чи неважливо',
  'Вікові межі — критично важливі, чи неважливо',
  'Офіційне оформлення чи договір',
  '"Плюшки"/бенефіти',
  'Етапи співбесіди — скільки, які саме (включно з тестовим завданням), хто інтерв\'юер на кожному',
  'Чекбокс "Фізично важка праця" — контекст для пунктів 5-6',
];

export interface ExtractedStage {
  name: string;
  orderIndex: number;
  isTestAssignment: boolean;
  interviewerRole: string | null;
}

export interface ExtractedComplianceFlag {
  category: string;
  quotedText: string;
}

export interface ExtractedPoolConfigDraft {
  jobTitle: string;
  extendedDescription: string;
  salaryRange: string | null;
  employmentLoad: EmploymentLoad | null;
  workArrangement: WorkArrangement | null;
  officeLocation: string | null;
  employmentFormat: string | null;
  perks: string[];
  genderRequirement: GenderRequirement;
  ageRequirement: AgeRequirement;
  minAge: number | null;
  maxAge: number | null;
  isPhysicallyDemanding: boolean;
  interviewStages: ExtractedStage[];
  complianceFlags: ExtractedComplianceFlag[];
}

interface RawExtraction {
  jobTitle: string;
  extendedDescription: string;
  salaryRange?: string | null;
  employmentLoad?: 'FULL_TIME' | 'PART_TIME' | null;
  workArrangement?: 'OFFICE' | 'REMOTE' | 'HYBRID' | null;
  officeLocation?: string | null;
  employmentFormat?: string | null;
  perks?: string[];
  genderRequirement?: 'NOT_IMPORTANT' | 'MALE' | 'FEMALE' | 'OTHER';
  ageRequirement?: 'NOT_IMPORTANT' | 'RANGE';
  minAge?: number | null;
  maxAge?: number | null;
  isPhysicallyDemanding?: boolean;
  interviewStages?: Array<{ name: string; isTestAssignment?: boolean; interviewerRole?: string | null }>;
  complianceFlags?: Array<{ category: string; quotedText: string }>;
}

function isValidExtraction(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return false;
    if (typeof parsed.jobTitle !== 'string' || parsed.jobTitle.trim().length === 0) return false;
    if (typeof parsed.extendedDescription !== 'string' || parsed.extendedDescription.trim().length === 0) return false;
    return true;
  } catch {
    return false;
  }
}

// §2.6 ТЗ: явна заборона вгадувати genderRequirement/ageRequirement,
// коли про це прямо не сказано — фіксує ЛИШЕ те, що прозвучало прямим
// текстом, дефолт NOT_IMPORTANT. §2.6a: решта захищених ознак (раса/
// релігія/інвалідність/вагітність/національність/орієнтація) НЕ
// отримують структурних полів — тільки ComplianceFlag з точною цитатою.
const SYSTEM_PROMPT =
  'Тебе дано транскрипт онбордінг-розмови рекрутера із замовником про пошук кандидата на вакансію. ' +
  'Витягни структуровану чернетку: jobTitle, extendedDescription (повний опис вакансії вільним текстом), ' +
  'salaryRange, employmentLoad ("FULL_TIME"|"PART_TIME"), workArrangement ("OFFICE"|"REMOTE"|"HYBRID"), officeLocation, ' +
  'employmentFormat, perks (масив рядків), interviewStages (масив {name, isTestAssignment, interviewerRole}). ' +
  'genderRequirement — ТІЛЬКИ якщо замовник ПРЯМО назвав стать критично важливою вимогою (значення "MALE"|"FEMALE"|"OTHER"), ' +
  'інакше "NOT_IMPORTANT" — НЕ вгадуй "напевно тут важливо". Так само ageRequirement — "RANGE" з minAge/maxAge ТІЛЬКИ якщо прямо названо вікові межі, інакше "NOT_IMPORTANT". ' +
  'isPhysicallyDemanding — true, тільки якщо замовник прямо описав фізично важку працю. ' +
  'Якщо замовник згадує РАСУ, РЕЛІГІЮ, ІНВАЛІДНІСТЬ, ВАГІТНІСТЬ, НАЦІОНАЛЬНІСТЬ чи ОРІЄНТАЦІЮ кандидата як критерій — НЕ додавай це в жодне структуроване поле (таких полів немає), замість цього додай запис у complianceFlags: {category, quotedText — точна цитата з розмови}. ' +
  'Відповідай СТРОГО валідним JSON без пояснень поза ним.';

@Injectable()
export class InterviewPoolOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async createProject(userId: string, question: string, recruitingTeamId?: string) {
    if (!question.trim()) {
      throw new BadRequestException('question не может быть пустым');
    }
    if (recruitingTeamId) {
      const membership = await this.prisma.recruitingTeamMember.findUnique({
        where: { teamId_userId: { teamId: recruitingTeamId, userId } },
      });
      if (!membership) {
        throw new NotFoundException(`RecruitingTeam ${recruitingTeamId} not found`);
      }
    }
    return this.prisma.project.create({
      data: { ownerId: userId, question: question.trim(), mode: ProjectMode.INTERVIEW_POOL, recruitingTeamId },
    });
  }

  getChecklist(): string[] {
    return ONBOARDING_CHECKLIST;
  }

  async createOnboardingConversation(userId: string, projectId: string) {
    await assertInterviewPoolProjectAccess(this.prisma, userId, projectId);

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

  async extract(userId: string, conversationId: string): Promise<ExtractedPoolConfigDraft> {
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
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: transcriptText,
        jsonMode: true,
        maxTokens: 2000,
        validateOutput: isValidExtraction,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Извлечение отклонено проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось извлечь чернетку — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const parsed: RawExtraction = JSON.parse(result.text);
    return {
      jobTitle: parsed.jobTitle,
      extendedDescription: parsed.extendedDescription,
      salaryRange: parsed.salaryRange ?? null,
      employmentLoad: (parsed.employmentLoad as EmploymentLoad) ?? null,
      workArrangement: (parsed.workArrangement as WorkArrangement) ?? null,
      officeLocation: parsed.officeLocation ?? null,
      employmentFormat: parsed.employmentFormat ?? null,
      perks: parsed.perks ?? [],
      // §2.6 ТЗ: дефолт NOT_IMPORTANT, ніколи не null/undefined.
      genderRequirement: (parsed.genderRequirement as GenderRequirement) ?? GenderRequirement.NOT_IMPORTANT,
      ageRequirement: (parsed.ageRequirement as AgeRequirement) ?? AgeRequirement.NOT_IMPORTANT,
      minAge: parsed.minAge ?? null,
      maxAge: parsed.maxAge ?? null,
      isPhysicallyDemanding: parsed.isPhysicallyDemanding ?? false,
      interviewStages: (parsed.interviewStages ?? []).map((s, i) => ({
        name: s.name,
        orderIndex: i,
        isTestAssignment: s.isTestAssignment ?? false,
        interviewerRole: s.interviewerRole ?? null,
      })),
      complianceFlags: (parsed.complianceFlags ?? []).map((c) => ({ category: c.category, quotedText: c.quotedText })),
    };
  }

  private async assertOwnedConversation(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { project: true },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    // Той самий командно-обізнаний доступ, що для проєкту напряму —
    // одна перевірка, не дублюємо логіку тут.
    await assertInterviewPoolProjectAccess(this.prisma, userId, conversation.projectId);
    return conversation;
  }
}

// Пункт 64: SituationalContentService (§3.24 частично + §3.25 ТЗ) —
// "Кнопки быстрой генерации по текущей ситуации" + "Настройки
// пользователя: анекдот и цитата как постоянные предпочтения", пункт
// 44 общего списка v4-роадмапа (сам запрос пользователя). По прямому
// запросу, реализовано вместе с недостающей частью §3.24, на которую
// §3.25 прямо ссылается как "дополнение".
//
// ОБА ВИДА КОНТЕНТА — ТОЛЬКО ДЛЯ УКАЗАВШИХ ВЕРОИСПОВЕДАНИЕ
// (User.religion != null), согласовано с пользователем перед стартом
// — тот же принцип, что уже применён к остальному религиозному
// контенту (Пункт 49): гео/дефолт никогда не подставляет
// предположение, только явный выбор.
//
// ЦИТАТА — та же дисциплина цитирования, что уже применена в
// ReconciliationArgumentsService (Пункт 49, §3.14 ТЗ): системный
// промпт явно запрещает длинное дословное цитирование, требует
// короткий парафраз + отдельную ссылку на первоисточник.
//
// АНЕКДОТ — БЕЗ ДИСЦИПЛИНЫ ЦИТИРОВАНИЯ ВООБЩЕ, буквально ТЗ: "не
// участвует в весе аргументации решения и не требует тегирования
// источника, так как это не факт и не аргумент".

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';

const QUOTE_TASK_TYPE = 'situational-quote';
const ANECDOTE_TASK_TYPE = 'situational-anecdote';

interface RawQuote {
  quoteText: string;
  sourceReference: string;
}

interface RawAnecdote {
  text: string;
}

function isValidQuotePayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.quoteText === 'string' &&
      parsed.quoteText.trim().length > 0 &&
      typeof parsed.sourceReference === 'string' &&
      parsed.sourceReference.trim().length > 0
    );
  } catch {
    return false;
  }
}

function isValidAnecdotePayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && typeof parsed.text === 'string' && parsed.text.trim().length > 0;
  } catch {
    return false;
  }
}

const QUOTE_SYSTEM_PROMPT =
  'Пользователь указал своё вероисповедание. Подбери ОДНУ короткую цитату из религиозного первоисточника этой традиции (Библия/Коран/другой первоисточник соответствующей религии), применимую к описанной ситуации. КРИТИЧЕСКИ ВАЖНО: quoteText — краткий ПАРАФРАЗ смысла, НЕ дословное цитирование длинного отрывка (не более одной короткой фразы дословно, если вообще дословно); sourceReference — точная ссылка на источник (книга, глава, стих) ОТДЕЛЬНО от текста цитаты, не смешивай их в одном поле. Ответь СТРОГО валидным JSON-объектом вида {"quoteText": string, "sourceReference": string}. Без пояснений вне JSON.';

const ANECDOTE_SYSTEM_PROMPT =
  'Придумай короткий уместный анекдот или лёгкую шутку по мотивам описанной ситуации — нотка юмора, разряжающая напряжение, не язвительная и не обесценивающая серьёзность ситуации для пользователя. Это развлекательный контент, не факт и не аргумент. Ответь СТРОГО валидным JSON-объектом вида {"text": string}. Без пояснений вне JSON.';

@Injectable()
export class SituationalContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async generateQuote(userId: string, projectId: string, engineId?: string) {
    const project = await this.assertReligionSet(userId, projectId);

    const userPrompt = [`Ситуация: ${project.question}`, project.goal ? `Цель: ${project.goal}` : ''].filter(Boolean).join('\n\n');

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: QUOTE_TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: QUOTE_TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt: activePrompt?.template ?? QUOTE_SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 400,
        validateOutput: isValidQuotePayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось подобрать цитату — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const raw: RawQuote = JSON.parse(result.text);
    return this.prisma.situationalQuote.create({
      data: { projectId, quoteText: raw.quoteText, sourceReference: raw.sourceReference, generatedByInferenceId: result.aiInferenceId },
    });
  }

  async generateAnecdote(userId: string, projectId: string, engineId?: string) {
    const project = await this.assertReligionSet(userId, projectId);

    const userPrompt = [`Ситуация: ${project.question}`, project.goal ? `Цель: ${project.goal}` : ''].filter(Boolean).join('\n\n');

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: ANECDOTE_TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: ANECDOTE_TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt: activePrompt?.template ?? ANECDOTE_SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 400,
        validateOutput: isValidAnecdotePayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось придумать анекдот — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const raw: RawAnecdote = JSON.parse(result.text);
    return this.prisma.situationalAnecdote.create({
      data: { projectId, text: raw.text, generatedByInferenceId: result.aiInferenceId },
    });
  }

  async listQuotes(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.situationalQuote.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }

  async listAnecdotes(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.situationalAnecdote.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }

  async updatePreferences(userId: string, input: { alwaysShowQuote?: boolean; alwaysShowAnecdote?: boolean }) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.alwaysShowQuote !== undefined ? { alwaysShowQuote: input.alwaysShowQuote } : {}),
        ...(input.alwaysShowAnecdote !== undefined ? { alwaysShowAnecdote: input.alwaysShowAnecdote } : {}),
      },
      select: { alwaysShowQuote: true, alwaysShowAnecdote: true },
    });
  }

  private async assertReligionSet(userId: string, projectId: string) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { religion: true } });
    if (!user?.religion) {
      throw new BadRequestException('Функция доступна только пользователям, явно указавшим вероисповедание в настройках');
    }
    return project;
  }
}

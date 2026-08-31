// Пункт 21: SourceConflictService (§3.56 ТЗ) — восьмая из 11 фич MVP
// v2.
//
// "Система не выбирает истину автоматически" — detect() не помечает
// ни один из двух фактов как "правильный", не трогает их
// FactStatus/confidence вообще. Единственное следствие обнаружения
// конфликта — новая запись SourceConflict, факты A и B остаются как
// были. Резолюция (resolvedAt) — действие пользователя, вызывается
// отдельным методом markResolved(), не автоматически по результату
// AI-вызова.
//
// Область действия — Person (не Project, не Conversation), в отличие
// от всех пяти предыдущих AI-фич этого чекпоинта. §3.56 буквально про
// "два источника" ОБ ОДНОМ ЧЕЛОВЕКЕ — факты привязаны к personId
// (PersonFact.personId), не к одному конкретному разговору или
// проекту, конфликт может быть между фактом из одного проекта и
// фактом из другого (тот же человек мог фигурировать в нескольких
// разных решениях пользователя).
//
// Детекция — один AI-вызов на ВСЕ факты человека сразу (не попарно
// N² отдельных вызовов) — тот же принцип батч-анализа, что уже
// применялся в Turning Points/Do Not Say: один промпт со списком всех
// фактов с их id, ответ — список найденных конфликтных пар.

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { FactStatus, SourceConflict } from '@prisma/client';

const TASK_TYPE = 'source-conflict-detection';

interface RawConflict {
  factAId: string;
  factBId: string;
  conflictDescription: string;
  possibleExplanations: string[];
  clarifyingQuestion: string;
}

function isValidConflictsPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.factAId === 'string' &&
        typeof item.factBId === 'string' &&
        typeof item.conflictDescription === 'string' &&
        Array.isArray(item.possibleExplanations) &&
        item.possibleExplanations.every((e: unknown) => typeof e === 'string') &&
        typeof item.clarifyingQuestion === 'string',
    );
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Ниже приведён список фактов об одном человеке, с указанием id каждого факта. Найди пары фактов, которые противоречат друг другу — говорят разное об одном и том же аспекте. НЕ выбирай, какой факт из пары верный — твоя задача только выявить конфликт, не разрешить его. Для каждой найденной конфликтующей пары укажи: factAId и factBId (id обоих фактов), conflictDescription (в чём именно конфликт), possibleExplanations (список возможных объяснений расхождения — например, факты могли относиться к разным периодам времени, один источник мог ошибаться, ситуация могла измениться), clarifyingQuestion (один уточняющий вопрос пользователю, который помог бы разрешить это конкретное противоречие). Ответь СТРОГО валидным JSON-массивом объектов вида {"factAId": string, "factBId": string, "conflictDescription": string, "possibleExplanations": string[], "clarifyingQuestion": string}. Если противоречий нет — верни пустой массив []. Без пояснений вне JSON.';

@Injectable()
export class SourceConflictService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async detect(userId: string, personId: string) {
    const person = await this.findOwnedPerson(userId, personId);

    const facts = await this.prisma.personFact.findMany({
      where: { personId, status: { not: FactStatus.EXPIRED } },
    });
    if (facts.length < 2) {
      throw new BadRequestException(
        `Person ${personId} has fewer than 2 active facts — nothing to compare for conflicts`,
      );
    }

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    const systemPrompt = activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT;
    const userPrompt = facts
      .map((f: (typeof facts)[number]) => `[${f.id}] (${f.sourceType}) ${f.content}`)
      .join('\n');

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        // Пункт 21 — единственная AI-фича этого чекпоинта, не
        // привязанная к одному Project: Person может фигурировать в
        // нескольких проектах разом, конфликт фактов о нём — не
        // свойство одного проекта. projectId НЕ передаётся (не null —
        // тип AIRouterRequest.projectId строго string|undefined) —
        // ConsentService.hasActiveConsent() при отсутствии projectId
        // проверяет ГЛОБАЛЬНОЕ согласие пользователя на EXTERNAL_AI,
        // тот же путь, что уже предусмотрен в её собственной логике
        // (OR: [{projectId: null}, ...]), не новое поведение.
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt,
        userPrompt,
        jsonMode: true,
        maxTokens: 1500,
        validateOutput: isValidConflictsPayload,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Анализ отклонён проверкой безопасности содержимого фактов.');
      }
      throw new BadGatewayException(
        'Не удалось проверить факты на противоречия — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const rawConflicts: RawConflict[] = JSON.parse(result.text);
    const factById = new Map<string, (typeof facts)[number]>(
      facts.map((f: (typeof facts)[number]): [string, (typeof facts)[number]] => [f.id, f]),
    );

    const created: SourceConflict[] = [];
    for (const conflict of rawConflicts) {
      const factA = factById.get(conflict.factAId);
      const factB = factById.get(conflict.factBId);
      if (!factA || !factB || factA.id === factB.id) continue; // AI сослался на несуществующий id или назвал факт конфликтующим сам с собой — пропускаем, не падаем на всём батче

      const created_row = await this.prisma.sourceConflict.create({
        data: {
          personId,
          factAId: factA.id,
          factBId: factB.id,
          conflictDescription: conflict.conflictDescription,
          possibleExplanations: conflict.possibleExplanations,
          clarifyingQuestion: conflict.clarifyingQuestion,
          generatedByInferenceId: result.aiInferenceId,
        },
      });
      created.push(created_row);
    }

    return created;
  }

  async list(userId: string, personId: string) {
    await this.findOwnedPerson(userId, personId);
    return this.prisma.sourceConflict.findMany({
      where: { personId },
      include: { factA: true, factB: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Пункт 24 (§3.59 ТЗ, "Незакрытые вопросы") — агрегация НЕразрешённых
   * конфликтов по ВСЕМ фигурантам проекта разом, тот же принцип, что
   * StaleFactService.listForProject()/DoNotSayService.listForProject():
   * карточка/сводка проекта не знает заранее, с кем именно из
   * фигурантов состоится следующий контакт, показывает по всем сразу. */
  async listUnresolvedForProject(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);

    const personLinks = await this.prisma.projectPerson.findMany({
      where: { projectId },
      select: { personId: true },
    });
    const personIds = personLinks.map((l: { personId: string }) => l.personId);
    if (personIds.length === 0) return [];

    return this.prisma.sourceConflict.findMany({
      where: { personId: { in: personIds }, resolvedAt: null },
      include: { factA: true, factB: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** §3.56 ТЗ: "система не выбирает истину" — это НЕ "AI решил, кто
   * прав", а пользователь вручную закрывает конфликт в своём
   * понимании (прочитал, разобрался, больше не актуально показывать).
   * Ни один PersonFact при этом не меняется. */
  async markResolved(userId: string, conflictId: string) {
    const conflict = await this.prisma.sourceConflict.findUnique({
      where: { id: conflictId },
      include: { person: true },
    });
    if (!conflict || conflict.person.createdByUserId !== userId) {
      throw new NotFoundException(`SourceConflict ${conflictId} not found`);
    }
    return this.prisma.sourceConflict.update({
      where: { id: conflictId },
      data: { resolvedAt: new Date() },
    });
  }

  private async findOwnedPerson(userId: string, personId: string) {
    const person = await this.prisma.person.findFirst({
      where: { id: personId, createdByUserId: userId },
    });
    if (!person) {
      throw new NotFoundException(`Person ${personId} not found`);
    }
    return person;
  }
}

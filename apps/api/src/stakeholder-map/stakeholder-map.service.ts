// Пункт 44: StakeholderMapService (§3.8 ТЗ) — доводит до конца пункт
// 20 v3-роадмапа ("карта круга лиц + аргументы под каждого
// фигуранта"). Зависимость (граф связей) закрыта в Пункте 43.
//
// ВИЗУАЛИЗАЦИЯ ГРАФА НЕ РЕАЛИЗОВАНА — сама ТЗ прямо называет её
// опциональной ("Визуализация: граф связей... — опционально, для
// сложных корпоративных/политических кейсов"). Реализована суть
// пункта: выявление круга лиц с ролями + отдельный набор аргументов
// под каждого, явно не смешанный с общим списком.
//
// РОЛИ — AI ПРЕДЛАГАЕТ, ПОЛЬЗОВАТЕЛЬ ПОДТВЕРЖДАЕТ. Тот же принцип, что
// уже применён к переключению PersonStatus в этом проекте
// (§3.38 ТЗ: "детектор конфликта может только предложить, статус
// меняется только при явном подтверждении"). suggestRoles() ничего не
// персистит сама — confirmRole() отдельным явным вызовом.
//
// АРГУМЕНТЫ ТОЛЬКО ДЛЯ УЖЕ ДОБАВЛЕННЫХ ЛЮДЕЙ — suggestRoles() может
// предложить текстом "стоит рассмотреть ещё одного человека с ролью
// Х", но НЕ создаёт и не сопоставляет новую Person-запись сама (риск
// fuzzy-matching, тот же принцип, что уже применён в Пункте 43 к
// извлечению связей из текста реплик) — только текстовая подсказка,
// пользователь решает, добавлять ли реального человека вручную.

import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ArgumentStance, StakeholderRole } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const SUGGEST_ROLES_TASK_TYPE = 'stakeholder-role-suggestion';
const TARGETED_ARGUMENTS_TASK_TYPE = 'stakeholder-argument-generation';

const ROLE_LABELS: Record<StakeholderRole, string> = {
  DECISION_MAKER: 'прямой решающий',
  ADVISOR: 'влияющий советчик',
  BLOCKER: 'блокер',
  ALLY: 'союзник',
};

interface RawRoleSuggestion {
  personId: string;
  role: 'DECISION_MAKER' | 'ADVISOR' | 'BLOCKER' | 'ALLY';
  reasoning: string;
}

interface RawGapSuggestion {
  roleHint: string; // например "финансовый директор" — текстом, не привязано ни к какой Person
  reasoning: string;
}

interface RawSuggestRolesPayload {
  roleSuggestions: RawRoleSuggestion[];
  gapSuggestions: RawGapSuggestion[];
}

function isValidSuggestRolesPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return false;
    if (!Array.isArray(parsed.roleSuggestions) || !Array.isArray(parsed.gapSuggestions)) return false;
    const validRoles = ['DECISION_MAKER', 'ADVISOR', 'BLOCKER', 'ALLY'];
    return (
      parsed.roleSuggestions.every(
        (r: any) => typeof r.personId === 'string' && validRoles.includes(r.role) && typeof r.reasoning === 'string',
      ) &&
      parsed.gapSuggestions.every((g: any) => typeof g.roleHint === 'string' && typeof g.reasoning === 'string')
    );
  } catch {
    return false;
  }
}

interface RawTargetedArgument {
  text: string;
  stance: 'pro' | 'con';
  weight?: number;
}

function isValidTargetedArgumentsPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.text === 'string' &&
        (item.stance === 'pro' || item.stance === 'con') &&
        (item.weight === undefined || typeof item.weight === 'number'),
    );
  } catch {
    return false;
  }
}

@Injectable()
export class StakeholderMapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  /** "AI помогает пользователю выявить весь круг лиц" (§3.8 ТЗ) —
   * НЕ персистит ничего, только возвращает предложения: роли для уже
   * добавленных в проект людей + текстовые подсказки о возможных
   * пробелах в круге лиц. */
  async suggestRoles(userId: string, projectId: string, engineId?: string) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);

    const links = await this.prisma.projectPerson.findMany({
      where: { projectId },
      include: { person: { include: { facts: true } } },
    });
    if (links.length === 0) {
      throw new BadRequestException('В проекте пока нет ни одного добавленного человека — сначала добавьте хотя бы одного в разделе "Участники"');
    }

    const relationships = await this.prisma.relationship.findMany({
      where: { OR: links.map((l: { personId: string }) => ({ personAId: l.personId })) },
    });

    const peopleContext = links
      .map((l: any) => {
        const facts = l.person.facts.map((f: { content: string }) => f.content).join('; ');
        return `[personId=${l.personId}] ${l.person.displayName ?? 'Без имени'}${facts ? ` — известно: ${facts}` : ''}`;
      })
      .join('\n');
    const relationshipsContext = relationships
      .map((r: any) => `${r.personAId} —(${r.label})→ ${r.personBId}`)
      .join('\n');

    const userPrompt = [
      `Ситуация: ${project.question}`,
      project.goal ? `Цель: ${project.goal}` : '',
      `Уже добавленные в проект люди:\n${peopleContext}`,
      relationshipsContext ? `Известные связи между ними:\n${relationshipsContext}` : '',
      'Для каждого из уже добавленных людей предложи роль в круге лиц, влияющих на исход: DECISION_MAKER (прямой решающий), ADVISOR (влияющий советчик), BLOCKER (блокер), ALLY (союзник) — с коротким обоснованием. Если считаешь, что в круге лиц не хватает кого-то важного (например "финансовый директор" или "непосредственный начальник вашего начальника") — предложи это ТЕКСТОМ, не привязывая к конкретному человеку.',
      'Ответь СТРОГО валидным JSON-объектом вида {"roleSuggestions": [{"personId": string, "role": "DECISION_MAKER"|"ADVISOR"|"BLOCKER"|"ALLY", "reasoning": string}], "gapSuggestions": [{"roleHint": string, "reasoning": string}]}. Без пояснений вне JSON.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: SUGGEST_ROLES_TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: SUGGEST_ROLES_TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt: activePrompt?.template ?? 'Ты помогаешь выявить круг лиц, влияющих на решение пользователя, по аналогии с картой стейкхолдеров в продажах/GR.',
        userPrompt,
        jsonMode: true,
        maxTokens: 1500,
        validateOutput: isValidSuggestRolesPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось построить карту круга лиц — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const parsed: RawSuggestRolesPayload = JSON.parse(result.text);
    const knownPersonIds = new Set(links.map((l: { personId: string }) => l.personId));
    return {
      roleSuggestions: parsed.roleSuggestions.filter((r) => knownPersonIds.has(r.personId)), // AI мог сослаться на несуществующий personId — отфильтровываем, не падаем
      gapSuggestions: parsed.gapSuggestions,
    };
  }

  /** Явное подтверждение роли пользователем — единственный способ
   * проставить stakeholderRole, не побочный эффект suggestRoles(). */
  async confirmRole(userId: string, projectId: string, personId: string, role: StakeholderRole) {
    const link = await this.prisma.projectPerson.findFirst({ where: { projectId, personId, project: { ownerId: userId } } });
    if (!link) {
      throw new NotFoundException(`Person ${personId} not found in project ${projectId}`);
    }
    return this.prisma.projectPerson.update({
      where: { id: link.id },
      data: { stakeholderRole: role, stakeholderRoleConfirmedByUser: true },
    });
  }

  /** "Для каждого фигуранта отдельно строится набор аргументов — то,
   * что убедит именно его" (§3.8 ТЗ). Создаёт Argument с
   * targetPersonId, не смешивается с общепроектными аргументами. */
  async generateArgumentsForStakeholder(userId: string, projectId: string, personId: string, engineId?: string) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);
    const link = await this.prisma.projectPerson.findFirst({ where: { projectId, personId }, include: { person: { include: { facts: true } } } });
    if (!link) {
      throw new NotFoundException(`Person ${personId} not found in project ${projectId}`);
    }

    const facts = link.person.facts.map((f: { content: string }) => f.content).join('; ');
    const roleLabel = link.stakeholderRole ? ROLE_LABELS[link.stakeholderRole as StakeholderRole] : null;

    const userPrompt = [
      `Ситуация: ${project.question}`,
      project.goal ? `Цель: ${project.goal}` : '',
      `Человек, которого нужно убедить: ${link.person.displayName ?? 'без имени'}${roleLabel ? ` (роль в круге лиц: ${roleLabel})` : ''}`,
      facts ? `Известно про этого человека: ${facts}` : '',
      'Сгенерируй список аргументов, которые убедят ИМЕННО ЭТОГО человека — с учётом его роли и интересов, не общий список аргументов "за/против" ситуации в целом.',
      'Ответь СТРОГО валидным JSON-массивом объектов вида {"text": string, "stance": "pro"|"con", "weight": number от 0 до 1}. Без пояснений вне JSON.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TARGETED_ARGUMENTS_TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: TARGETED_ARGUMENTS_TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt: activePrompt?.template ?? 'Ты помогаешь подобрать аргументы, адресованные конкретному человеку, с учётом его роли и интересов.',
        userPrompt,
        jsonMode: true,
        maxTokens: 1200,
        validateOutput: isValidTargetedArgumentsPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось сгенерировать аргументы для этого человека — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const rawArguments: RawTargetedArgument[] = JSON.parse(result.text);
    return this.prisma.$transaction(
      rawArguments.map((arg) =>
        this.prisma.argument.create({
          data: {
            projectId,
            targetPersonId: personId,
            text: arg.text,
            stance: arg.stance === 'pro' ? ArgumentStance.PRO : ArgumentStance.CON,
            weight: arg.weight ?? null,
            derivedFromInferenceId: result.aiInferenceId,
          },
        }),
      ),
    );
  }

  /** "Разные фигуранты могут требовать противоречащих друг другу
   * аргументов — система это явно показывает, а не сводит к одному
   * общему списку" (§3.8 ТЗ) — группирует по targetPersonId, не
   * плоский список. */
  async listByStakeholder(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);

    const [links, arguments_] = await Promise.all([
      this.prisma.projectPerson.findMany({ where: { projectId, stakeholderRole: { not: null } }, include: { person: true } }),
      this.prisma.argument.findMany({ where: { projectId, targetPersonId: { not: null } } }),
    ]);

    const argumentsByPerson = new Map<string, typeof arguments_>();
    for (const arg of arguments_) {
      const key = arg.targetPersonId as string;
      const list = argumentsByPerson.get(key) ?? [];
      list.push(arg);
      argumentsByPerson.set(key, list);
    }

    return links.map((link: any) => ({
      personId: link.personId,
      displayName: link.person.displayName,
      role: link.stakeholderRole,
      arguments: argumentsByPerson.get(link.personId) ?? [],
    }));
  }
}

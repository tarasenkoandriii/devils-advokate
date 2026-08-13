// Пункт 79: SchedulerAdviceService (пункт 58 общего списка v4-роадмапа)
// — "Умные советы планировщика: раздельные/групповые встречи, паузы,
// формат контакта, закрепляющие встречи, личные предпочтения строго
// со слов". По прямому запросу.
//
// "ЛИЧНЫЕ ПРЕДПОЧТЕНИЯ СТРОГО СО СЛОВ" — buкально требование ТЗ,
// обеспечено ДВОЙНО: (1) запрос к PersonFact фильтрует по
// sourceType=PERSONAL_RECORD на уровне SQL — догадки (USER_GUESS) и
// публичные факты физически не попадают в промпт; (2) системный
// промпт явно запрещает придумывать советы там, где подходящих
// фактов нет, требует не включать тип совета вообще, если данных
// недостаточно, а не заполнять его общими фразами.
//
// СИНТЕЗ ИЗ УЖЕ СУЩЕСТВУЮЩИХ ДАННЫХ, НЕ НОВЫЙ ВВОД — переиспользует
// PersonFact (личные предпочтения), Relationship (§3.13, для
// "раздельные/групповые встречи"), ProjectPerson.status (Пункт 74,
// персона/фигурант), тот же принцип, что уже применялся в
// ClosingMessageService (Пункт 72) и CompromiseSheetService
// (Пункт 70).

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { FactSourceType } from '@prisma/client';

const TASK_TYPE = 'scheduler-advice';

interface RawAdviceItem {
  adviceText: string;
}

function isValidAdvicePayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every((item) => typeof item.adviceText === 'string' && item.adviceText.trim().length > 0);
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT =
  'Составь СПИСОК конкретных советов планировщика встреч — по темам: с кем лучше встречаться поодиночке, а не в группе (если есть конфликт между людьми); нужна ли пауза перед следующим контактом с кем-то; какой формат контакта уместнее (личная встреча/звонок/сообщение); стоит ли назначить закрепляющую встречу после недавнего разговора. КРИТИЧЕСКИ ВАЖНО: используй ТОЛЬКО данные, явно перечисленные ниже (личные факты о людях, связи между ними, статусы). Если для какой-то из тем данных недостаточно — просто НЕ включай совет на эту тему в ответ, не выдумывай и не заполняй общими фразами вроде "будьте внимательны". Каждый совет должен быть конкретным и опираться на что-то из данных, не абстрактным. Ответь СТРОГО валидным JSON-массивом объектов вида {"adviceText": string}. Если данных недостаточно вообще ни для одной темы — верни пустой массив. Без пояснений вне JSON.';

@Injectable()
export class SchedulerAdviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async generate(userId: string, projectId: string, engineId?: string) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);

    const projectPeople = await this.prisma.projectPerson.findMany({
      where: { projectId },
      include: { person: true },
    });
    const personIds = projectPeople.map((pp: { personId: string }) => pp.personId);

    // "Строго со слов" — фильтр по sourceType на уровне SQL, не
    // постфактум в промпте.
    const personalFacts = personIds.length
      ? await this.prisma.personFact.findMany({
          where: { personId: { in: personIds }, sourceType: FactSourceType.PERSONAL_RECORD, status: 'ACTIVE' },
          include: { person: true },
        })
      : [];

    const relationships = personIds.length
      ? await this.prisma.relationship.findMany({
          where: { personAId: { in: personIds }, personBId: { in: personIds } },
          include: { personA: true, personB: true },
        })
      : [];

    if (personalFacts.length === 0 && relationships.length === 0) {
      throw new BadRequestException(
        'Недостаточно данных для советов — добавьте личные факты о людях в проекте или укажите связи между ними',
      );
    }

    const statusText = projectPeople
      .map((pp: { person: { displayName: string | null }; status: string }) => `${pp.person.displayName ?? 'без имени'}: статус ${pp.status === 'FIGURANT' ? 'фигурант' : 'персона'}`)
      .join('\n');

    const factsText = personalFacts
      .map((f: { person: { displayName: string | null }; content: string }) => `${f.person.displayName ?? 'без имени'}: ${f.content}`)
      .join('\n');

    const relationshipsText = relationships
      .map(
        (r: { personA: { displayName: string | null }; personB: { displayName: string | null }; label: string }) =>
          `${r.personA.displayName ?? 'без имени'} — ${r.personB.displayName ?? 'без имени'}: ${r.label}`,
      )
      .join('\n');

    const userPrompt = [
      `Ситуация: ${project.question}`,
      statusText ? `Статусы людей в проекте:\n${statusText}` : '',
      factsText ? `Личные факты/предпочтения (строго со слов пользователя):\n${factsText}` : '',
      relationshipsText ? `Связи между людьми:\n${relationshipsText}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt: activePrompt?.template ?? SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 1000,
        validateOutput: isValidAdvicePayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось составить советы — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const rawItems: RawAdviceItem[] = JSON.parse(result.text);

    const created = [];
    for (const item of rawItems) {
      const advice = await this.prisma.schedulerAdvice.create({
        data: { projectId, adviceText: item.adviceText, generatedByInferenceId: result.aiInferenceId },
      });
      created.push(advice);
    }
    return created;
  }

  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.schedulerAdvice.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }
}

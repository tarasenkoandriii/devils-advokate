// Пункт 38: ArchetypePerspectiveService (§3.11 ТЗ) — третья и последняя
// из фич MVP v3, отобранных как готовые СЕЙЧАС без новой
// инфраструктуры. Пункт 46 закрывает вторую ветку §3.11 ("глазами
// реальных фигурантов"), честно отложенную здесь изначально.
//
// БЛИЖАЙШИЙ АНАЛОГ — SteelmanService: тот же общий приём (AI строит
// точку зрения СО СТОРОНЫ на ситуацию проекта), но не привязан к
// конкретному Person (архетипы — внешние роли-наблюдатели, не
// фигуранты), и промпт намеренно допускает МАКСИМАЛЬНО враждебную
// интерпретацию для части архетипов (§3.11 ТЗ: "ревнивая жена" и
// "скандалист" — стресс-тест, не поиск объективной правды, в отличие
// от Steelman, который явно просит "не карикатуру").
//
// CUSTOM-архетип обязан иметь customArchetypeDescription — проверяется
// в service-слое, не в схеме (то же решение, что уже применялось к
// planOrder/triggerCondition у ProtectedNote — "осмысленно только для
// одного случая" не превращается в CHECK-constraint на уровне БД).
//
// Пункт 46 — REAL_PERSON обязателен targetPersonId, тот же принцип
// валидации. КЛЮЧЕВОЕ ОТЛИЧИЕ ОТ СТАТИЧНЫХ АРХЕТИПОВ: вместо
// фиксированного текстового описания роли (ARCHETYPE_DESCRIPTIONS)
// промпт собирается из РЕАЛЬНЫХ данных об этом конкретном человеке —
// коммуникационный профиль (Пункт 39), связи (Пункт 43), прецеденты
// поведения (Пункт 45, если уже искались) — "с учётом его известных
// позиций, прецедентов и наблюдаемого коммуникационного профиля"
// буквально из текста ТЗ. ОТЛИЧИЕ ОТ SteelmanService: Steelman строит
// САМЫЙ СИЛЬНЫЙ аргумент ЗА позицию человека (адвокат дьявола в его
// пользу), здесь — короткая реакция/вопрос/предупреждение с его точки
// зрения на СИТУАЦИЮ пользователя, тот же формат вывода, что и у
// архетипов, не новый.

import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ArchetypeType } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'archetype-perspective';

// Короткое описание каждого архетипа для промпта — то же самое, что
// уже перечислено в самом ТЗ (§3.11), не изобретено заново.
// Экспортируется — переиспользуется в SparringService (Пункт 69,
// §3.26 ТЗ: "из уже существующих в проекте архетипов"), не
// дублируется. Низкорисковая правка (статическая константа, не метод
// с побочными эффектами) — в отличие от buildRealPersonContext()
// (Пункт 55), которую сознательно НЕ рефакторили из-за риска задеть
// рабочий код в разгар большого захода.
export const ARCHETYPE_DESCRIPTIONS: Record<Exclude<ArchetypeType, 'CUSTOM' | 'REAL_PERSON'>, string> = {
  POLICE_OFFICER: 'полицейский — оценивает ситуацию с точки зрения законности',
  LAWYER: 'юрист — оценивает юридические риски',
  NEIGHBORHOOD_GRANDMOTHER: 'бабушка у подъезда — оценивает репутацию и общественное мнение',
  FINANCIAL_ANALYST: 'финансовый аналитик — оценивает денежные последствия',
  PSYCHOLOGIST: 'психолог — оценивает эмоциональные и поведенческие аспекты',
  CHILD: 'ребёнок — задаёт наивный прямой вопрос по существу',
  JEALOUS_SPOUSE: 'ревнивая жена — подозрительна, ищет скрытые мотивы и второе дно (намеренно предвзятая, максимально подозрительная трактовка)',
  TROUBLEMAKER: 'скандалист — даёт максимально конфликтную трактовку, ищет повод раздуть ссору (намеренно враждебная трактовка)',
};

const TRAIT_LABELS: Record<string, string> = {
  PREFERS_WRITTEN_COMMUNICATION: 'предпочитает письменную коммуникацию',
  PREFERS_DIRECTNESS: 'предпочитает прямоту',
  NEEDS_TIME_TO_DECIDE: 'нужно время на решение',
  RESPONDS_TO_DATA: 'реагирует на цифры/данные',
  CONFLICT_AVOIDANCE: 'наблюдаемое избегание конфликта',
  DECISION_MAKING_STYLE: 'наблюдаемый стиль принятия решений',
};

interface RawArchetypeReaction {
  reaction: string;
}

function isValidArchetypePayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && typeof parsed.reaction === 'string' && parsed.reaction.length > 0;
  } catch {
    return false;
  }
}

@Injectable()
export class ArchetypePerspectiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async generate(
    userId: string,
    projectId: string,
    archetypeType: ArchetypeType,
    customArchetypeDescription?: string,
    targetPersonId?: string,
    engineId?: string,
    focusOnOwnPositionWeaknesses = false,
  ) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);

    if (archetypeType === 'CUSTOM' && !customArchetypeDescription?.trim()) {
      throw new BadRequestException('customArchetypeDescription обязателен для архетипа CUSTOM');
    }
    if (archetypeType === 'REAL_PERSON' && !targetPersonId) {
      throw new BadRequestException('targetPersonId обязателен для REAL_PERSON');
    }

    // Пункт 54 (§3.17 ТЗ) — в режиме критики собственной позиции нужны
    // ИМЕННО аргументы пользователя "за" (то, что он сам построил в
    // свою пользу), не весь список произвольно — иначе не получится
    // прицельно показать слабости именно ЕГО аргументации.
    // project-level (targetPersonId=null) — тот же фильтр, что уже
    // применялся в OutcomeForecastingService/DecisionOutcomeService.
    const topArguments = await this.prisma.argument.findMany({
      where: focusOnOwnPositionWeaknesses
        ? { projectId, targetPersonId: null, stance: 'PRO' }
        : { projectId },
      orderBy: { weight: 'desc' },
      take: 5,
    });
    const argumentsSummary =
      topArguments.length > 0
        ? topArguments.map((a: { text: string; stance: string }) => `(${a.stance}) ${a.text}`).join('\n')
        : focusOnOwnPositionWeaknesses
          ? '(пользователь пока не сформулировал аргументы в свою пользу)'
          : '(аргументы пока не сгенерированы)';

    const perspectiveContext =
      archetypeType === 'REAL_PERSON'
        ? await this.buildRealPersonContext(userId, projectId, targetPersonId as string)
        : { label: archetypeType === 'CUSTOM' ? (customArchetypeDescription as string) : ARCHETYPE_DESCRIPTIONS[archetypeType], extra: '' };

    const userPrompt = focusOnOwnPositionWeaknesses
      ? [
          `Ситуация: ${project.question}`,
          project.goal ? `Цель пользователя: ${project.goal}` : '',
          `Аргументы, которые пользователь построил В СВОЮ ПОЛЬЗУ:\n${argumentsSummary}`,
          perspectiveContext.extra,
          `С точки зрения: ${perspectiveContext.label} — найди СЛАБЫЕ МЕСТА в этой аргументации пользователя так, как их увидел бы именно этот человек/наблюдатель, не сам пользователь. Типичная слепая зона — пользователь переоценивает силу своих аргументов, покажи, где это происходит.`,
          'Ответь СТРОГО валидным JSON-объектом вида {"reaction": string}. Без пояснений вне JSON.',
        ]
          .filter(Boolean)
          .join('\n\n')
      : [
          `Ситуация: ${project.question}`,
          project.goal ? `Цель пользователя: ${project.goal}` : '',
          `Ключевые аргументы, уже собранные пользователем:\n${argumentsSummary}`,
          perspectiveContext.extra,
          `Дай короткую реакцию/вопрос/предупреждение на эту ситуацию с точки зрения: ${perspectiveContext.label}. Это не "правильный ответ", а расширение слепых зон пользователя — покажи, на что обратил бы внимание именно этот человек/наблюдатель.`,
          'Ответь СТРОГО валидным JSON-объектом вида {"reaction": string}. Без пояснений вне JSON.',
        ]
          .filter(Boolean)
          .join('\n\n');

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    const systemPrompt =
      activePrompt?.template ??
      (archetypeType === 'REAL_PERSON'
        ? 'Ты симулируешь взгляд реального человека на ситуацию — на основе того, что о нём РЕАЛЬНО известно (наблюдения, факты, связи). Не выдумывай черты характера, которых нет в данных — если данных мало, честно дай более общую реакцию, не придумывай уверенности, которой нет.'
        : 'Ты симулируешь взгляд стороннего наблюдателя на ситуацию — честно, с точки зрения указанной роли, не сглаживая. Если роль по описанию должна быть предвзятой или враждебной — играй эту предвзятость, это стресс-тест для пользователя, не поиск объективной истины.');

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt,
        userPrompt,
        jsonMode: true,
        maxTokens: 600,
        validateOutput: isValidArchetypePayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException(
          'Запрос отклонён проверкой безопасности содержимого — переформулируйте вопрос без служебных инструкций внутри текста.',
        );
      }
      throw new BadGatewayException(
        'Не удалось построить перспективу — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const raw: RawArchetypeReaction = JSON.parse(result.text);

    return this.prisma.archetypePerspective.create({
      data: {
        projectId,
        archetypeType,
        customArchetypeDescription: archetypeType === 'CUSTOM' ? customArchetypeDescription : null,
        targetPersonId: archetypeType === 'REAL_PERSON' ? targetPersonId : null,
        focusOnOwnPositionWeaknesses,
        reaction: raw.reaction,
        generatedByInferenceId: result.aiInferenceId,
      },
    });
  }

  /** Пункт 46 — собирает контекст для REAL_PERSON из уже существующих
   * данных: коммуникационный профиль (Пункт 39), связи (Пункт 43),
   * прецеденты поведения (Пункт 45, если уже искались) + displayName.
   * Никаких новых источников данных — только то, что уже накоплено. */
  private async buildRealPersonContext(userId: string, projectId: string, personId: string) {
    const link = await this.prisma.projectPerson.findFirst({ where: { projectId, personId }, include: { person: true } });
    if (!link) {
      throw new NotFoundException(`Person ${personId} not found in project ${projectId}`);
    }

    const [traits, relationships, precedents] = await Promise.all([
      this.prisma.personCommunicationTrait.findMany({ where: { personId } }),
      this.prisma.relationship.findMany({ where: { OR: [{ personAId: personId }, { personBId: personId }] } }),
      this.prisma.behaviorPrecedent.findMany({ where: { personId }, take: 5, orderBy: { createdAt: 'desc' } }),
    ]);

    const traitsText = traits
      .map((t: { traitType: string; value: string }) => `${TRAIT_LABELS[t.traitType] ?? t.traitType}: ${t.value}`)
      .join('; ');
    const relationshipsText = relationships
      .map((r: { label: string }) => r.label)
      .join('; ');
    const precedentsText = precedents
      .map((p: { precedentDescription: string }) => p.precedentDescription)
      .join('; ');

    const parts = [`реального человека по имени ${link.person.displayName ?? 'без имени'}`];
    const extraLines = [
      traitsText ? `Наблюдаемый коммуникационный профиль этого человека: ${traitsText}.` : '',
      relationshipsText ? `Известные связи этого человека: ${relationshipsText}.` : '',
      precedentsText ? `Известные прецеденты поведения: ${precedentsText}.` : '',
      !traitsText && !relationshipsText && !precedentsText
        ? 'О нём известно немного — не выдумывай подробностей, дай более общую, осторожную реакцию.'
        : '',
    ].filter(Boolean);

    return { label: parts[0], extra: extraLines.join('\n') };
  }

  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.archetypePerspective.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }
}

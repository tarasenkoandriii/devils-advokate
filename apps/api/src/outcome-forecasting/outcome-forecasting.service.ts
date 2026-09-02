// Пункт 47: OutcomeForecastingService (§3.12 ТЗ) — доводит пункт 23
// v3-роадмапа до конца, последний в группе 20-23. Ни одного нового
// источника данных — синтезирует уже построенное в этом заходе:
// аргументы (v1), роль решающего (Пункт 44), связи (Пункт 43),
// прецеденты (Пункт 45), защищённые заметки (Пункт 28).
//
// ЧЕТЫРЕ ТИПА СЦЕНАРИЕВ (§3.12 ТЗ, буквально): DO_NOTHING (пустить на
// самотёк, базовый), ASSUME_HARM (пессимистичная гипотеза о намерениях
// ключевого фигуранта), ASSUME_HELP (оптимистичная), USER_DEFINED
// (пользовательские линии поведения — любое число, вводит сам
// пользователь). ОДИН AI-вызов на весь батч сценариев разом — не по
// вызову на каждый тип, тот же экономический аргумент, что уже
// применялся к detect()/exportFactsToVerify().
//
// "КЛЮЧЕВОЙ ФИГУРАНТ" для ASSUME_HARM/ASSUME_HELP — подтверждённый
// DECISION_MAKER из карты круга лиц (Пункт 44), если он есть. Если
// роль ещё не подтверждена ни для кого — сценарии строятся в общем
// виде, без персонализации под конкретного человека, честно, не
// выдумывая, кто это.

import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { ScenarioConfidence, ScenarioType } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'outcome-forecasting';

const TRAIT_LABELS: Record<string, string> = {
  PREFERS_WRITTEN_COMMUNICATION: 'предпочитает письменную коммуникацию',
  PREFERS_DIRECTNESS: 'предпочитает прямоту',
  NEEDS_TIME_TO_DECIDE: 'нужно время на решение',
  RESPONDS_TO_DATA: 'реагирует на цифры/данные',
  CONFLICT_AVOIDANCE: 'наблюдаемое избегание конфликта',
  DECISION_MAKING_STYLE: 'наблюдаемый стиль принятия решений',
};

interface RawScenario {
  scenarioType: 'DO_NOTHING' | 'ASSUME_HARM' | 'ASSUME_HELP' | 'USER_DEFINED';
  userDescription?: string; // должен совпадать с одним из переданных userScenarioDescriptions для USER_DEFINED
  outcomeDescription: string;
  precedentBasis?: string;
  protectedNoteHint?: string;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
}

function isValidScenarioPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    const validTypes = ['DO_NOTHING', 'ASSUME_HARM', 'ASSUME_HELP', 'USER_DEFINED'];
    const validConfidence = ['LOW', 'MEDIUM', 'HIGH'];
    return parsed.every(
      (item) =>
        validTypes.includes(item.scenarioType) &&
        typeof item.outcomeDescription === 'string' &&
        item.outcomeDescription.trim().length > 0 &&
        validConfidence.includes(item.confidence) &&
        (item.scenarioType !== 'USER_DEFINED' || typeof item.userDescription === 'string'),
    );
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Тебе дана ситуация пользователя и всё, что о ней известно: аргументы, ключевой человек (если определён) с его связями и прошлыми прецедентами, защищённые заметки (туз в рукаве/план Б). Построй прогноз по каждой из указанных линий поведения. Для КАЖДОЙ линии поведения дай: outcomeDescription — краткое описание вероятного развития событий; precedentBasis — если есть релевантные прецеденты, на что они указывают (например "в похожих случаях при таком поведении реагировал X"), иначе не указывай это поле; protectedNoteHint — если ситуация в этом сценарии похожа на условие срабатывания одной из защищённых заметок (туз/план Б), укажи текстом, какую стоит иметь в виду, иначе не указывай; confidence — LOW/MEDIUM/HIGH, грубая честная оценка уверенности, НЕ выдумывай ложную точность вроде процентов. Верни для DO_NOTHING, ASSUME_HARM, ASSUME_HELP по одному сценарию каждого, и по одному сценарию USER_DEFINED на каждую пользовательскую линию поведения (userDescription должен совпадать с тем, что дал пользователь). Ответь СТРОГО валидным JSON-массивом объектов. Без пояснений вне JSON.';

@Injectable()
export class OutcomeForecastingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async generateScenarios(userId: string, projectId: string, userScenarioDescriptions: string[] = [], engineId?: string) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);

    const [topArguments, decisionMakerLink, protectedNotes] = await Promise.all([
      this.prisma.argument.findMany({ where: { projectId, targetPersonId: null }, orderBy: { weight: 'desc' }, take: 5 }),
      this.prisma.projectPerson.findFirst({ where: { projectId, stakeholderRole: 'DECISION_MAKER' }, include: { person: true } }),
      this.prisma.protectedNote.findMany({ where: { projectId } }),
    ]);

    const argumentsSummary =
      topArguments.length > 0
        ? topArguments.map((a: { text: string; stance: string }) => `(${a.stance}) ${a.text}`).join('\n')
        : '(аргументы пока не собраны)';

    let decisionMakerContext = '(ключевой решающий человек ещё не определён в карте круга лиц — прогноз общий, не персонализированный)';
    if (decisionMakerLink) {
      const personId = decisionMakerLink.personId;
      const [traits, relationships, precedents] = await Promise.all([
        this.prisma.personCommunicationTrait.findMany({ where: { personId } }),
        this.prisma.relationship.findMany({ where: { OR: [{ personAId: personId }, { personBId: personId }] } }),
        this.prisma.behaviorPrecedent.findMany({ where: { personId }, take: 5, orderBy: { createdAt: 'desc' } }),
      ]);
      const traitsText = traits.map((t: { traitType: string; value: string }) => `${TRAIT_LABELS[t.traitType] ?? t.traitType}: ${t.value}`).join('; ');
      const relationshipsText = relationships.map((r: { label: string }) => r.label).join('; ');
      const precedentsText = precedents.map((p: { precedentDescription: string }) => p.precedentDescription).join('; ');
      decisionMakerContext = [
        `Ключевой решающий человек: ${decisionMakerLink.person.displayName ?? 'без имени'}.`,
        traitsText ? `Коммуникационный профиль: ${traitsText}.` : '',
        relationshipsText ? `Связи: ${relationshipsText}.` : '',
        precedentsText ? `Известные прецеденты поведения: ${precedentsText}.` : '',
      ]
        .filter(Boolean)
        .join(' ');
    }

    const protectedNotesText = protectedNotes
      .map((n: { type: string; content: string; triggerCondition: string | null }) => `[${n.type}] ${n.content}${n.triggerCondition ? ` (когда: ${n.triggerCondition})` : ''}`)
      .join('\n');

    const scenarioLines = ['Линии поведения для прогноза: "пустить на самотёк" (DO_NOTHING), "если цель ключевого человека — навредить" (ASSUME_HARM), "если цель ключевого человека — помочь" (ASSUME_HELP)'];
    if (userScenarioDescriptions.length > 0) {
      scenarioLines.push(`Пользовательские линии поведения (по одной на каждую, тип USER_DEFINED): ${userScenarioDescriptions.map((d, i) => `${i + 1}. "${d}"`).join('; ')}`);
    }

    const userPrompt = [
      `Ситуация: ${project.question}`,
      project.goal ? `Цель пользователя: ${project.goal}` : '',
      `Ключевые аргументы:\n${argumentsSummary}`,
      decisionMakerContext,
      protectedNotesText ? `Защищённые заметки (туз в рукаве/план Б):\n${protectedNotesText}` : '',
      scenarioLines.join('\n'),
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
        systemPrompt: activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 2000,
        validateOutput: isValidScenarioPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось построить прогноз по сценариям — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const rawScenarios: RawScenario[] = JSON.parse(result.text);
    return this.prisma.$transaction(
      rawScenarios.map((s) =>
        this.prisma.outcomeScenario.create({
          data: {
            projectId,
            scenarioType: s.scenarioType as ScenarioType,
            userDescription: s.scenarioType === 'USER_DEFINED' ? s.userDescription : null,
            outcomeDescription: s.outcomeDescription,
            precedentBasis: s.precedentBasis ?? null,
            protectedNoteHint: s.protectedNoteHint ?? null,
            confidence: s.confidence as ScenarioConfidence,
            generatedByInferenceId: result.aiInferenceId,
          },
        }),
      ),
    );
  }

  /** "Сценарии сравниваются рядом друг с другом" (§3.12 ТЗ) —
   * возвращает все сразу, сортировка по типу для стабильного порядка
   * сравнения (не по времени создания — пользователь должен видеть
   * DO_NOTHING/ASSUME_HARM/ASSUME_HELP всегда в одном месте, не вперемешку). */
  async list(userId: string, projectId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    const scenarios = await this.prisma.outcomeScenario.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    const TYPE_ORDER: Record<string, number> = { DO_NOTHING: 0, ASSUME_HARM: 1, ASSUME_HELP: 2, USER_DEFINED: 3 };
    return [...scenarios].sort((a: any, b: any) => (TYPE_ORDER[a.scenarioType] ?? 99) - (TYPE_ORDER[b.scenarioType] ?? 99));
  }

  // Пункт [prompt-framework], devils-advocate-prompt-framework-tz.md
  // §4.3 — без этого метода калибровочный gate не над чем считать:
  // "сбылся ли сценарий на самом деле" никогда раньше не фиксировалось
  // нигде в проекте. Пользователь подтверждает постфактум, когда узнал
  // реальный исход — не AI-вывод, честное свидетельство человека.
  async confirmOutcome(userId: string, projectId: string, scenarioId: string, confirmed: boolean) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    const scenario = await this.prisma.outcomeScenario.findFirst({ where: { id: scenarioId, projectId } });
    if (!scenario) {
      throw new BadRequestException(`OutcomeScenario ${scenarioId} not found in project ${projectId}`);
    }
    return this.prisma.outcomeScenario.update({
      where: { id: scenarioId },
      data: { outcomeConfirmed: confirmed, outcomeConfirmedAt: new Date() },
    });
  }
}

// Пункт 59: MotiveAnalysisService (§3.18 ТЗ) — "Имущественное
// положение и возможные интерпретации мотивов фигурантов", пункт 28
// v3-роадмапа, последний из шести пунктов v3, найденных при аудите.
// По прямому запросу, ПОСЛЕ явного обсуждения объёма.
//
// СОЗНАТЕЛЬНО НЕ РЕАЛИЗОВАНО: "имущественное положение по публичным
// источникам" (реестры недвижимости, е-декларации, судебные реестры) —
// тот же автономный поиск по конкретному частному человеку, от
// которого явно отказались для §3.9 (диалог перед Пунктом 40,
// подтверждено повторно перед Пунктом 45). Позиция не пересмотрена —
// подробное обоснование над моделью MotiveHypothesis в schema.prisma.
//
// РЕАЛИЗОВАНО: генерация СПИСКА альтернативных гипотез (не единственный
// "мотив") поверх уже накопленных личных данных — PersonFact
// (включая то, что пользователь мог вручную знать об имущественном
// положении и внести как факт сам, через Пункт 58), BehaviorPrecedent
// (Пункт 45), коммуникационный профиль (Пункт 39), связи (Пункт 43),
// сопоставление с уже существующим DecisionObjective пользователя.
// Ни одного нового источника данных — тот же принцип "синтез уже
// построенного", что уже применялся в OutcomeForecastingService
// (Пункт 47) и ReconciliationArgumentsService (Пункт 49).
//
// RATE LIMITING (§3.18 ТЗ: "поиск и анализ... ограничен рейт-лимитом
// на пользователя в день") — та же простая, но реальная защита, что
// уже применялась в PhotoVerificationService (Пункт 48): явно
// задокументированное число, не полноценная anti-stalking
// инфраструктура. Здесь риск объективно меньше, чем предполагала ТЗ
// (нет внешнего поиска, только рассуждение над уже известными
// данными), но лимит сохранён — тот же принцип "не отменять защиту
// просто потому что объём сузился".

import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { assertProjectOwnership } from '../common/project-ownership';
import { MotiveConfidenceLevel } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'motive-analysis';
const DAILY_LIMIT_PER_USER = 10; // "суммарно по разным людям" — общий счётчик, не по одному человеку

const TRAIT_LABELS: Record<string, string> = {
  PREFERS_WRITTEN_COMMUNICATION: 'предпочитает письменную коммуникацию',
  PREFERS_DIRECTNESS: 'предпочитает прямоту',
  NEEDS_TIME_TO_DECIDE: 'нужно время на решение',
  RESPONDS_TO_DATA: 'реагирует на цифры/данные',
  CONFLICT_AVOIDANCE: 'наблюдаемое избегание конфликта',
  DECISION_MAKING_STYLE: 'наблюдаемый стиль принятия решений',
};

interface RawMotiveHypothesis {
  explanation: string;
  supportingFactsSummary: string;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  alignmentWithUserGoal?: string;
  compromiseSuggestion?: string;
  suggestsFigurantStatus?: boolean;
}

function isValidMotivePayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.explanation === 'string' &&
        item.explanation.trim().length > 0 &&
        typeof item.supportingFactsSummary === 'string' &&
        ['LOW', 'MEDIUM', 'HIGH'].includes(item.confidence),
    );
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'Тебе даны известные факты, наблюдения и цель пользователя. Построй СПИСОК АЛЬТЕРНАТИВНЫХ гипотез о вероятных мотивах фигуранта в этой ситуации — НЕ единственный "правильный" мотив, а несколько правдоподобных версий. КРИТИЧЕСКИ ВАЖНО: формулируй каждую гипотезу как "возможное объяснение", НИКОГДА не как установленный факт о человеке — не пиши "его мотив — X", пиши "одно из возможных объяснений — X". Для каждой гипотезы укажи: explanation — само объяснение; supportingFactsSummary — на основании каких конкретно известных фактов строится это предположение; confidence — LOW/MEDIUM/HIGH, честная грубая оценка, не ложная точность; alignmentWithUserGoal — если есть данные о цели пользователя, в чём эта гипотеза о мотиве фигуранта совпадает или конфликтует с целью пользователя, по пунктам, не общей фразой; compromiseSuggestion — конкретное предложение, как сгладить именно этот вероятный конфликт интересов, если он есть; suggestsFigurantStatus — true, ТОЛЬКО если эта гипотеза указывает на РЕАЛЬНЫЙ, содержательный конфликт интересов между целью пользователя и вероятным мотивом фигуранта (не просто расхождение во мнениях) — иначе false, не ставь true "на всякий случай". Если фактов недостаточно для содержательной гипотезы — не выдумывай, верни меньше гипотез или пустой список. Ответь СТРОГО валидным JSON-массивом объектов вида {"explanation": string, "supportingFactsSummary": string, "confidence": "LOW"|"MEDIUM"|"HIGH", "alignmentWithUserGoal": string, "compromiseSuggestion": string, "suggestsFigurantStatus": boolean}. Без пояснений вне JSON.';

@Injectable()
export class MotiveAnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  async analyze(userId: string, projectId: string, personId: string, engineId?: string) {
    const project = await assertProjectOwnership(this.prisma, userId, projectId);
    const link = await this.prisma.projectPerson.findFirst({ where: { projectId, personId }, include: { person: true } });
    if (!link) {
      throw new NotFoundException(`Person ${personId} not found in project ${projectId}`);
    }

    await this.assertUnderRateLimit(userId);

    const [facts, precedents, traits, relationships, objective] = await Promise.all([
      this.prisma.personFact.findMany({ where: { personId, status: 'ACTIVE' } }),
      this.prisma.behaviorPrecedent.findMany({ where: { personId }, take: 5, orderBy: { createdAt: 'desc' } }),
      this.prisma.personCommunicationTrait.findMany({ where: { personId } }),
      this.prisma.relationship.findMany({ where: { OR: [{ personAId: personId }, { personBId: personId }] } }),
      this.prisma.decisionObjective.findUnique({ where: { projectId } }),
    ]);

    if (facts.length === 0 && precedents.length === 0 && traits.length === 0) {
      throw new BadRequestException(
        `Про person ${personId} пока не известно почти ничего (нет фактов/прецедентов/коммуникационного профиля) — гипотезы о мотивах строить не на чем`,
      );
    }

    const factsText = facts.map((f: { content: string }) => `- ${f.content}`).join('\n');
    const precedentsText = precedents.map((p: { precedentDescription: string }) => `- ${p.precedentDescription}`).join('\n');
    const traitsText = traits
      .map((t: { traitType: string; value: string }) => `${TRAIT_LABELS[t.traitType] ?? t.traitType}: ${t.value}`)
      .join('; ');
    const relationshipsText = relationships.map((r: { label: string }) => r.label).join('; ');

    const objectiveText = objective
      ? [
          objective.desiredOutcome ? `Желаемый исход пользователя: ${objective.desiredOutcome}` : '',
          objective.minimumAcceptableOutcome ? `Минимально приемлемо для пользователя: ${objective.minimumAcceptableOutcome}` : '',
          objective.nonNegotiables.length > 0 ? `Не подлежит обсуждению для пользователя: ${objective.nonNegotiables.join('; ')}` : '',
          objective.negotiables.length > 0 ? `Пользователь готов уступить: ${objective.negotiables.join('; ')}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '(цель пользователя пока не структурирована — Decision Objective не заполнен)';

    const userPrompt = [
      `Ситуация: ${project.question}`,
      project.goal ? `Общая цель проекта: ${project.goal}` : '',
      `Известные факты о фигуранте (${link.person.displayName ?? 'без имени'}):\n${factsText || '(фактов нет)'}`,
      precedentsText ? `Известные прецеденты поведения:\n${precedentsText}` : '',
      traitsText ? `Наблюдаемый коммуникационный профиль: ${traitsText}` : '',
      relationshipsText ? `Известные связи: ${relationshipsText}` : '',
      `Цель пользователя в этой ситуации:\n${objectiveText}`,
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
        maxTokens: 1800,
        validateOutput: isValidMotivePayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось построить гипотезы о мотивах — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const rawHypotheses: RawMotiveHypothesis[] = JSON.parse(result.text);
    return this.prisma.$transaction(
      rawHypotheses.map((h) =>
        this.prisma.motiveHypothesis.create({
          data: {
            personId,
            projectId,
            explanation: h.explanation,
            supportingFactsSummary: h.supportingFactsSummary,
            confidence: h.confidence as MotiveConfidenceLevel,
            alignmentWithUserGoal: h.alignmentWithUserGoal ?? null,
            compromiseSuggestion: h.compromiseSuggestion ?? null,
            suggestsFigurantStatus: h.suggestsFigurantStatus === true,
            generatedByInferenceId: result.aiInferenceId,
            createdByUserId: userId,
          },
        }),
      ),
    );
  }

  async list(userId: string, projectId: string, personId: string) {
    await assertProjectOwnership(this.prisma, userId, projectId);
    return this.prisma.motiveHypothesis.findMany({
      where: { projectId, personId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async assertUnderRateLimit(userId: string) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // "поиск и анализ по одному и тому же человеку И суммарно по
    // разным людям" — один общий счётчик по всем персонам разом.
    // Считаем РАЗЛИЧНЫЕ generatedByInferenceId, не строки таблицы —
    // один analyze() создаёт СРАЗУ НЕСКОЛЬКО записей MotiveHypothesis
    // (список гипотез за один вызов), подсчёт строк раздувал бы лимит
    // в разы быстрее, чем реально означает "N анализов в день".
    const recent = await this.prisma.motiveHypothesis.findMany({
      where: { createdByUserId: userId, createdAt: { gte: since } },
      select: { generatedByInferenceId: true },
    });
    const distinctAnalyses = new Set(recent.map((r: { generatedByInferenceId: string | null }) => r.generatedByInferenceId)).size;
    if (distinctAnalyses >= DAILY_LIMIT_PER_USER) {
      throw new ForbiddenException(`Достигнут дневной лимит анализа мотивов (${DAILY_LIMIT_PER_USER}/день) — попробуйте завтра`);
    }
  }
}

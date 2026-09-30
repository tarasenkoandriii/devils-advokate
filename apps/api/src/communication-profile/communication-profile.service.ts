// Пункт 39: CommunicationProfileService (§3.11 ТЗ текст, роадмап-пункт
// 24 v3) — закрывает пробел, честно зафиксированный в Пункте 38 при
// построении Archetype Perspective: "глазами реальных фигурантов"
// (вторая ветка §3.11) требовала Person.communicationProfile, которого
// не было. Теперь есть.
//
// PERSON_GLOBAL, не project-scoped — см. подробное обоснование над
// моделью PersonCommunicationTrait в schema.prisma. Ownership
// проверяется напрямую через Person.createdByUserId (тот же паттерн,
// что PrivacyCenterService), без обхода через конкретный проект — тот
// же принцип, что уже применяется к FactScope.PERSON_GLOBAL.
//
// НАКОПИТЕЛЬНОЕ ОБНОВЛЕНИЕ: refresh() пересчитывает признаки заново по
// ВСЕЙ доступной истории (не diff-мерж дельты) при каждом вызове, но
// СОХРАНЕНИЕ — upsert по @@unique([personId, traitType]), не
// дублирующая запись. "Дата последнего наблюдения" в терминах ТЗ — это
// момент последнего refresh(), не момент отдельного разговора,
// который дал наибольший вклад в вывод.

import { personLevelFactsScopeWhere } from '../common/fact-scope';
import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hasPersonVerdict, NO_PERSON_VERDICT_RULE } from '../common/no-person-verdict';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { CommunicationTraitType, ConversationProcessingStatus, PersonCommunicationTrait } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { factsBlockWithInstruction } from '../common/fact-provenance';
import { orderLabel } from '../common/server-time';
import { ConsentService } from '../consent/consent.service';
import { ConsentType } from '@prisma/client';

const TASK_TYPE = 'communication-profile';

// Те же шесть признаков, что перечислены буквально в тексте ТЗ — не
// изобретены заново.
const TRAIT_LABELS: Record<CommunicationTraitType, string> = {
  PREFERS_WRITTEN_COMMUNICATION: 'предпочитает письменную коммуникацию',
  PREFERS_DIRECTNESS: 'предпочитает прямоту',
  NEEDS_TIME_TO_DECIDE: 'нужно время на решение',
  RESPONDS_TO_DATA: 'реагирует на цифры/данные',
  CONFLICT_AVOIDANCE: 'наблюдаемое избегание конфликта',
  DECISION_MAKING_STYLE: 'наблюдаемый стиль принятия решений',
};

interface RawTrait {
  traitType: keyof typeof TRAIT_LABELS;
  value: string; // текстовое описание наблюдения, не булев флаг — см. обоснование в schema.prisma
  confidence?: number;
  observedFrom: string; // текстовое описание источника — обязательно, см. isValidProfilePayload()
}

/** Пункт [the-second-line-stood-elsewhere] 2026-09-30 — вторая линия
 * защиты стояла не у тех разборов, предмет которых — человек.
 *
 * `hasPersonVerdict` применялся в ТРЁХ местах: детектор манипуляций,
 * живой детектор манипуляций, паралингвистика. Все три разбирают ПРИЁМ
 * В РЕПЛИКЕ. А у разборов, чей предмет — САМ НАЗВАННЫЙ ЧЕЛОВЕК
 * (портрет общения, прецеденты его поведения, гипотезы о его мотивах),
 * стоял ТОЛЬКО промпт. Собственный реестр продукта
 * (`consent/person-research.ts`, `PERSON_RESEARCH_GATED`) называет эти
 * три сайта поимённо — то есть проект знал, где предмет опаснее всего,
 * и вторую линию там не поставил.
 *
 * Шапка `no-person-verdict.ts` сама говорит, зачем вторая линия: «он
 * ГРУБЫЙ… Первая линия — промпт; это вторая, на случай, когда первая
 * не сработала». И её же шапка говорит, что сравнивались ДВА разбора —
 * на этом сверка и остановилась. */
function isValidProfilePayload(text: string): boolean {
  if (hasPersonVerdict(text)) return false;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return false;
    return parsed.every(
      (item) =>
        typeof item.traitType === 'string' &&
        Object.keys(TRAIT_LABELS).includes(item.traitType) &&
        typeof item.value === 'string' &&
        item.value.trim().length > 0 &&
        typeof item.observedFrom === 'string' &&
        item.observedFrom.trim().length > 0 &&
        (item.confidence === undefined || typeof item.confidence === 'number'),
    );
  } catch {
    return false;
  }
}

const DEFAULT_SYSTEM_PROMPT = `Тебе даны факты о человеке и текст его реплик из нескольких разговоров. НЕ навешивай готовый психологический тип личности (MBTI, Big Five и подобное) — это признано ненадёжным подходом. Вместо этого извлеки ТОЛЬКО то, что реально НАБЛЮДАЕТСЯ в данных, по шести конкретным признакам: ${Object.entries(
  TRAIT_LABELS,
)
  .map(([key, label]) => `${key} (${label})`)
  .join(', ')}. Для каждого признака, который реально подтверждается данными (не для всех шести обязательно — если данных недостаточно для какого-то признака, просто не включай его), укажи: traitType — один из перечисленных ключей, value — конкретное текстовое описание наблюдения (не true/false, а нюанс — например "не соглашается сразу, обычно просит день подумать"), observedFrom — на основании какого конкретного разговора или факта сделан вывод, confidence — число от 0 до 1. Ответь СТРОГО валидным JSON-массивом объектов вида {"traitType": string, "value": string, "observedFrom": string, "confidence": number}. Если данных недостаточно ни для одного признака — верни пустой массив []. Без пояснений вне JSON.` +
  ' ' +
  NO_PERSON_VERDICT_RULE;

@Injectable()
export class CommunicationProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
    private readonly consent: ConsentService,
  ) {}

  async refresh(userId: string, personId: string) {
    // Пункт [consent-that-could-not-be-given] 2026-09-24: предмет этого
    // разбора — названный человек, и решение владельца (§16.0 ТЗ)
    // требует для таких разборов ОТДЕЛЬНОГО согласия. Граница и обе её
    // стороны — в common-реестре `consent/person-research.ts`.
    await this.consent.requireConsent(userId, ConsentType.PERSON_RESEARCH);
    await this.findOwnedPerson(userId, personId);

    const [facts, conversations] = await Promise.all([
      // Пункт [scope-not-applied] 2026-09-06 — портрет общения строится
      // на уровне человека осознанно (см. заголовок файла), поэтому
      // правило здесь слабее проектного.
      this.prisma.personFact.findMany({
        where: { personId, status: 'ACTIVE', ...personLevelFactsScopeWhere() },
      }),
      this.prisma.conversation.findMany({
        where: {
          status: { in: [ConversationProcessingStatus.TRANSCRIBED, ConversationProcessingStatus.ANALYZED] },
          participants: { some: { personId } },
        },
        include: {
          transcript: {
            include: { segments: { where: { participant: { personId } } } },
          },
        },
        orderBy: { occurredAt: 'desc' },
      }),
    ]);

    if (facts.length === 0 && conversations.length === 0) {
      throw new BadRequestException(
        `Person ${personId} has no facts or analyzed conversations yet — nothing to observe a communication profile from`,
      );
    }

    const factsSummary =
      facts.length > 0 ? factsBlockWithInstruction(facts) : '(фактов нет)';
    const conversationsSummary = conversations
      // Пункт [server-said-which-day] 2026-09-24: порядок вместо числа
      // по UTC — см. common/server-time.ts.
      .map((c: any, i: number, all: any[]) => {
        const text = (c.transcript?.segments ?? []).map((s: any) => s.text).join(' ');
        return text ? `(разговор ${orderLabel(i, all.length, true)}) ${text}` : null;
      })
      .filter(Boolean)
      .join('\n\n');

    const userPrompt = `Факты о человеке, каждый с указанием происхождения:\n${factsSummary}\n\nЕго реплики из прошлых разговоров:\n${conversationsSummary || '(реплик пока нет)'}`;

    const activePrompt = await this.prisma.promptVersion.findFirst({
      where: { promptId: TASK_TYPE, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    const systemPrompt = activePrompt?.template ?? DEFAULT_SYSTEM_PROMPT;

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        taskType: TASK_TYPE,
        promptVersionId: activePrompt?.id,
        systemPrompt,
        userPrompt,
        jsonMode: true,
        maxTokens: 1200,
        validateOutput: isValidProfilePayload,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Анализ отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException(
        'Не удалось обновить коммуникационный профиль — AI-провайдер недоступен или вернул некорректный ответ.',
      );
    }

    const rawTraits: RawTrait[] = JSON.parse(result.text);
    const now = new Date();

    // Накопительное обновление — upsert по @@unique([personId, traitType]),
    // не создание дублирующей записи при каждом refresh().
    const updated: PersonCommunicationTrait[] = [];
    for (const trait of rawTraits) {
      const record = await this.prisma.personCommunicationTrait.upsert({
        where: { personId_traitType: { personId, traitType: trait.traitType as CommunicationTraitType } },
        create: {
          personId,
          traitType: trait.traitType as CommunicationTraitType,
          value: trait.value,
          confidence: trait.confidence ?? null,
          observedFrom: trait.observedFrom,
          lastObservedAt: now,
          generatedByInferenceId: result.aiInferenceId,
        },
        update: {
          value: trait.value,
          confidence: trait.confidence ?? null,
          observedFrom: trait.observedFrom,
          lastObservedAt: now,
          generatedByInferenceId: result.aiInferenceId,
        },
      });
      updated.push(record);
    }

    return updated;
  }

  async get(userId: string, personId: string) {
    await this.findOwnedPerson(userId, personId);
    return this.prisma.personCommunicationTrait.findMany({
      where: { personId },
      orderBy: { traitType: 'asc' },
    });
  }

  private async findOwnedPerson(userId: string, personId: string) {
    const person = await this.prisma.person.findFirst({ where: { id: personId, createdByUserId: userId } });
    if (!person) {
      throw new NotFoundException(`Person ${personId} not found`);
    }
    return person;
  }
}

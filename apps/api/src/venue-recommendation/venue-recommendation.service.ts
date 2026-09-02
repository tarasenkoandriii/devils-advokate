// Пункт 65: VenueRecommendationService (§3.22 ТЗ) — "Партнёрка с
// заведениями — бронирование места для встречи (монетизация)", пункт
// 40 общего списка v4-роадмапа. По прямому запросу, в честно суженном
// объёме — нереализованное вынесено в /TODO.md.
//
// СОЗНАТЕЛЬНО НЕ РЕАЛИЗОВАНО (подробное обоснование — над моделью
// VenueRecommendation в schema.prisma и в /TODO.md): монетизация/
// комиссия (требует §3.23, ещё не построенной партнёрской базы) и
// автоматическое бронирование через API (не существует для
// произвольных заведений) — реализованы только контакты для
// самостоятельного бронирования.
//
// СЫРОЙ ТЕКСТ ОТЗЫВОВ GOOGLE НИКОГДА НЕ ПЕРСИСТИТСЯ — используется
// только для одного AI-вызова (парафраз), переменная с текстом
// отзывов выходит из области видимости сразу после вызова, не
// попадает ни в один аргумент create().

import { BadGatewayException, BadRequestException, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentService } from '../consent/consent.service';
import { ConsentType, VenueRecommendation } from '@prisma/client';
import { getPlaceDetails, searchNearbyVenues } from './google-places-client';

const GOOGLE_PLACES_API_KEY_REF = 'GOOGLE_PLACES_API_KEY';
const TASK_TYPE = 'venue-suitability';
const MAX_CANDIDATES = 3;

interface RawSuitability {
  suitabilityReason: string;
  reviewSummary: string | null;
}

function isValidSuitabilityPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && typeof parsed.suitabilityReason === 'string' && parsed.suitabilityReason.trim().length > 0;
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT =
  'Тебе дано название заведения и, возможно, тексты отзывов о нём. Задачи: (1) suitabilityReason — короткая оценка, подходит ли это место для приватного, спокойного разговора один на один (тихая атмосфера лучше шумного места, наличие отдельных столиков и т.д.) — это ТВОЯ ОЦЕНКА, не факт; (2) reviewSummary — ТОЛЬКО если даны тексты отзывов: очень короткий ПАРАФРАЗ общего тона отзывов СВОИМИ СЛОВАМИ, НИ ОДНО предложение не должно быть скопировано из исходных отзывов дословно, не приводи прямые цитаты. Если отзывов не дано — верни reviewSummary: null. Ответь СТРОГО валидным JSON-объектом вида {"suitabilityReason": string, "reviewSummary": string | null}. Без пояснений вне JSON.';

@Injectable()
export class VenueRecommendationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
    private readonly secrets: SecretsService,
    private readonly consent: ConsentService,
  ) {}

  async generate(userId: string, scheduledConversationId: string, latitude: number, longitude: number) {
    // Пункт 77 (§3.32 ТЗ) — единый геозапрос, та же проверка, что
    // теперь добавлена в OnboardingService.suggestFromLocation() и
    // уже была в WeatherForecastService.generateByGeolocation().
    await this.consent.requireConsent(userId, ConsentType.LOCATION);

    const scheduled = await this.assertOwnedScheduledConversation(userId, scheduledConversationId);

    const apiKey = await this.secrets.resolve(GOOGLE_PLACES_API_KEY_REF);

    let candidates;
    try {
      candidates = await searchNearbyVenues(latitude, longitude, apiKey);
    } catch (err) {
      throw new BadGatewayException(err instanceof Error ? err.message : 'Google Places недоступен');
    }
    if (candidates.length === 0) {
      throw new BadRequestException('Поблизости не найдено подходящих заведений');
    }

    const created: VenueRecommendation[] = [];
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      let details;
      try {
        details = await getPlaceDetails(candidate.placeId, apiKey);
      } catch {
        continue; // одно заведение не отдало детали — пропускаем, не роняем всю генерацию
      }

      // Сырой текст отзывов живёт только в этой локальной переменной,
      // используется один раз ниже для AI-вызова и никогда не попадает
      // в create() — см. обоснование в шапке файла.
      const reviewTexts = details.reviewTexts;

      const userPrompt = [`Заведение: ${details.name}`, reviewTexts.length > 0 ? `Отзывы:\n${reviewTexts.join('\n---\n')}` : '(отзывов нет)'].join(
        '\n\n',
      );

      const activePrompt = await this.prisma.promptVersion.findFirst({
        where: { promptId: TASK_TYPE, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
      });

      let result;
      try {
        result = await this.aiRouter.execute({
          userId,
          projectId: scheduled.projectId,
          taskType: TASK_TYPE,
          promptVersionId: activePrompt?.id,
          systemPrompt: activePrompt?.template ?? SYSTEM_PROMPT,
          userPrompt,
          jsonMode: true,
          maxTokens: 500,
          validateOutput: isValidSuitabilityPayload,
        });
      } catch (err) {
        // [ai-errors] 2026-09-02: здесь ОСОЗНАННО НЕ общий шлюз
      // rethrowClientVisibleAiError. Это точка ЧЕСТНОЙ ДЕГРАДАЦИИ:
      // отсутствие модели (не засеяна база, нет ключа) обязано
      // деградировать, как и любой другой сбой AI, а не ронять фичу
      // целиком — иначе шлюз, задуманный как «конфигурация не должна
      // выглядеть отказом», сам превратил бы конфигурацию в отказ.
      // Наружу уходит только отсутствие прав.
      if (err instanceof ForbiddenException) throw err;
        if (err instanceof AIRouterContentBlockedError) continue; // одно заведение отклонено фильтром — пропускаем, не роняем всё
        continue; // AI недоступен для этого конкретного заведения — пропускаем, пробуем следующее
      }

      const raw: RawSuitability = JSON.parse(result.text);
      const venue = await this.prisma.venueRecommendation.create({
        data: {
          scheduledConversationId,
          placeId: candidate.placeId,
          name: details.name,
          address: details.address,
          phone: details.phone,
          rating: details.rating,
          reviewSummary: raw.reviewSummary,
          suitabilityReason: raw.suitabilityReason,
          generatedByInferenceId: result.aiInferenceId,
        },
      });
      created.push(venue);
    }

    if (created.length === 0) {
      throw new BadGatewayException('Не удалось получить рекомендации ни по одному из найденных заведений');
    }
    return created;
  }

  async list(userId: string, scheduledConversationId: string) {
    await this.assertOwnedScheduledConversation(userId, scheduledConversationId);
    return this.prisma.venueRecommendation.findMany({
      where: { scheduledConversationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async assertOwnedScheduledConversation(userId: string, scheduledConversationId: string) {
    const scheduled = await this.prisma.scheduledConversation.findFirst({
      where: { id: scheduledConversationId, project: { ownerId: userId } },
    });
    if (!scheduled) {
      throw new NotFoundException(`ScheduledConversation ${scheduledConversationId} not found`);
    }
    return scheduled;
  }
}

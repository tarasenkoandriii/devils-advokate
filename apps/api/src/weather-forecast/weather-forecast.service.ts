// Пункт 76: WeatherForecastService (§3.21 ТЗ) — "Виджет погоды и
// рекомендация о переносе разговора", пункт 39 общего списка
// v4-роадмапа. По прямому запросу.
//
// ДВА ПУТИ ЗАПРОСА, РАЗНАЯ ПРИВАТНОСТЬ — buкально требование ТЗ:
// (1) ручной ввод города — простая текстовая строка, не требует
// согласия, cityLabel сохраняется как есть; (2) разовая эфемерная
// геолокация устройства — требует ConsentType.LOCATION, координаты
// используются ТОЛЬКО транзитно, никогда не попадают в create().
//
// РЕКОМЕНДАЦИЯ — 🟡 ЭВРИСТИКА, НЕ ДИАГНОЗ — buкально ТЗ: "на основе
// общих поведенческих корреляций... а не жёсткое правило". AI
// формулирует конкретное обоснование, не абстрактный ярлык.

import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../secrets/secrets.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConsentService } from '../consent/consent.service';
import { geocodeCity, getForecast, type Coordinates, type ForecastResult } from './open-meteo-client';
import { getWindyForecast } from './windy-client';
import { ConsentType, WeatherRecommendation } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';

const TASK_TYPE = 'weather-recommendation';
const WINDY_API_KEY_REF = 'WINDY_API_KEY';

interface RawRecommendation {
  recommendation: 'PROCEED' | 'RECONSIDER';
  reason: string;
}

function isValidRecommendationPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return (
      (parsed.recommendation === 'PROCEED' || parsed.recommendation === 'RECONSIDER') &&
      typeof parsed.reason === 'string' &&
      parsed.reason.trim().length > 0
    );
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT =
  'Тебе дан прогноз погоды на время запланированного разговора. Оцени, стоит ли провести разговор как запланировано (PROCEED) или лучше перенести (RECONSIDER) — ТОЛЬКО на основе общих поведенческих корреляций (резкая непогода/экстремальная жара/гроза — фактор дополнительного раздражения и снижения концентрации), НЕ жёсткое правило и НЕ диагноз конкретной ситуации людей. В подавляющем большинстве случаев (обычная погода) ответ должен быть PROCEED — RECONSIDER только для действительно неблагоприятных условий. reason — короткое конкретное обоснование по погоде, не общая фраза. Ответь СТРОГО валидным JSON вида {"recommendation": "PROCEED"|"RECONSIDER", "reason": string}. Без пояснений вне JSON.';

@Injectable()
export class WeatherForecastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
    private readonly consent: ConsentService,
    private readonly secrets: SecretsService,
  ) {}

  /** Расширение на будущее (2026-08-30, по прямому запросу) — Windy
   * первичным источником, Open-Meteo — fallback. Windy требует платного/
   * freemium ключа (в отличие от бесплатного и не требующего ключа
   * Open-Meteo), поэтому при отсутствии WINDY_API_KEY код тихо НЕ
   * пытается его использовать вообще — не лишняя сетевая попытка на
   * заведомо не настроенный сервис, не лишний лог ошибки. Любая другая
   * ошибка Windy (сеть, 4xx/5xx, неожиданная форма ответа) — тоже честно
   * падает на Open-Meteo, не наружу пользователю: Open-Meteo как fallback
   * должен покрывать Windy надёжнее, чем наоборот (бесплатный сервис без
   * ключа не может отказать по причине "квота/биллинг", в отличие от
   * платного). */
  private async getForecastWithFallback(coords: Coordinates, targetDate: Date): Promise<ForecastResult> {
    const windyKey = await this.secrets.resolve(WINDY_API_KEY_REF).catch(() => null);
    if (windyKey) {
      try {
        return await getWindyForecast(windyKey, coords, targetDate);
      } catch {
        // fall through — Open-Meteo ниже
      }
    }
    return getForecast(coords, targetDate);
  }

  /** "По городу, который пользователь указывает вручную" — не
   * требует согласия, простая текстовая строка. */
  async generateByCity(userId: string, scheduledConversationId: string, cityName: string, engineId?: string) {
    if (!cityName.trim()) {
      throw new BadRequestException('cityName не может быть пустым');
    }
    const scheduled = await this.assertOwnedScheduledConversation(userId, scheduledConversationId);

    const coords = await geocodeCity(cityName.trim()).catch((err) => {
      throw new BadGatewayException(err instanceof Error ? err.message : 'Не удалось найти город');
    });
    if (!coords) {
      throw new BadRequestException(`Город «${cityName}» не найден`);
    }

    return this.generateFromCoords(userId, scheduled, coords, cityName.trim(), engineId);
  }

  /** "Разовая эфемерная геолокация устройства только для запроса
   * прогноза, без сохранения координат" — требует явного opt-in
   * (ConsentType.LOCATION), координаты никогда не персистятся. */
  async generateByGeolocation(
    userId: string,
    scheduledConversationId: string,
    latitude: number,
    longitude: number,
    engineId?: string,
  ) {
    await this.consent.requireConsent(userId, ConsentType.LOCATION);
    const scheduled = await this.assertOwnedScheduledConversation(userId, scheduledConversationId);

    // cityLabel НЕ ПРОСТАВЛЯЕТСЯ здесь намеренно — см. обоснование в
    // schema.prisma над моделью WeatherForecast: обратное
    // геокодирование в название города было бы той же геопривязкой
    // другими словами.
    return this.generateFromCoords(userId, scheduled, { latitude, longitude }, null, engineId);
  }

  private async generateFromCoords(
    userId: string,
    scheduled: { id: string; scheduledAt: Date; projectId: string },
    coords: { latitude: number; longitude: number },
    cityLabel: string | null,
    engineId?: string,
  ) {
    const forecast = await this.getForecastWithFallback(coords, scheduled.scheduledAt).catch((err) => {
      throw new BadGatewayException(err instanceof Error ? err.message : 'Не удалось получить прогноз погоды');
    });

    const { recommendation, reason, aiInferenceId } = await this.computeRecommendation(
      userId,
      scheduled.projectId,
      scheduled.scheduledAt,
      forecast,
      engineId,
    );

    return this.prisma.weatherForecast.create({
      data: {
        scheduledConversationId: scheduled.id,
        cityLabel,
        temperatureCelsius: forecast.temperatureCelsius,
        condition: forecast.condition,
        recommendation,
        recommendationReason: reason,
        generatedByInferenceId: aiInferenceId,
      },
    });
  }

  /** Общая логика "прогноз → AI-рекомендация", вынесена из
   * generateFromCoords() без изменения его поведения — переиспользуется
   * ниже в previewForScheduling() (Пункт 78, §3.20 ТЗ) для
   * непёрсистентного предпросмотра в форме создания встречи. */
  private async computeRecommendation(
    userId: string,
    projectId: string,
    targetDate: Date,
    forecast: { condition: string; temperatureCelsius: number | null },
    engineId?: string,
  ): Promise<{ recommendation: WeatherRecommendation; reason: string; aiInferenceId: string | null }> {
    const userPrompt = [
      `Дата и время разговора: ${targetDate.toISOString()}`,
      `Погода: ${forecast.condition}${forecast.temperatureCelsius !== null ? `, ${forecast.temperatureCelsius}°C` : ''}`,
    ].join('\n');

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
        maxTokens: 300,
        validateOutput: isValidRecommendationPayload,
        preferredModelVersionId: engineId,
      });
    } catch (err) {
      rethrowClientVisibleAiError(err); // [ai-errors]: 403/429 и «нет модели» идут наружу как есть
      if (err instanceof AIRouterContentBlockedError) {
        throw new BadRequestException('Запрос отклонён проверкой безопасности содержимого.');
      }
      throw new BadGatewayException('Не удалось составить рекомендацию — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const raw: RawRecommendation = JSON.parse(result.text);
    return {
      recommendation: raw.recommendation === 'RECONSIDER' ? WeatherRecommendation.RECONSIDER : WeatherRecommendation.PROCEED,
      reason: raw.reason,
      aiInferenceId: result.aiInferenceId,
    };
  }

  // ═══════════════════════ Пункт 78 (§3.20 ТЗ) ═══════════════════════
  //
  // "Мягкое предупреждение прямо в форме создания, если для уже
  // сохранённых координат есть неблагоприятный прогноз" — по прямому
  // запросу. "Уже сохранённые координаты" — ЕДИНСТВЕННОЕ исключение
  // из принципа "без постоянной геопривязки" во всём проекте:
  // подтверждённый профильный город из онбординга (User.city, §3.24),
  // который "постоянно хранится... отдельным согласием" — buкально
  // ТЗ. Сами координаты по-прежнему никогда не сохраняются — здесь
  // используется уже сохранённое НАЗВАНИЕ ГОРОДА, тот же путь, что
  // "ручной ввод города" (geocodeCity), не согласие на геолокацию.
  //
  // НЕ ПЕРСИСТИРУЕТСЯ ВООБЩЕ — чистый предпросмотр для формы, до того
  // как запланированная встреча (ScheduledConversation) физически
  // существует, создавать её ради предпросмотра погоды не нужно.
  //
  // МАКСИМАЛЬНО ТЕРПИМО К ОШИБКАМ, НИКОГДА НЕ БРОСАЕТ — "мягкое
  // предупреждение" не должно мешать пользователю создать встречу
  // из-за недоступности внешнего погодного API или AI-провайдера.
  // Любая ошибка на любом шаге — тихий null, форма создания работает
  // как прежде.
  async previewForScheduling(userId: string, projectId: string, targetDate: Date, engineId?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { city: true } });
    if (!user?.city) return null; // честно — нет сохранённого профильного города, нечего проверять

    const coords = await geocodeCity(user.city).catch(() => null);
    if (!coords) return null;

    const forecast = await this.getForecastWithFallback(coords, targetDate).catch(() => null);
    if (!forecast) return null;

    const computed = await this.computeRecommendation(userId, projectId, targetDate, forecast, engineId).catch(() => null);
    if (!computed) return null;

    return {
      cityLabel: user.city,
      temperatureCelsius: forecast.temperatureCelsius,
      condition: forecast.condition,
      recommendation: computed.recommendation,
      recommendationReason: computed.reason,
    };
  }

  async list(userId: string, scheduledConversationId: string) {
    await this.assertOwnedScheduledConversation(userId, scheduledConversationId);
    return this.prisma.weatherForecast.findMany({ where: { scheduledConversationId }, orderBy: { createdAt: 'desc' } });
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

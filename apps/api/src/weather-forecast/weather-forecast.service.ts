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

import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WEATHER_SPEND, spendOutwardCall } from '../common/outward-spend';
import { assertProjectOwnership } from '../common/project-ownership';
import { SecretsService } from '../secrets/secrets.service';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';
import { ConsentService } from '../consent/consent.service';
import { geocodeCity, getForecast, forecastHasData, noForecastDataReason, type Coordinates, type ForecastResult } from './open-meteo-client';
import { getWindyForecast } from './windy-client';
import { ConsentType, WeatherRecommendation } from '@prisma/client';
import { rethrowClientVisibleAiError } from '../common/ai-error-passthrough';
import { LOCATION_PURPOSES } from '../consent/location-purposes';
import { instantUtc } from '../common/server-time';
import { isEnumValue } from '../common/enum-values';

const TASK_TYPE = 'weather-recommendation';
const WINDY_API_KEY_REF = 'WINDY_API_KEY';

interface RawRecommendation {
  recommendation: 'PROCEED' | 'RECONSIDER';
  reason: string;
}

// Экспортируется ради проверки на ПОВЕДЕНИИ: сверка принимает КАЖДОЕ
// значение перечисления (Пункт [enum-copy-drifted] 2026-09-29).
export function isValidRecommendationPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return (
      isEnumValue(WeatherRecommendation, parsed.recommendation) &&
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
  // Пункт [the-branch-that-could-not-be-reached] 2026-10-01: логгера у
  // этого сервиса не было ВООБЩЕ — а он единственный, кто видит отказ
  // платного источника погоды.
  private readonly logger = new Logger(WeatherForecastService.name);

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
  private async getForecastWithFallback(
    userId: string,
    coords: Coordinates,
    targetDate: Date,
  ): Promise<ForecastResult> {
    // Пункт [the-policy-was-obeyed-by-hope] 2026-09-30: потолка не было
    // ни у одного из трёх маршрутов прогноза. Windy платный и
    // вызывается ПЕРВЫМ, когда ключ задан, — то есть расход появлялся
    // ровно в той конфигурации, где о нём никто не считал. Потолок
    // стоит на ОБОИХ источниках: поставить его только на платный
    // значило бы, что он исчезает у владельца, который ключ не
    // выставил, — а квота и частота у бесплатного сервиса тоже не
    // бесконечны.
    //
    // Отметка ДО обращения, как у остальных: неудачная попытка тоже
    // считается. Один вызов этой функции — один расход, даже если
    // внутри случится фоллбек с Windy на Open-Meteo: платный запрос
    // уже сделан.
    await spendOutwardCall(this.prisma, userId, WEATHER_SPEND, 'weather-forecast');

    const windyKey = await this.secrets.resolve(WINDY_API_KEY_REF).catch(() => null);
    if (windyKey) {
      try {
        return await getWindyForecast(windyKey, coords, targetDate);
      } catch (err) {
        // Пункт [the-branch-that-could-not-be-reached] 2026-10-01: здесь
        // был ГОЛЫЙ `catch {}` без единой строки в логе, и у сервиса
        // вообще не было логгера. Платный первичный источник мог
        // отказывать НА КАЖДОМ вызове — расход уже списан выше, — и
        // единственным следом оставалась колонка `source` в строке
        // результата. Тот же класс, что уже закрывали в
        // `text-to-speech.service.ts`: «голый catch глотал ЛЮБОЙ отказ…
        // продукт продолжал бы платить и не сказал бы об этом никому».
        //
        // Человеку здесь говорить нечего — прогноз он получит, просто из
        // запасного источника, и это честно отражено в `source`. А вот
        // владельцу, который за Windy платит, знать обязательно.
        this.logger.warn(
          `Windy отказал, прогноз берётся из Open-Meteo: ${err instanceof Error ? err.message : String(err)}`,
        );
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
    await this.consent.requireConsent(userId, ConsentType.LOCATION, undefined, LOCATION_PURPOSES.WEATHER);
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
    const forecast = await this.getForecastWithFallback(userId, coords, scheduled.scheduledAt).catch((err) => {
      throw new BadGatewayException(err instanceof Error ? err.message : 'Не удалось получить прогноз погоды');
    });

    // Пункт [forecast-without-source] 2026-09-06 — БЕЗ ДАННЫХ СОВЕТА НЕ
    // БУДЕТ. Раньше пустой ответ сервиса превращался в строку «нет
    // данных», уходил в промпт как описание погоды, и модель выдавала
    // «проводить / перенести» с обоснованием. Человек читал это как
    // вывод о своей встрече. Модель здесь больше не вызывается вовсе:
    // платить за вывод из ничего незачем, и сам вывод не нужен.
    if (!forecastHasData(forecast)) {
      return this.prisma.weatherForecast.create({
        data: {
          scheduledConversationId: scheduled.id,
          cityLabel,
          temperatureCelsius: null,
          condition: null,
          source: forecast.source,
          recommendation: null,
          recommendationReason: noForecastDataReason(forecast.source),
          generatedByInferenceId: null,
        },
      });
    }

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
        source: forecast.source,
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
    // Пункт [forecast-without-source] 2026-09-06: сюда попадает только
    // прогноз С ХОТЬ КАКИМИ-ТО данными — полностью пустой отсекается
    // вызывающим. Но «хоть какие-то» бывают и половинчатыми: сервис
    // отдал температуру и не отдал описание. Тогда промпт так и
    // говорит, а не подставляет пустую строку вместо погоды.
    forecast: { condition: string | null; temperatureCelsius: number | null },
    engineId?: string,
  ): Promise<{ recommendation: WeatherRecommendation; reason: string; aiInferenceId: string | null }> {
    const temp = forecast.temperatureCelsius !== null ? `${forecast.temperatureCelsius}°C` : null;
    const weatherLine =
      forecast.condition !== null
        ? `Погода: ${forecast.condition}${temp ? `, ${temp}` : ''}`
        : `Погода: описание сервис не дал, известна только температура ${temp}. Не достраивай описание — его нет.`;
    // Пункт [server-said-which-day] 2026-09-24: полный ISO честен, но
    // модель, пересказывая его человеку, роняет «Z» — и «01:00 UTC»
    // становится «в час ночи», хотя у человека было четыре утра. Зона
    // названа словами.
    const userPrompt = [`Дата и время разговора: ${instantUtc(targetDate)}`, weatherLine].join('\n');

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
    // Аудит 2026-09-03 (сверка доступа): единственный маршрут домена, где
    // projectId из URL принимался без проверки владения. Чужого он не
    // читал и не писал (город берётся из своего профиля), но тратил
    // AI-вызов на произвольный чужой id — и оставался единственным
    // исключением из правила «projectId проверяется всегда».
    await assertProjectOwnership(this.prisma, userId, projectId);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { city: true } });
    if (!user?.city) return null; // честно — нет сохранённого профильного города, нечего проверять

    const coords = await geocodeCity(user.city).catch(() => null);
    if (!coords) return null;

    const forecast = await this.getForecastWithFallback(userId, coords, targetDate).catch(() => null);
    if (!forecast) return null;

    // Пункт [forecast-without-source] 2026-09-06: предпросмотр честен
    // так же, как сохраняемый прогноз. Мягкое предупреждение в форме
    // создания встречи — тоже совет, и из пустого ответа сервиса его
    // делать нельзя.
    if (!forecastHasData(forecast)) {
      return {
        cityLabel: user.city,
        temperatureCelsius: null,
        condition: null,
        source: forecast.source,
        recommendation: null,
        recommendationReason: noForecastDataReason(forecast.source),
      };
    }

    const computed = await this.computeRecommendation(userId, projectId, targetDate, forecast, engineId).catch(() => null);
    if (!computed) return null;

    return {
      cityLabel: user.city,
      temperatureCelsius: forecast.temperatureCelsius,
      condition: forecast.condition,
      source: forecast.source,
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

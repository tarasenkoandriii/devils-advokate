// Онбординг-данные (§3.24 ТЗ) — вне 13 пунктов MVP, добавлено по
// прямому запросу отдельным проходом. religion default — NULL ("не
// указывать"), это P0-исправление более раннего аудита не отменено
// само по себе — по-прежнему НИЧЕГО не проставляется автоматически,
// пользователь всегда видит "не указывать" как явный, лёгкий вариант.
//
// Пункт 49: country + suggestFromLocation() добавлены по прямому,
// осознанному запросу пользователя, отменяющему более раннюю P0-
// рекомендацию НЕ делать автоподсказку конфессии по стране —
// подробная история решения задокументирована над полем country в
// schema.prisma и в apps/api/prisma/README.md, «Пункт 49». Смягчение
// риска, оставшееся от старого решения: suggestFromLocation() —
// AI-ДОГАДКА (🟡), не статичный справочник "страна → официальная
// религия" — не выдаёт единственный "правильный" ответ, не
// персистирует ничего сама, ничего не проставляет автоматически.
// Пользователь по-прежнему обязан явно выбрать/подтвердить, "не
// указывать" остаётся видимым лёгким вариантом на стороне TMA-формы.
//
// Связь с ConsentType.RELIGIOUS_CONTENT — тот же паттерн, что уже
// был у ScanTargetType.SAFE_SHARE_PREFLIGHT (заложен в чекпоинте,
// не использовался, пока не появилась фича 12): RELIGIOUS_CONTENT
// существовал в enum с самого начала, но ни один сервис никогда не
// создавал ConsentRecord с этим типом. §3.24: "функции включаются
// только после осознанного выбора пользователя" — выбор конкретной
// религии (не "не указывать") И ЕСТЬ этот осознанный акт, поэтому он
// автоматически создаёт согласие, не требует отдельного экрана
// "подтвердите ещё раз то, что вы только что явно выбрали".

import { Injectable } from '@nestjs/common';
import { countryNameToCode } from '../legal-disclaimer/jurisdiction-bucket';
import { PrismaService } from '../prisma/prisma.service';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { AIRouterService } from '../ai-router/ai-router.service';
import { ConsentService } from '../consent/consent.service';
import { ConsentType } from '@prisma/client';
import { reverseGeocode, NominatimError } from '../common/nominatim-client';
import { GEOCODING_SPEND, spendOutwardCall } from '../common/outward-spend';
import { LOCATION_PURPOSES } from '../consent/location-purposes';
import { allFilled, substanceSite } from '../common/claim-substance';

const RELIGIOUS_CONSENT_VERSION = 'v1';
const RELIGION_SUGGESTION_TASK_TYPE = 'onboarding-religion-suggestion';

// Пункт [body-classes] 2026-09-04: КЛАСС, а не интерфейс — интерфейс
// исчезает при компиляции, и ValidationPipe для него бессилен
// структурно. Разбор и происхождение потолков — common/request-body-classes.ts.
export class SaveOnboardingInput {
  // null здесь осмыслен: человек стирает ранее указанное, и это не то
  // же самое, что «поле не прислали».
  @IsOptional() @IsString() @MaxLength(100) religion?: string | null;
  @IsOptional() @IsString() @MaxLength(200) city?: string | null;
  @IsOptional() @IsString() @MaxLength(200) country?: string | null;
  @IsOptional() @IsString() @Matches(/^[A-Za-z]{2}$/) countryCode?: string | null;
}

interface RawReligionSuggestion {
  suggestedReligion: string;
  reasoning: string;
}

// Требование формата — В ПРОМПТЕ, а не только во флаге `jsonMode`.
// Пункт [json-mode-was-asked-and-dropped] 2026-09-26: этот вызов был
// ЕДИНСТВЕННЫМ из 87, где формат просил один флаг — а флаг читает
// только OpenAI-совместимый клиент. Достанься задача Anthropic или
// Google (а кому она достанется, решают ключ и порядок capability, не
// умение держать формат), модель вернула бы прозу,
// isValidReligionSuggestionPayload не прошёл бы, обе попытки упали, и
// catch ниже вернул бы `suggestedReligion: null` — молча и ровно так
// же, как если бы модели было нечего предложить. Пробел настройки
// выглядел как отсутствие подсказки.
export const RELIGION_SUGGESTION_SYSTEM_PROMPT =
  'Ты даёшь ОБЩУЮ, осторожную статистическую подсказку о наиболее распространённой религии в указанной стране — не утверждение о конкретном человеке. Явно избегай излишней уверенности, где религиозный состав страны неоднороден. ' +
  'Ответь СТРОГО валидным JSON вида {"suggestedReligion": string, "reasoning": string}, без пояснений вне JSON.';

// Экспортируется ради проверки на ПОВЕДЕНИИ: спека вызывает сам
// валидатор, а не ищет в его тексте слово `allFilled`
// (Пункт [finding-without-substance-2] 2026-09-26).
export function isValidReligionSuggestionPayload(text: string): boolean {
  try {
    // Пункт [finding-without-substance-2] 2026-09-26: способ сказать
    // «подсказки нет» в этом методе УЖЕ ЕСТЬ и он другой —
    // `suggestedReligion: null` из ветки catch. Пустая строка поэтому не
    // «нечего предложить», а подсказка ни о чём; а пустое обоснование
    // отбирает у человека единственное, на чём он может не согласиться с
    // подсказкой о своей религии.
    return allFilled(JSON.parse(text), substanceSite('isValidReligionSuggestionPayload').required.map((f) => f.field));
  } catch {
    return false;
  }
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
    private readonly consent: ConsentService,
  ) {}

  async get(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      // Пункт 64/68 — переиспользован уже существующий "профиль
      // пользователя" эндпоинт вместо отдельного нового GET, минимальная
      // правка (поля в select), не дублирование инфраструктуры.
      // religiousReminderFrequency читается ЗДЕСЬ (без побочных
      // эффектов), не через GET /religious-reminder — тот эндпоинт
      // имеет побочный эффект (отмечает показ, расходует "один раз в
      // день"), непригоден для простого чтения текущей настройки.
      select: {
        religion: true,
        city: true,
        country: true,
        alwaysShowQuote: true,
        alwaysShowAnecdote: true,
        religiousReminderFrequency: true,
      },
    });
    return user;
  }

  async save(userId: string, input: SaveOnboardingInput) {
    const data: { religion?: string | null; city?: string | null; country?: string | null; countryCode?: string | null } = {};
    if (input.religion !== undefined) data.religion = input.religion || null;
    if (input.city !== undefined) data.city = input.city || null;
    if (input.country !== undefined) {
      data.country = input.country || null;
      // код: явно переданный, иначе распознанный по названию (ручной ввод)
      data.countryCode = input.countryCode || countryNameToCode(input.country) || null;
    }

    const updated = await this.prisma.user.update({ where: { id: userId }, data });

    if (data.religion) {
      await this.ensureReligiousContentConsent(userId);
    } else if (data.religion === null && input.religion !== undefined) {
      await this.revokeReligiousContentConsent(userId);
    }

    return { religion: updated.religion, city: updated.city, country: updated.country, countryCode: updated.countryCode };
  }

  /** Пункт 49 — НЕ персистит ничего, только возвращает подсказку.
   * Reverse-geocode (Nominatim, детерминированный, не AI) даёт
   * country/city из координат. suggestedReligion — ОТДЕЛЬНЫЙ AI-вызов
   * (🟡 догадка, не факт) поверх уже полученного country — если
   * страна не определена (координаты вне покрытия), религия не
   * предполагается вообще, не выдумывается без основания. */
  async suggestFromLocation(userId: string, lat: number, lon: number, engineId?: string) {
    // Пункт 77 (§3.32 ТЗ) — единый геозапрос. ConsentService уже
    // построен с явным расчётом на этот пункт (см. комментарий в
    // consent.service.ts про revoke()) — здесь только добавлена сама
    // проверка, которой раньше не было в этом конкретном месте.
    await this.consent.requireConsent(userId, ConsentType.LOCATION, undefined, LOCATION_PURPOSES.ONBOARDING_CITY);

    // Пункт [the-policy-was-obeyed-by-hope] 2026-09-30: потолка не было
    // вовсе, и цена здесь не деньги, а БЛОКИРОВКА ПО IP всего
    // продукта. Шапка клиента сама называет правило OSM Foundation —
    // «максимум 1 запрос/сек» — и обосновывает его соблюдение словами
    // «разовый запрос при онбординге (не постоянный поток)». Разовым
    // его не делало ничто: маршрут можно было дёргать в цикле.
    //
    // Потолок суточный и на пользователя, и этого НЕДОСТАТОЧНО против
    // риска, который глобален: он ограничивает одного человека, а
    // забанят весь продукт. Названо прямо, а не изображено закрытым.
    await spendOutwardCall(this.prisma, userId, GEOCODING_SPEND, 'onboarding/suggest-from-location');

    let geo: { country: string | null; countryCode: string | null; city: string | null };
    try {
      geo = await reverseGeocode(lat, lon);
    } catch (err) {
      if (err instanceof NominatimError) {
        return { country: null, countryCode: null, city: null, suggestedReligion: null, reasoning: null };
      }
      throw err;
    }

    if (!geo.country) {
      return { country: geo.country, countryCode: geo.countryCode, city: geo.city, suggestedReligion: null, reasoning: null };
    }

    const userPrompt = `Страна: ${geo.country}. Какая религия/конфессия наиболее распространена в этой стране? Учитывай, что это лишь ОБЩАЯ статистическая тенденция по стране, не факт о конкретном человеке — в любой стране есть значительное религиозное разнообразие.`;
    const systemPrompt = RELIGION_SUGGESTION_SYSTEM_PROMPT;

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        taskType: RELIGION_SUGGESTION_TASK_TYPE,
        systemPrompt,
        userPrompt,
        jsonMode: true,
        maxTokens: 300,
        validateOutput: isValidReligionSuggestionPayload,
        preferredModelVersionId: engineId,
      });
    } catch {
      // Подсказка религии — необязательное улучшение UX, не
      // критический путь. Если AI недоступен, заблокирован
      // content-scan'ом, или ForbiddenException из-за отсутствия
      // согласия EXTERNAL_AI — country/city всё равно возвращаются
      // (детерминированный reverse-geocode уже отработал), просто без
      // suggestedReligion. Не роняем весь онбординг из-за
      // необязательной части.
      return { country: geo.country, countryCode: geo.countryCode, city: geo.city, suggestedReligion: null, reasoning: null };
    }

    const raw: RawReligionSuggestion = JSON.parse(result.text);
    return { country: geo.country, countryCode: geo.countryCode, city: geo.city, suggestedReligion: raw.suggestedReligion, reasoning: raw.reasoning };
  }

  private async ensureReligiousContentConsent(userId: string): Promise<void> {
    const existing = await this.prisma.consentRecord.findFirst({
      where: { userId, consentType: ConsentType.RELIGIOUS_CONTENT, granted: true, revokedAt: null },
    });
    if (existing) return;

    await this.prisma.consentRecord.create({
      data: {
        userId,
        consentType: ConsentType.RELIGIOUS_CONTENT,
        version: RELIGIOUS_CONSENT_VERSION,
        source: 'onboarding',
        granted: true,
        grantedAt: new Date(),
      },
    });
  }

  private async revokeReligiousContentConsent(userId: string): Promise<void> {
    await this.prisma.consentRecord.updateMany({
      where: { userId, consentType: ConsentType.RELIGIOUS_CONTENT, revokedAt: null },
      data: { revokedAt: new Date(), granted: false },
    });
  }
}

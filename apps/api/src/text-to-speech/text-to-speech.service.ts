// Пункт 63: TextToSpeechService (пункт 43 общего списка v4-роадмапа)
// — "Голосовая озвучка подсказок через ElevenLabs". По прямому
// запросу.
//
// ОБЩАЯ, ПЕРЕИСПОЛЬЗУЕМАЯ ИНФРАСТРУКТУРА — см. подробное обоснование
// над моделью TtsCache в schema.prisma: не привязана к одной фиче-
// потребителю (все три упомянутых в ТЗ места сами ещё не построены),
// подключена к уже существующему BestNextMoveRecommendation.bestAction
// как реальной, работающей точке входа.
//
// RAW FETCH, БЕЗ SDK — тот же принцип минимальных зависимостей, что
// весь остальной проект (SerpApi, Nominatim, Telegram Bot API и
// другие внешние интеграции построены так же).
//
// КЭШ ПО ХЭШУ ТЕКСТА, НЕ ПО ПОЛЬЗОВАТЕЛЮ — "не пере-генерировать
// одинаковые фразы" (буквально ТЗ). Одинаковая фраза для разных
// пользователей переиспользует один и тот же сгенерированный звук.

import { BadGatewayException, BadRequestException, Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { VOICE_ID_ALLOWED, safeProviderId } from '../common/provider-id-format';
import { PrismaService } from '../prisma/prisma.service';
import { ConsentService } from '../consent/consent.service';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentType } from '@prisma/client';
import { fetchWithTimeout } from '../common/fetch-with-timeout';
import { spendLimit } from '../common/spend-limits';
import { withSpendLock } from '../common/outward-spend';
import { isUniqueViolation } from '../common/unique-violation';

const ELEVENLABS_API_KEY_REF = 'ELEVENLABS_API_KEY';
// Пункт [rate-limits]: маркер расхода ElevenLabs в AuditLogEntry.
const TTS_USAGE_ACTION = 'tts.synthesized';

const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'; // ElevenLabs preset-голос "Bella", разумный дефолт без выбора пользователя
// Аудит интеграции ElevenLabs (продолжение аудита AssemblyAI, 2026-08-30) —
// сверено с рабочей реализацией в соседнем проекте (caller-id) и живой
// документацией ElevenLabs. Было eleven_multilingual_v2 — оптимизирован под
// качество/эмоциональность (аудиокниги, закадровый текст), а не латентность.
// Использование здесь — озвучка реплик AI-собеседника в живом диалоге
// (спарринг, чат по материалам): пользователь ждёт ответ прямо в разговоре.
// Документация прямо для этого случая: «For real-time applications, Flash
// v2.5 provides ultra-low 75ms latency». Украинский язык не теряется —
// Flash v2.5 поддерживает 32 языка, документация описывает набор как
// «все языки v2-моделей плюс ещё», украинский указан явно в обоих списках.
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
// Дефолт самого ElevenLabs при отсутствии параметра — тот же mp3_44100_128;
// задаём явно, не полагаясь на дефолт провайдера (тот же принцип, что
// applied к speech_models/speech_model в TranscriptionService/live-transcription).
const OUTPUT_FORMAT = 'mp3_44100_128';

export interface SynthesizeResult {
  audioBase64: string;
  cached: boolean;
}

@Injectable()
export class TextToSpeechService {
  private readonly logger = new Logger(TextToSpeechService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
    private readonly secrets: SecretsService,
  ) {}

  /** Проверка потолка И отметка расхода — одним событием под замком.
   *  См. шапку `withSpendLock`: без него двадцать одновременных попыток
   *  при потолке пять давали двадцать записей. */
  private async spendTtsCall(userId: string, textHash: string): Promise<void> {
    const limit = spendLimit('TTS_CALLS_PER_USER_PER_DAY');
    if (limit === 0) return;
    await withSpendLock(this.prisma, userId, TTS_USAGE_ACTION, async (tx) => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const count = await tx.auditLogEntry.count({
        where: { actorId: userId, action: TTS_USAGE_ACTION, createdAt: { gte: since } },
      });
      if (count >= limit) {
        throw new HttpException(
          `Достигнут суточный лимит озвучки (${limit}/сутки). Попробуйте позже.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await tx.auditLogEntry.create({
        data: { actorId: userId, action: TTS_USAGE_ACTION, resource: 'TtsCache', resourceId: textHash },
      });
    });
  }


  async synthesize(userId: string, text: string, voiceId?: string): Promise<SynthesizeResult> {
    if (!text.trim()) {
      throw new BadRequestException('text не может быть пустым');
    }
    // Раздел 2 ТЗ / VOICE_PROCESSING — существовал в enum'е с
    // чекпоинта, ни разу не использовался ни одним сервисом (см.
    // обоснование в schema.prisma).
    await this.consent.requireConsent(userId, ConsentType.VOICE_PROCESSING);

    const resolvedVoiceId = voiceId?.trim() || DEFAULT_VOICE_ID;
    const textHash = createHash('sha256').update(`${text.trim()}::${resolvedVoiceId}`).digest('hex');

    const cached = await this.prisma.ttsCache.findUnique({ where: { textHash } });
    if (cached) {
      return { audioBase64: cached.audioBase64, cached: true };
    }

    // Пункт [rate-limits] 2026-09-01 — суточный потолок синтеза на
    // пользователя. Проверяется ТОЛЬКО на cache-miss: попадание в кэш
    // ничего не стоит и не считается. Учёт — существующей моделью
    // AuditLogEntry (actorId + action + createdAt), новая таблица ради
    // счётчика не заводится (тот же принцип, что у Vision OCR — счёт
    // по уже существующим записям).
    // Пункт [the-ceiling-was-counted-then-crossed] 2026-10-05, и здесь
    // находка двойная. Первое: проверка и отметка были двумя событиями,
    // и одновременные запросы проходили по одному счёту. Второе, хуже:
    // отметка стояла ПОСЛЕ `callElevenLabs`, то есть считались
    // УСПЕХИ — единственный счётчик продукта, который так делал.
    // Деньги у провайдера списываются и за неудачную попытку, и
    // остальные пять счётчиков прямо пишут в своих шапках, что
    // считают попытки. Теперь и этот: проверка и отметка — одно
    // событие под замком, ДО платного вызова.
    await this.spendTtsCall(userId, textHash);

    const apiKey = await this.secrets.resolve(ELEVENLABS_API_KEY_REF);
    const audioBase64 = await this.callElevenLabs(text.trim(), resolvedVoiceId, apiKey);

    // Гонка: если два одновременных запроса с одинаковым текстом
    // проскочили проверку кэша раньше, чем оба успели создать запись,
    // второй create() упадёт на @@unique(textHash) — ловим и просто
    // возвращаем уже сгенерированный этим же вызовом результат, не
    // падаем с ошибкой пользователю за внутреннюю гонку.
    try {
      await this.prisma.ttsCache.create({
        data: { textHash, text: text.trim(), voiceId: resolvedVoiceId, audioBase64 },
      });
    } catch (err) {
      // Пункт [check-then-create-2] 2026-09-27: гонка тут и правда не
      // критична — но голый `catch {}` глотал ЛЮБОЙ отказ базы. Если
      // запись в кэш перестала работать вовсе (нет колонки после
      // db push, кончилось место, прав нет), продукт продолжал бы платить
      // за синтез КАЖДОГО повтора и не сказал бы об этом никому: сбой
      // выглядел бы как обычный промах кэша. Гонку по-прежнему пропускаем
      // молча, всё остальное — в лог, рядом с признаком «кэш не пишется».
      if (!isUniqueViolation(err)) {
        this.logger.warn(
          `Синтез удался, но запись в кэш TTS не прошла (${textHash.slice(0, 12)}…): ${(err as Error).message}. ` +
            'Каждый повтор этого текста будет оплачен заново — проверьте таблицу tts_cache.',
        );
      }
    }

    return { audioBase64, cached: false };
  }

  private async callElevenLabs(text: string, voiceId: string, apiKey: string): Promise<string> {
    let response: Response;
    try {
      // Пункт [the-identifier-reshaped-the-url] 2026-10-01: значение
      // уходит в ПУТЬ, то есть `../` меняло бы эндпоинт — с нашим ключом
      // в заголовке. Обоснование в шапке `common/provider-id-format.ts`.
      const safeVoiceId = safeProviderId(voiceId, VOICE_ID_ALLOWED, 'Идентификатор голоса');
      response = await fetchWithTimeout(`https://api.elevenlabs.io/v1/text-to-speech/${safeVoiceId}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: DEFAULT_MODEL_ID, output_format: OUTPUT_FORMAT }),
      }, 30_000); // [external-timeouts]: синтез аудио дольше дефолтных 15с
    } catch {
      throw new BadGatewayException('ElevenLabs недоступен — сетевая ошибка');
    }
    if (!response.ok) {
      // Аудит ElevenLabs 2026-08-30 — раньше тело ответа отбрасывалось,
      // хотя ElevenLabs обычно возвращает JSON с detail.message (например
      // voice_not_found, quota_exceeded) — та же дисциплина, что уже
      // применена к ошибкам AssemblyAI в TranscriptionService.
      const body = await response.text().catch(() => '<unreadable>');
      throw new BadGatewayException(`ElevenLabs вернул ошибку: ${response.status} — ${body.slice(0, 300)}`);
    }
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  }
}

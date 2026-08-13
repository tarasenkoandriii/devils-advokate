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

import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ConsentService } from '../consent/consent.service';
import { SecretsService } from '../secrets/secrets.service';
import { ConsentType } from '@prisma/client';

const ELEVENLABS_API_KEY_REF = 'ELEVENLABS_API_KEY';
const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'; // ElevenLabs preset-голос "Bella", разумный дефолт без выбора пользователя

export interface SynthesizeResult {
  audioBase64: string;
  cached: boolean;
}

@Injectable()
export class TextToSpeechService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
    private readonly secrets: SecretsService,
  ) {}

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
    } catch {
      // не критично — аудио всё равно сгенерировано и возвращается ниже
    }

    return { audioBase64, cached: false };
  }

  private async callElevenLabs(text: string, voiceId: string, apiKey: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
      });
    } catch {
      throw new BadGatewayException('ElevenLabs недоступен — сетевая ошибка');
    }
    if (!response.ok) {
      throw new BadGatewayException(`ElevenLabs вернул ошибку: ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  }
}

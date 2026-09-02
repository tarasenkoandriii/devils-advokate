// Пункт [stt-multi] 2026-09-02 — ElevenLabs Scribe как ОБЩИЙ ФОЛЛБЕК.
//
// Продуктовое решение владельца: «фоллбек для всех — ElevenLabs (он есть
// в проекте)». Выбор обоснован не только тем, что вендор уже наш (TTS):
// у Scribe v2 русский и украинский в верхней категории точности (≤5%
// WER по их замерам), диаризация до 32 говорящих, 90+ языков одной
// моделью — то есть фоллбек не «хоть что-нибудь», а полноценная замена
// на время отказа основного провайдера.
//
// ГРАНИЦА, названная прямо: этот клиент обслуживает ТОЛЬКО синхронную
// полосу.
//
//  • Вебхучная полоса (длинный файл) — нет: у ElevenLabs асинхронный
//    результат уходит на вебхук, настроенный в рабочем пространстве, с
//    подписью HMAC, а не с заголовком, который мы задаём в самом
//    запросе (так умеют AssemblyAI и Soniox). Наш guard такой вебхук не
//    примет, и результат потерялся бы МОЛЧА — худший вид отказа.
//    Поэтому на длинном файле фоллбек идёт во второго вебхучного
//    провайдера, а сюда — нет (см. sttFallbackChain).
//  • Живая полоса — нет: покрытие ru/uk у Scribe v2 Realtime вендором
//    не подтверждено (в анонсе названы шесть языков плюс общая цифра
//    «90»). Обещать пользователю живой режим на непроверенном языке
//    хуже, чем не обещать.
import { Injectable } from '@nestjs/common';
import { fetchWithTimeout } from '../common/fetch-with-timeout';
import type { ParsedTranscript } from '../conversations/transcription.service';
import { SttProvider, SttProviderError } from './stt-provider.interface';
import { normalizeSttLanguage, type SttLane } from './stt-language';

const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

/** Scribe v2 — текущая модель распознавания; v1 остаётся у вендора для
 *  совместимости. Задаём явно, как и у остальных провайдеров. */
export const ELEVENLABS_STT_MODEL = 'scribe_v2';

interface ElevenLabsSttResponse {
  text?: string;
  language_code?: string;
}

@Injectable()
export class ElevenLabsSttProvider implements SttProvider {
  readonly name = 'elevenlabs' as const;
  readonly lanes: readonly SttLane[] = ['sync'];

  uploadAudio(): Promise<string> {
    throw new SttProviderError('elevenlabs', 'загрузка файла для вебхучной полосы не поддерживается (см. шапку файла)');
  }

  submitWebhookJob(): Promise<{ externalJobId: string }> {
    throw new SttProviderError('elevenlabs', 'вебхучная полоса не поддерживается: подпись вебхука задаётся в рабочем пространстве, а не в запросе');
  }

  fetchResult(): Promise<ParsedTranscript> {
    throw new SttProviderError('elevenlabs', 'вебхучная полоса не поддерживается — результата по id здесь не бывает');
  }

  async transcribeSync(
    apiKey: string,
    audio: Buffer,
    languageCode?: string,
  ): Promise<{ text: string; language: string | null }> {
    const form = new FormData();
    form.append('model_id', ELEVENLABS_STT_MODEL);
    form.append('file', new Blob([new Uint8Array(audio)]), 'audio');
    // Язык — подсказка, не жёсткое условие: при её отсутствии модель
    // определяет язык сама, и это ровно то, что нужно фоллбеку (мы
    // попали сюда потому, что основной провайдер не ответил, а не
    // потому, что знаем про запись больше).
    const normalized = normalizeSttLanguage(languageCode);
    if (normalized) form.append('language_code', normalized);
    // Диаризация выключена: сюда попадает короткая реплика одного
    // говорящего, а лишняя обработка — это лишняя секунда ожидания.
    form.append('diarize', 'false');

    const response = await fetchWithTimeout(
      STT_URL,
      { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form },
      45_000,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      throw new SttProviderError('elevenlabs', `speech-to-text → ${response.status} ${response.statusText} — ${body}`);
    }

    const data = (await response.json()) as ElevenLabsSttResponse;
    return { text: (data.text ?? '').trim(), language: data.language_code ?? null };
  }
}

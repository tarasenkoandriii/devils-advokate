// Пункт [stt-multi] 2026-09-02 — AssemblyAI за общим интерфейсом.
//
// НИЧЕГО НЕ ПЕРЕПИСАНО: это тонкая обёртка над существующим
// TranscriptionService. Он несёт на себе годовой слой найденного живыми
// прогонами — форму вебхука (только transcript_id/status), порядок
// speech_models, потоковую загрузку без буферизации на диск, потолок
// опроса короткой заметки. Переписывать это ради единообразия значило
// бы выбросить всё, что стоило отладки.
//
// Английский остаётся здесь по решению владельца: «для английского —
// старый вариант». У AssemblyAI английский — родной язык моделей, и
// менять то, что работает, ради единого вендора незачем.
import { Injectable } from '@nestjs/common';
import { TranscriptionService, type ParsedTranscript } from '../conversations/transcription.service';
import { SttProvider, SttProviderError, SttRealtimeCredentials, SttWebhookSubmitParams } from './stt-provider.interface';
import type { SttLane } from './stt-language';
import { fetchWithTimeout } from '../common/fetch-with-timeout';

const ASSEMBLYAI_TEMP_TOKEN_URL = 'https://streaming.assemblyai.com/v3/token';
export const ASSEMBLYAI_REALTIME_WS_URL = 'wss://streaming.assemblyai.com/v3/ws';
/** Потоковая модель AssemblyAI. Русского и украинского в ней нет — их
 *  ведёт Soniox (см. stt-language.ts); здесь она обслуживает английский. */
export const ASSEMBLYAI_REALTIME_MODEL = 'universal-3-5-pro';

@Injectable()
export class AssemblyAiSttProvider implements SttProvider {
  readonly name = 'assemblyai' as const;
  readonly lanes: readonly SttLane[] = ['realtime', 'webhook', 'sync'];

  constructor(private readonly transcription: TranscriptionService) {}

  uploadAudio(apiKey: string, audio: ReadableStream<Uint8Array>): Promise<string> {
    return this.transcription.streamUpload(apiKey, audio);
  }

  async submitWebhookJob(apiKey: string, params: SttWebhookSubmitParams): Promise<{ externalJobId: string }> {
    // webhookSecret из параметров здесь не используется: секрет тот же,
    // но TranscriptionService резолвит его сам и падает без него
    // (fail closed) — эта проверка старше интерфейса и остаётся за ним.
    return this.transcription.submitJob(apiKey, {
      audioUrl: params.audioUrl,
      webhookUrl: params.webhookUrl,
      languageCode: params.languageCode,
      diarize: params.diarize,
    });
  }

  async fetchResult(apiKey: string, externalJobId: string): Promise<ParsedTranscript> {
    const result = await this.transcription.getTranscriptResult(apiKey, externalJobId);
    const parsed = this.transcription.parseTranscriptResult(result);
    // Аудит 2026-09-02 (продолжение): та же дисциплина, что у Soniox, —
    // результат у нас, у провайдера ему больше нечего делать. У AssemblyAI
    // DELETE снимает данные транскрипта (текст, слова), оставляя пустую
    // запись со статусом; до этого текст лежал у него бессрочно, хотя
    // согласие пользователя обещает «сохраняется расшифровка у нас, а не
    // файл у провайдера». Повторная доставка вебхука после удаления не
    // страшна: обработчики не переобрабатывают завершённое.
    await this.discard(apiKey, externalJobId);
    return parsed;
  }

  /** См. TranscriptionService.deleteTranscript — единственная точка с URL
   *  и заголовками AssemblyAI остаётся там. */
  discard(apiKey: string, externalJobId: string): Promise<void> {
    return this.transcription.deleteTranscript(apiKey, externalJobId);
  }

  transcribeSync(apiKey: string, audio: Buffer, languageCode?: string): Promise<{ text: string; language: string | null }> {
    return this.transcription.transcribeShortNoteSync(apiKey, audio, languageCode);
  }

  async mintRealtimeToken(
    apiKey: string,
    expiresInSeconds: number,
    languageHints: string[],
  ): Promise<SttRealtimeCredentials> {
    const response = await fetchWithTimeout(
      `${ASSEMBLYAI_TEMP_TOKEN_URL}?expires_in_seconds=${expiresInSeconds}`,
      { headers: { Authorization: apiKey } },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      throw new SttProviderError('assemblyai', `temp token → ${response.status} ${response.statusText} — ${body}`);
    }
    const data = (await response.json()) as { token: string };
    return {
      provider: 'assemblyai',
      token: data.token,
      expiresInSeconds,
      websocketUrl: ASSEMBLYAI_REALTIME_WS_URL,
      model: ASSEMBLYAI_REALTIME_MODEL,
      languageHints,
    };
  }
}

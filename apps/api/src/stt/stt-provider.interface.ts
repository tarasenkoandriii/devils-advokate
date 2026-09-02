// Пункт [stt-multi] 2026-09-02 — контракт STT-провайдера.
//
// Один интерфейс на трёх провайдеров, чтобы смена вендора была
// обратимой: тот же приём, что `AIProviderClient.lanes` у LLM-роутера.
// Полосы объявляет сам клиент — «клиент есть» не значит «эту задачу он
// возьмёт» (ElevenLabs не обслуживает наш вебхучный путь, см.
// stt-language.ts).
import type { ParsedTranscript } from '../conversations/transcription.service';
import type { SttLane, SttProviderName } from './stt-language';

export type { ParsedTranscript };

export interface SttWebhookSubmitParams {
  /** Публично доступная провайдеру ссылка на аудио (presigned blob или
   *  upload-url самого провайдера — см. uploadAudio). */
  audioUrl: string;
  webhookUrl: string;
  languageCode?: string;
  /** Диаризация: разговор — да, короткая реплика — нет. */
  diarize: boolean;
  /** Секрет, который провайдер вернёт нам в заголовке вебхука. Владеет
   *  им SttService (один на всех провайдеров), а не сам провайдер: так
   *  у провайдера нет изменяемого состояния, и «кто задал секрет
   *  последним» перестаёт быть вопросом. */
  webhookSecret: string;
}

export interface SttRealtimeCredentials {
  provider: SttProviderName;
  token: string;
  expiresInSeconds: number;
  /** Куда клиенту подключаться и с какой моделью — форма подключения у
   *  провайдеров разная, и знать её должен один слой, а не каждый
   *  экран. */
  websocketUrl: string;
  model: string;
  languageHints: string[];
}

export interface SttProvider {
  readonly name: SttProviderName;
  readonly lanes: readonly SttLane[];

  /** Загрузка байтов туда, откуда провайдер сможет их забрать.
   *  Возвращает ссылку, пригодную как audioUrl для submitWebhookJob.
   *  `contentType` — MIME из запроса клиента (аудит 2026-09-02): у
   *  multipart-загрузки Soniox файл без имени и типа, и провайдеру
   *  остаётся угадывать формат по байтам; с типом угадывать не нужно.
   *  Необязателен — без него поведение прежнее. */
  uploadAudio(apiKey: string, audio: ReadableStream<Uint8Array>, contentType?: string | null): Promise<string>;

  /** Длинный файл: ставим задачу, результат придёт вебхуком. */
  submitWebhookJob(apiKey: string, params: SttWebhookSubmitParams): Promise<{ externalJobId: string }>;

  /** Результат по id задачи — вебхуки провайдеров несут только id и
   *  статус, текст всегда добирается отдельным запросом. */
  fetchResult(apiKey: string, externalJobId: string): Promise<ParsedTranscript>;

  /** Короткая запись: ответ в том же вызове, без вебхука. */
  transcribeSync(
    apiKey: string,
    audio: Buffer,
    languageCode?: string,
  ): Promise<{ text: string; language: string | null }>;

  /** Короткоживущий ключ для прямого подключения браузера. */
  mintRealtimeToken?(apiKey: string, expiresInSeconds: number, languageHints: string[]): Promise<SttRealtimeCredentials>;

  /** Аудит 2026-09-02 (продолжение): убрать у провайдера задачу, чей
   *  результат нам уже НЕ НУЖЕН — вебхук пришёл на разговор/реплику,
   *  которых больше нет (удалены пользователем до завершения). Без этого
   *  запись лежала бы у субподрядчика весь его retention, хотя у нас от
   *  неё не осталось ничего. Best-effort, ошибок не бросает. */
  discard?(apiKey: string, externalJobId: string): Promise<void>;
}

/** Ошибка провайдера распознавания — общая для всех трёх, чтобы
 *  вызывающий код не различал вендоров. */
export class SttProviderError extends Error {
  constructor(
    readonly provider: SttProviderName,
    message: string,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'SttProviderError';
  }
}

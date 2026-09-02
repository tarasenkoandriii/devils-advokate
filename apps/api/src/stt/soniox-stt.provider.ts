// Пункт [stt-multi] 2026-09-02 — Soniox: русский, украинский и их смесь.
//
// Почему именно он (полный разбор — docs/devils-advocate-stt-provider-2026-09-02.md):
//  • ru и uk в РЕАЛЬНОМ ВРЕМЕНИ, чего у AssemblyAI нет ни в одной
//    потоковой модели;
//  • одна мультиязычная модель с переключением языка внутри фразы —
//    суржик и ru↔uk смесь для нашей аудитории норма;
//  • временные ключи спроектированы ровно под нашу схему «бэкенд
//    минтит, браузер подключается сам»;
//  • диаризация и определение языка входят в цену.
//
// Формы API (сверено с docs.soniox.com на 2026-09-02):
//   POST /v1/files                       — загрузка байтов, отдаёт file_id
//   POST /v1/transcriptions              — задача (audio_url | file_id)
//   GET  /v1/transcriptions/{id}         — статус
//   GET  /v1/transcriptions/{id}/transcript — текст и токены
//   POST /v1/auth/temporary-api-key      — короткоживущий ключ для браузера
//   DELETE /v1/transcriptions/{id}, DELETE /v1/files/{id} — уборка
// Вебхук несёт только { id, status } — текст добирается отдельно, ровно
// как у AssemblyAI.
//
// УБОРКА (аудит 2026-09-02, STT). Soniox хранит и файл, и транскрипт до
// 30 дней (retention по умолчанию), и удаление транскрипта НЕ удаляет
// файл. Для продукта, чьё согласие пользователя обещает «транзит, а не
// хранение», это означало бы, что запись лежит у субподрядчика месяц
// после того, как у нас она уже удалена. Поэтому после чтения результата
// (и после ошибки — тоже) провайдеру отправляются оба DELETE. Уборка
// best-effort: её отказ логируется, но результат пользователя не
// теряется — потерять можно уборку, но не расшифровку.
import { Injectable, Logger } from '@nestjs/common';
import { fetchWithTimeout } from '../common/fetch-with-timeout';
import { STT_WEBHOOK_HEADER } from '../common/webhook/stt-webhook.guard';
import type { ParsedTranscript } from '../conversations/transcription.service';
import {
  SttProvider,
  SttProviderError,
  SttRealtimeCredentials,
  SttWebhookSubmitParams,
} from './stt-provider.interface';
import { sttLanguageHints, type SttLane } from './stt-language';

const BASE_URL = 'https://api.soniox.com/v1';

/** Модели v5 (v4 — алиасы на них же, удаляются 30.06.2026). Заданы
 *  явно, а не «по умолчанию у провайдера»: та же дисциплина, что с
 *  speech_models у AssemblyAI — молчаливая смена модели провайдером не
 *  должна менять поведение продукта. */
export const SONIOX_ASYNC_MODEL = 'stt-async-v5';
export const SONIOX_REALTIME_MODEL = 'stt-rt-v5';
export const SONIOX_REALTIME_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';

interface SonioxToken {
  text: string;
  /** Служебный флаг звукового события (смех, музыка) — не речь. */
  is_audio_event?: boolean;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
  speaker?: string | number;
  language?: string;
}

interface SonioxTranscript {
  id: string;
  text?: string;
  tokens?: SonioxToken[];
}

interface SonioxTranscription {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  error_message?: string;
  /** Есть, когда задача поставлена по file_id (наш путь коротких записей). */
  file_id?: string | null;
}

/**
 * Токены → сегменты. Soniox отдаёт ПОТОКЕННУЮ разметку, а наша модель
 * данных (TranscriptSegment) — реплики: склеиваем подряд идущие токены
 * одного говорящего.
 *
 * Отдельно вынесено и экспортировано, потому что это единственное место
 * с реальной логикой преобразования — и единственное, что имеет смысл
 * тестировать без сети.
 */
/** Пауза, после которой начинается новая реплика. РЕВЬЮ 2026-09-02:
 *  без этого монолог (или запись, где диаризация не разделила
 *  говорящих) давал ОДИН сегмент на всю запись — и всё, что висит на
 *  сегментах (паралингвистика, поворотные точки, назначение
 *  участников), деградировало до одной строки. */
const SEGMENT_PAUSE_MS = 800;

export function sonioxTokensToSegments(tokens: SonioxToken[]): ParsedTranscript['segments'] {
  const segments: ParsedTranscript['segments'] = [];

  for (const token of tokens) {
    const text = token.text ?? '';
    if (!text.trim() && segments.length === 0) continue; // ведущие пробелы в начале — не сегмент
    // Служебные токены Soniox в текст реплики не попадают.
    if (text === '<end>' || token.is_audio_event === true) continue;

    // Диаризация может быть выключена (короткая заметка) — тогда всё
    // одному говорящему, лейбл тот же, что у AssemblyAI по умолчанию.
    const speaker = token.speaker != null ? String(token.speaker) : 'A';
    const last = segments[segments.length - 1];

    const gapMs = last && typeof token.start_ms === 'number' ? token.start_ms - last.endMs : 0;
    if (last && last.diarizationLabel === speaker && gapMs < SEGMENT_PAUSE_MS) {
      last.text += text;
      if (typeof token.end_ms === 'number') last.endMs = token.end_ms;
      // Уверенность реплики — минимальная из токенов: реплика не
      // надёжнее своего худшего слова.
      if (typeof token.confidence === 'number') {
        last.confidence = last.confidence == null ? token.confidence : Math.min(last.confidence, token.confidence);
      }
      continue;
    }

    segments.push({
      diarizationLabel: speaker,
      text,
      startMs: token.start_ms ?? 0,
      endMs: token.end_ms ?? token.start_ms ?? 0,
      confidence: typeof token.confidence === 'number' ? token.confidence : null,
    });
  }

  // Токены приходят с ведущими пробелами — тримим уже собранные реплики
  // и выбрасываем пустые (бывают на границах тишины).
  return segments
    .map((s) => ({ ...s, text: s.text.trim() }))
    .filter((s) => s.text.length > 0);
}

/** Язык результата: у Soniox он на токенах, а не на транскрипте
 *  целиком (это же и есть переключение языка внутри фразы). Наружу
 *  отдаём преобладающий — модель данных хранит один код на разговор. */
export function dominantSonioxLanguage(tokens: SonioxToken[]): string | null {
  const weight = new Map<string, number>();
  for (const token of tokens) {
    if (!token.language) continue;
    const chars = (token.text ?? '').trim().length || 1;
    weight.set(token.language, (weight.get(token.language) ?? 0) + chars);
  }
  let best: string | null = null;
  let bestWeight = 0;
  for (const [language, value] of weight) {
    if (value > bestWeight) {
      best = language;
      bestWeight = value;
    }
  }
  return best;
}

/** MIME из запроса → чистый тип без параметров (`audio/webm;codecs=opus`
 *  → `audio/webm`); не аудио/видео — null. */
export function normalizeAudioMime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const base = raw.split(';')[0].trim().toLowerCase();
  return /^(audio|video)\/[a-z0-9.+-]+$/.test(base) ? base : null;
}

const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/webm': '.webm',
  'video/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/flac': '.flac',
  'video/mp4': '.mp4',
};

export function audioExtensionFor(mime: string | null): string {
  return (mime && AUDIO_EXTENSIONS[mime]) ?? '';
}

@Injectable()
export class SonioxSttProvider implements SttProvider {
  readonly name = 'soniox' as const;
  readonly lanes: readonly SttLane[] = ['realtime', 'webhook', 'sync'];
  private readonly logger = new Logger(SonioxSttProvider.name);

  private async request<T>(
    apiKey: string,
    path: string,
    init: RequestInit = {},
    timeoutMs?: number,
  ): Promise<T> {
    const response = await fetchWithTimeout(
      `${BASE_URL}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
          ...(init.headers as Record<string, string> | undefined),
        },
      },
      timeoutMs,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      throw new SttProviderError('soniox', `${init.method ?? 'GET'} ${path} → ${response.status} ${response.statusText} — ${body}`);
    }

    return (await response.json()) as T;
  }

  /** Уборка у провайдера (см. шапку файла): транскрипт и, если задача
   *  шла по загруженному файлу, сам файл. Ошибки не пробрасываются. */
  async cleanup(apiKey: string, transcriptionId: string, fileId?: string | null): Promise<void> {
    const targets = [`/transcriptions/${transcriptionId}`, ...(fileId ? [`/files/${fileId}`] : [])];
    for (const path of targets) {
      try {
        const response = await fetchWithTimeout(
          `${BASE_URL}${path}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` } },
          10_000,
        );
        // 404 — уже удалено (повторная доставка вебхука); это не отказ.
        if (!response.ok && response.status !== 404) {
          this.logger.warn(`Soniox: не удалось удалить ${path} → ${response.status}`);
        }
      } catch (err) {
        this.logger.warn(`Soniox: не удалось удалить ${path}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Загрузка байтов в Soniox: multipart, отдаёт file_id. Ссылку на
   *  файл наружу мы не выдаём — возвращаем внутренний маркер
   *  `soniox-file:<id>`, который submitWebhookJob разбирает обратно.
   *  Так вызывающий код (три модуля с голосовым вводом) остаётся
   *  провайдеро-независимым: у него в руках «строка-ссылка». */
  async uploadAudio(apiKey: string, audio: ReadableStream<Uint8Array>, contentType?: string | null): Promise<string> {
    // FormData требует Blob/File — стрим собираем в память. Это путь
    // КОРОТКИХ записей (реплика в спарринге, заметка): длинный разговор
    // грузится напрямую в приватный blob и приходит сюда ссылкой.
    const chunks: Uint8Array[] = [];
    const reader = audio.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const type = normalizeAudioMime(contentType);
    const blob = new Blob(chunks, type ? { type } : undefined);

    const form = new FormData();
    // Имя с расширением по MIME (аудит 2026-09-02): без него multipart
    // уходил как безымянный «audio» без типа — формат провайдер
    // определял по байтам. Расширение — подсказка, не условие.
    form.append('file', blob, `audio${audioExtensionFor(type)}`);

    const data = await this.request<{ id: string }>(apiKey, '/files', { method: 'POST', body: form }, 45_000);
    return `soniox-file:${data.id}`;
  }

  async submitWebhookJob(apiKey: string, params: SttWebhookSubmitParams): Promise<{ externalJobId: string }> {
    const fileId = params.audioUrl.startsWith('soniox-file:') ? params.audioUrl.slice('soniox-file:'.length) : null;

    const data = await this.request<SonioxTranscription>(apiKey, '/transcriptions', {
      method: 'POST',
      body: JSON.stringify({
        model: SONIOX_ASYNC_MODEL,
        ...(fileId ? { file_id: fileId } : { audio_url: params.audioUrl }),
        language_hints: sttLanguageHints(params.languageCode),
        enable_speaker_diarization: params.diarize,
        // Язык нужен нам и как факт (в Transcript.language), и как
        // условие переключения внутри фразы.
        enable_language_identification: true,
        webhook_url: params.webhookUrl,
        // Тот же заголовок, что и у AssemblyAI-задач, и та же проверка
        // в guard: провайдеров два, секрет один, точка проверки одна.
        webhook_auth_header_name: STT_WEBHOOK_HEADER,
        webhook_auth_header_value: params.webhookSecret,
      }),
    });

    return { externalJobId: data.id };
  }

  /** Уборка без чтения результата — для задач, чей владелец у нас
   *  удалён (см. интерфейс). file_id узнаём из статуса; если статус не
   *  прочитался, удаляем хотя бы саму задачу. */
  async discard(apiKey: string, externalJobId: string): Promise<void> {
    let fileId: string | null | undefined;
    try {
      const status = await this.request<SonioxTranscription>(apiKey, `/transcriptions/${externalJobId}`);
      fileId = status.file_id;
    } catch {
      fileId = null;
    }
    await this.cleanup(apiKey, externalJobId, fileId);
  }

  async fetchResult(apiKey: string, externalJobId: string): Promise<ParsedTranscript> {
    const status = await this.request<SonioxTranscription>(apiKey, `/transcriptions/${externalJobId}`);
    if (status.status === 'error') {
      // Задача провалена — держать у провайдера нечего.
      await this.cleanup(apiKey, externalJobId, status.file_id);
      throw new SttProviderError('soniox', `задача ${externalJobId} завершилась ошибкой: ${status.error_message ?? 'без описания'}`);
    }
    if (status.status !== 'completed') {
      // Не готова — НЕ убираем: вебхук придёт ещё раз.
      throw new SttProviderError('soniox', `задача ${externalJobId} ещё не готова (${status.status})`);
    }

    const transcript = await this.request<SonioxTranscript>(apiKey, `/transcriptions/${externalJobId}/transcript`);
    const tokens = transcript.tokens ?? [];
    const parsed: ParsedTranscript = {
      language: dominantSonioxLanguage(tokens),
      segments: sonioxTokensToSegments(tokens),
    };

    // Результат уже у нас в руках — только теперь убираем у провайдера.
    await this.cleanup(apiKey, externalJobId, status.file_id);
    return parsed;
  }

  async transcribeSync(
    apiKey: string,
    audio: Buffer,
    languageCode?: string,
  ): Promise<{ text: string; language: string | null }> {
    const fileRef = await this.uploadAudio(apiKey, new Blob([new Uint8Array(audio)]).stream());
    const fileId = fileRef.slice('soniox-file:'.length);

    const created = await this.request<SonioxTranscription>(apiKey, '/transcriptions', {
      method: 'POST',
      body: JSON.stringify({
        model: SONIOX_ASYNC_MODEL,
        file_id: fileId,
        language_hints: sttLanguageHints(languageCode),
        enable_language_identification: true,
        // Диаризация короткой заметке не нужна (один говорящий) —
        // и без неё быстрее.
        enable_speaker_diarization: false,
      }),
    });

    // Опрос, как в transcribeShortNoteSync у AssemblyAI: потолок
    // заведомо меньше maxDuration функции, чтобы успеть отдать честную
    // ошибку вместо обрыва.
    // РЕВЬЮ 2026-09-02: потолок опроса согласован с ЦЕПОЧКОЙ, а не с
    // одним провайдером. maxDuration функции — 60 с; при отказе Soniox
    // вызывающий идёт в ElevenLabs, которому нужно ещё до 45 с. 18 × 1200
    // мс ≈ 22 с оставляют место обеим попыткам вместо платформенного 504.
    const pollDelayMs = process.env.NODE_ENV === 'test' ? 0 : 1200;
    try {
      for (let attempt = 0; attempt < 18; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
        const status = await this.request<SonioxTranscription>(apiKey, `/transcriptions/${created.id}`);
        if (status.status === 'completed') {
          const transcript = await this.request<SonioxTranscript>(apiKey, `/transcriptions/${created.id}/transcript`);
          const tokens = transcript.tokens ?? [];
          const text = transcript.text ?? tokens.map((t) => t.text ?? '').join('');
          return { text: text.trim(), language: dominantSonioxLanguage(tokens) };
        }
        if (status.status === 'error') {
          throw new SttProviderError('soniox', `распознавание заметки не удалось: ${status.error_message ?? 'без описания'}`);
        }
      }
      throw new SttProviderError('soniox', 'распознавание заметки не уложилось в отведённое время — попробуйте короче');
    } finally {
      // Синхронный путь: результат либо возвращён, либо потерян — в
      // обоих случаях файл и задача у провайдера больше не нужны.
      // (Незавершённую задачу Soniox удалить не даст — тогда сработает
      // его собственный retention; это названо в docs/…stt-provider.)
      await this.cleanup(apiKey, created.id, fileId);
    }
  }

  /**
   * Короткоживущий ключ для прямого подключения браузера.
   *
   * `single_use` и `max_session_duration_seconds` — не украшение:
   * прежний токен AssemblyAI жил 5 минут и позволял открывать сколько
   * угодно потоков. Здесь ключ открывает ровно одно соединение и режет
   * сессию по потолку, то есть утечка стоит одной сессии, а не всего
   * баланса.
   */
  async mintRealtimeToken(
    apiKey: string,
    expiresInSeconds: number,
    languageHints: string[],
  ): Promise<SttRealtimeCredentials> {
    const data = await this.request<{ api_key: string; expires_at?: string }>(apiKey, '/auth/temporary-api-key', {
      method: 'POST',
      body: JSON.stringify({
        usage_type: 'transcribe_websocket',
        expires_in_seconds: expiresInSeconds,
        single_use: true,
        max_session_duration_seconds: 3 * 60 * 60,
      }),
    });

    this.logger.debug(`Выдан временный ключ Soniox на ${expiresInSeconds} с`);
    return {
      provider: 'soniox',
      token: data.api_key,
      expiresInSeconds,
      websocketUrl: SONIOX_REALTIME_WS_URL,
      model: SONIOX_REALTIME_MODEL,
      languageHints,
    };
  }
}

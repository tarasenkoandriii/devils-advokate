
import { Injectable, Logger } from '@nestjs/common';
import { SecretsService } from '../secrets/secrets.service';
import { STT_WEBHOOK_HEADER, STT_WEBHOOK_SECRET_REF, resolveSttWebhookSecret } from '../common/webhook/stt-webhook.guard';
import { fetchWithTimeout } from '../common/fetch-with-timeout';

export interface AssemblyAiSubmitParams {
  audioUrl: string;
  webhookUrl: string;
  languageCode?: string;
  /** Пункт [stt-multi] 2026-09-02: разговор — да, короткая реплика —
   *  нет. Раньше диаризация была включена всегда, и голосовая реплика
   *  одного говорящего оплачивалась как разговор. */
  diarize?: boolean;
}

export interface AssemblyAiSubmitResult {
  externalJobId: string;
}

/** Финальный аудит 2026-08-30 — реальное тело вебхука AssemblyAI (сверено с
 * docs.assemblyai.com/pre-recorded-audio/webhooks): ТОЛЬКО `transcript_id` и
 * `status`. Ни текста, ни utterances, ни ошибки — их нужно получать отдельным
 * `GET /v2/transcript/{transcript_id}` (см. getTranscriptResult() ниже).
 * Прежняя версия этого интерфейса называла поле `id` (которого в реальном
 * payload не существует) и ожидала utterances/language_code прямо в вебхуке —
 * из-за этого `payload.id` был всегда `undefined`: в conversations.service.ts
 * это уходило в Prisma `findFirst({ where: { externalTranscriptionJobId:
 * undefined } })`, что Prisma трактует как «условие не задано» и возвращает
 * ПЕРВУЮ ПОПАВШУЮСЯ запись в таблице — риск привязать транскрипт к чужому
 * разговору. А `payload.utterances` был обречён быть пустым всегда — ни один
 * разговор не получил бы ни одного сегмента транскрипта. */
export interface AssemblyAiWebhookPayload {
  transcript_id: string;
  status: 'completed' | 'error';
}

export interface AssemblyAiTranscriptResult {
  // Реальный API отдаёт также 'queued'/'processing' до готовности —
  // тип расширен Пунктом [voice-note-ru] (опрос короткой заметки).
  status: 'completed' | 'error' | 'queued' | 'processing';
  id: string;
  error?: string;
  text?: string; // полный текст без диаризации — то, что нужно короткой голосовой заметке
  language_code?: string;
  utterances?: Array<{
    speaker: string; // "A" | "B" | ... — буквенный лейбл диаризации AssemblyAI
    text: string;
    start: number; // мс от начала записи
    end: number;
    confidence?: number;
  }>;
}

export interface ParsedTranscriptSegment {
  diarizationLabel: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
}

export interface ParsedTranscript {
  language: string | null;
  segments: ParsedTranscriptSegment[];
}

export class TranscriptionProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionProviderError';
  }
}

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  private readonly baseUrl = 'https://api.assemblyai.com/v2';

  constructor(private readonly secrets: SecretsService) {}

  /** Fail closed: без секрета задачу не отправляем — иначе вебхук с
   * результатом никогда не пройдёт guard и разговор зависнет в TRANSCRIBING. */
  private async webhookSecret(): Promise<string> {
    // Пункт [stt-multi] 2026-09-02: секрет один на всех STT-провайдеров
    // (новое имя STT_WEBHOOK_SECRET, историческое ASSEMBLYAI_WEBHOOK_SECRET
    // работает как раньше — переименовывать переменную в деплое не нужно).
    const secret = await resolveSttWebhookSecret(this.secrets);
    if (!secret) {
      throw new TranscriptionProviderError(`${STT_WEBHOOK_SECRET_REF} не настроен — транскрипция через вебхук невозможна`);
    }
    return secret;
  }

  /** Отправить задачу на транскрибацию+диаризацию. audioUrl должен
   * быть публично доступен AssemblyAI на момент вызова — сервер этого
   * файла не хранит и не проксирует байты в этом методе (см.
   * ConversationsController про потоковую загрузку без буферизации на
   * диск). webhookUrl — куда AssemblyAI пришлёт результат по готовности,
   * не polling: соответствует serverless-архитектуре (нет фонового
   * процесса, который мог бы поллить). */
  async submitJob(apiKey: string, params: AssemblyAiSubmitParams): Promise<AssemblyAiSubmitResult> {
    const response = await fetchWithTimeout(`${this.baseUrl}/transcript`, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: params.audioUrl,
        // Финальный аудит 2026-08-30 — speech_models не был задан явно.
        // Параметр опциональный: при отсутствии AssemblyAI молча откатывается
        // на ["universal-3-pro", "universal-2"], не на текущий флагман.
        // Упорядоченный список фолбэков по доступности модели (не языка —
        // за это отвечает сама universal-3-5-pro, см. language_code ниже).
        speech_models: ['universal-3-5-pro', 'universal-2'],
        speaker_labels: params.diarize ?? true,
        webhook_url: params.webhookUrl,
        webhook_auth_header_name: STT_WEBHOOK_HEADER,
        webhook_auth_header_value: await this.webhookSecret(),
        language_code: params.languageCode,
        redact_pii: false, // не включено по умолчанию — решение о PII-редактировании транскрипта: отдельная фича, не должна тихо резать текст без явного выбора пользователя
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      throw new TranscriptionProviderError(
        `AssemblyAI submit failed: ${response.status} ${response.statusText} — ${body}`,
      );
    }

    const data = (await response.json()) as { id: string };
    return { externalJobId: data.id };
  }

  /** Финальный аудит 2026-08-30 — реальный результат по вебхуку получается
   * НЕ из тела POST-запроса (там только transcript_id/status), а отдельным
   * запросом сюда. Вызывающий код (webhook-хендлеры трёх модулей) обязан
   * дёрнуть это ПОСЛЕ получения вебхука — и для status="completed", и для
   * "error" (текст ошибки тоже не в вебхуке, а в этом ответе, поле error). */
  async getTranscriptResult(apiKey: string, transcriptId: string): Promise<AssemblyAiTranscriptResult> {
    const response = await fetchWithTimeout(`${this.baseUrl}/transcript/${transcriptId}`, {
      headers: { Authorization: apiKey },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      throw new TranscriptionProviderError(
        `AssemblyAI get-transcript failed: ${response.status} ${response.statusText} — ${body}`,
      );
    }

    return (await response.json()) as AssemblyAiTranscriptResult;
  }

  /** Парсинг РЕЗУЛЬТАТА (не входящего webhook-пейлоада — см. коммент к
   * AssemblyAiWebhookPayload выше) в структуру, готовую для записи в
   * Transcript/TranscriptSegment. Вызывающий код уже получил result через
   * getTranscriptResult(). */
  parseTranscriptResult(result: AssemblyAiTranscriptResult): ParsedTranscript {
    if (result.status === 'error') {
      throw new TranscriptionProviderError(`AssemblyAI job ${result.id} failed: ${result.error ?? 'unknown error'}`);
    }

    const utterances = result.utterances ?? [];
    return {
      language: result.language_code ?? null,
      segments: utterances.map((u) => ({
        diarizationLabel: u.speaker,
        text: u.text,
        startMs: u.start,
        endMs: u.end,
        confidence: u.confidence ?? null,
      })),
    };
  }

  /** Потоковая передача аудио-файла в /v2/upload AssemblyAI без
   * буферизации на диск/в БД — тело запроса передаётся напрямую как
   * ReadableStream. Возвращает временный upload_url, пригодный как
   * audioUrl для submitJob(). Сервер в моменте передачи байтов их не
   * персистит — раздел 2 ТЗ ("сырые файлы не сохраняются на сервере")
   * соблюдён буквально: байты проходят через процесс транзитом, не
   * записываются ни в файловую систему, ни в БД.
   *
   * ИЗВЕСТНЫЙ АРХИТЕКТУРНЫЙ РИСК (тот же класс, что уже
   * задокументирован в VERCEL.md для фич 1/7/10): serverless-функции
   * Vercel Hobby имеют лимит на размер тела запроса — длинная запись
   * разговора (десятки минут аудио) может этот лимит превысить.
   * Митигация та же, что уже предложена для других AI-вызовов: Fluid
   * Compute, либо (для этого конкретного случая специфично) — переход
   * на прямую клиент→AssemblyAI загрузку через короткоживущий
   * proxy-токен вместо проксирования байтов через наш бэкенд вообще.
   * Не решено в рамках этого прохода, честно зафиксировано. */
  async streamUpload(apiKey: string, fileStream: ReadableStream<Uint8Array>): Promise<string> {
    const response = await fetchWithTimeout(`${this.baseUrl}/upload`, {
      method: 'POST',
      headers: { Authorization: apiKey },
      duplex: 'half',
      body: fileStream,
    } as RequestInit, 45_000); // [external-timeouts]: стрим аудио-буфера

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      throw new TranscriptionProviderError(
        `AssemblyAI upload failed: ${response.status} ${response.statusText} — ${body}`,
      );
    }

    const data = (await response.json()) as { upload_url: string };
    return data.upload_url;
  }

  /** Пункт [voice-note-ru] 2026-09-01 — синхронная транскрипция
   * КОРОТКОЙ голосовой заметки (голосовой ввод квиза). Причина
   * существования: AssemblyAI Streaming v3 поддерживает 18 языков БЕЗ
   * русского и украинского — живой прогон голосового ввода на русском
   * дал галлюцинацию английским/ивритом. Async-путь (/v2/transcript,
   * universal) русский и украинский поддерживает — поэтому короткая
   * заметка идёт им: upload → submit БЕЗ вебхука → опрос до ~40 с.
   * Только для коротких записей (десятки секунд): длинная запись не
   * уложится в maxDuration — для неё существует вебхучный путь.
   * Аудио НЕ персистуется нигде у нас — буфер уходит напрямую в
   * AssemblyAI и живёт только в этом вызове. */
  async transcribeShortNoteSync(
    apiKey: string,
    audio: Buffer,
    languageCode?: string,
  ): Promise<{ text: string; language: string | null }> {
    const uploadUrl = await this.streamUpload(apiKey, new Blob([new Uint8Array(audio)]).stream());

    const response = await fetchWithTimeout(`${this.baseUrl}/transcript`, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_url: uploadUrl,
        speech_models: ['universal-3-5-pro', 'universal-2'],
        // Явный язык, если пользователь выбрал; иначе автоопределение.
        ...(languageCode ? { language_code: languageCode } : { language_detection: true }),
        // Диаризация заметке не нужна (один говорящий) — быстрее.
        speaker_labels: false,
        redact_pii: false,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      throw new TranscriptionProviderError(
        `AssemblyAI submit (voice note) failed: ${response.status} ${response.statusText} — ${body}`,
      );
    }
    const { id } = (await response.json()) as { id: string };

    // Опрос: короткая заметка обычно готова за 2-8 с; потолок ~40 с —
    // заведомо меньше maxDuration 60, чтобы успеть отдать честную
    // ошибку. Интервал нулевой в тестах (jest выставляет NODE_ENV).
    const pollDelayMs = process.env.NODE_ENV === 'test' ? 0 : 1500;
    for (let attempt = 0; attempt < 27; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
      const result = await this.getTranscriptResult(apiKey, id);
      if (result.status === 'completed') {
        return { text: result.text ?? '', language: result.language_code ?? null };
      }
      if (result.status === 'error') {
        throw new TranscriptionProviderError(`AssemblyAI voice note ${id} failed: ${result.error ?? 'unknown error'}`);
      }
    }
    throw new TranscriptionProviderError('Распознавание заметки не уложилось в отведённое время — попробуйте короче');
  }
}

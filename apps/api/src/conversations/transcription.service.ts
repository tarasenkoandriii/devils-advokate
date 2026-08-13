// Пункт 13: TranscriptionService — интеграция с AssemblyAI.
//
// Почему AssemblyAI, а не Whisper/Deepgram/Google/Azure — коротко
// (подробное обоснование в apps/api/prisma/README.md, "Пункт 13"):
// 1) STT + диаризация спикеров в ОДНОМ API-вызове (`speaker_labels:
//    true`) — Whisper даёт только транскрипт, диаризация требовала бы
//    отдельной интеграции (например pyannote.audio), которая к тому же
//    не запускается на serverless (тяжёлая ML-модель, не просто HTTP-
//    вызов) — противоречит архитектуре Vercel Hobby, на которой уже
//    развёрнут весь остальной бэкенд.
// 2) Асинхронный job-based флоу с webhook — ложится на уже
//    спроектированный ConversationProcessingStatus (UPLOADED→
//    TRANSCRIBING→TRANSCRIBED) без подгонки под синхронный вызов.
// 3) Простой REST API, без обязательного SDK — тот же принцип "просто
//    fetch", что уже применён в ai-provider-client.ts.
//
// Без официального SDK намеренно — та же причина, что и для LLM-
// клиентов (сеть отключена в среде разработки, нельзя поставить
// зависимость). Реальный интеграционный прогон против настоящего
// API-ключа НЕ выполнялся на этом проходе — как и для AIRouterService
// при его первой реализации.

import { Injectable, Logger } from '@nestjs/common';

export interface AssemblyAiSubmitParams {
  audioUrl: string;
  webhookUrl: string;
  languageCode?: string;
}

export interface AssemblyAiSubmitResult {
  externalJobId: string;
}

// Форма входящего webhook-пейлоада AssemblyAI (упрощено до полей,
// которые реально используются — полный ответ содержит больше служебных
// полей, не все нужны этому сервису).
export interface AssemblyAiWebhookPayload {
  status: 'completed' | 'error';
  id: string;
  error?: string;
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

  /** Отправить задачу на транскрибацию+диаризацию. audioUrl должен
   * быть публично доступен AssemblyAI на момент вызова — сервер этого
   * файла не хранит и не проксирует байты в этом методе (см.
   * ConversationsController про потоковую загрузку без буферизации на
   * диск). webhookUrl — куда AssemblyAI пришлёт результат по готовности,
   * не polling: соответствует serverless-архитектуре (нет фонового
   * процесса, который мог бы поллить). */
  async submitJob(apiKey: string, params: AssemblyAiSubmitParams): Promise<AssemblyAiSubmitResult> {
    const response = await fetch(`${this.baseUrl}/transcript`, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: params.audioUrl,
        speaker_labels: true,
        webhook_url: params.webhookUrl,
        language_code: params.languageCode,
        // PII redaction на стороне провайдера — дополнительный слой
        // поверх собственного ContentScanService проекта (пункт 10),
        // не замена ему: ContentScanService всё равно проверяет то,
        // что реально попадает в AIJob дальше по пайплайну извлечения
        // аргументов/фактов из транскрипта.
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

  /** Парсинг входящего webhook-пейлоада в структуру, готовую для
   * записи в Transcript/TranscriptSegment. Не делает сам запрос к
   * AssemblyAI — вызывающий код (ConversationsController) уже получил
   * payload телом POST-запроса на вебхук-эндпоинт. */
  parseWebhookPayload(payload: AssemblyAiWebhookPayload): ParsedTranscript {
    if (payload.status === 'error') {
      throw new TranscriptionProviderError(`AssemblyAI job ${payload.id} failed: ${payload.error ?? 'unknown error'}`);
    }

    const utterances = payload.utterances ?? [];
    return {
      language: payload.language_code ?? null,
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
    const response = await fetch(`${this.baseUrl}/upload`, {
      method: 'POST',
      headers: { Authorization: apiKey },
      // @ts-expect-error — Node fetch требует duplex:'half' для стриминга тела запроса, не входит в стандартный RequestInit-тип текущей версии TS lib.dom
      duplex: 'half',
      body: fileStream,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      throw new TranscriptionProviderError(
        `AssemblyAI upload failed: ${response.status} ${response.statusText} — ${body}`,
      );
    }

    const data = (await response.json()) as { upload_url: string };
    return data.upload_url;
  }
}

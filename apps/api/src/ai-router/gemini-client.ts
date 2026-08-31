// Пункт [multimodal] §5 — GeminiClient против Interactions API.
//
// ПОЧЕМУ Interactions API, а не generateContent: редакция 1 ТЗ целилась
// в `POST /v1beta/models/{model}:generateContent`, но эта поверхность
// уже названа Google «Legacy», а гайд по ломающим изменениям выпущен в
// мае 2026. Новый клиент против объявленной устаревшей поверхности —
// переписывание в первом же квартале эксплуатации (аудит ТЗ, B-1).
//
// Без SDK — глобальный fetch, по той же причине, что у двух соседних
// клиентов (см. шапку ai-provider-client.ts).
//
// КОНТРАКТ ПОДТВЕРЖДЁН ЖИВЫМ ВЫЗОВОМ (диагностика 2026-08-31,
// scripts/diagnose-gemini.ts, вариант A1 — единственный прошедший):
//   POST /v1beta/interactions
//   заголовок x-goog-api-key: <ключ>        ← header-auth, НЕ ?key=
//   тело: { model, background: true, input: [видео → текст] }
//   ответ: { id, status: "in_progress", ... } за ~2 с.
//
// Что НЕ подтверждено и потому НЕ отправляется:
//   - generation_config (max_output_tokens, thinking_level) — убран
//     целиком; thinking_level — главный подозреваемый прод-400-х;
//   - system_instruction — вместо отдельного поля системный промпт
//     ПОДКЛЕИВАЕТСЯ в начало текстового блока (см. submitBackground).
// Расширять тело можно только через новый прогон diagnose-gemini.ts.

import {
  AIProviderClient,
  AIProviderCompletionParams,
  AIProviderCompletionResult,
  ContentBlock,
  assertTextPrompt,
} from './ai-provider-client';

/** Восемь документированных статусов фоновой задачи (ТЗ §4.2).
 * Терминальный исход определяется ИМЕННО полем status — поля
 * finish_reason в этом контракте нет (аудит ТЗ, U-1). */
export type InteractionStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'requires_action'
  | 'failed'
  | 'cancelled'
  | 'incomplete'
  | 'budget_exceeded';

export interface BackgroundSubmitResult {
  externalId: string;
}

export interface BackgroundFetchResult {
  status: InteractionStatus;
  text?: string;
  error?: string;
  /** usage с разбивкой по модальностям (input_tokens_by_modality) —
   * официальное поле; без него стоимость медиа-вызова не отделить от
   * текстовых в телеметрии, а она на два порядка выше (ТЗ §5). */
  usage?: {
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalTokens?: number;
    inputTokensByModality?: Record<string, number>;
  };
  raw: unknown;
}

/** Клиент, умеющий фоновые задачи провайдера. Отдельный интерфейс, а
 * не расширение AIProviderClient: два существующих клиента фон не
 * умеют и не обязаны про него знать. */
export interface AIBackgroundProviderClient extends AIProviderClient {
  submitBackground(
    params: AIProviderCompletionParams,
    credentials: { apiKey: string; apiEndpoint: string },
  ): Promise<BackgroundSubmitResult>;
  fetchBackground(
    externalId: string,
    credentials: { apiKey: string; apiEndpoint: string },
  ): Promise<BackgroundFetchResult>;
}

/** Ошибка провайдера, НЕСУЩАЯ СЫРОЕ ТЕЛО ОТВЕТА.
 *
 * Прямая причина, по которой 400-е были «неотлаживаемы» в первом живом
 * прогоне: Google в теле 400 возвращает КОНКРЕТНОЕ сообщение о том,
 * какое поле не так. Обобщённый Error его глотал, и джоба молча висела
 * в RUNNING (retryCount 0, partialResult NULL) — воспроизведено на
 * проде 2026-08-31. Теперь тело доезжает до AIJob.partialResult. */
export class GeminiApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: string,
    readonly phase: 'submit' | 'poll',
  ) {
    super(`Gemini ${phase} failed: HTTP ${httpStatus} — ${body.slice(0, 2000)}`);
    this.name = 'GeminiApiError';
  }

  /** 429/5xx — транзиентные, имеет смысл ретраить/ждать следующего
   * тика. 400 — форма запроса: ретрай той же формы даст тот же 400,
   * джоба должна упасть СРАЗУ с телом ответа в partialResult. */
  get isRetryable(): boolean {
    return this.httpStatus === 429 || this.httpStatus >= 500;
  }
}

export function isBackgroundCapable(client: AIProviderClient): client is AIBackgroundProviderClient {
  return (
    typeof (client as AIBackgroundProviderClient).submitBackground === 'function' &&
    typeof (client as AIBackgroundProviderClient).fetchBackground === 'function'
  );
}

/** Сериализация ContentBlock[] в input Interactions API.
 * Порядок блоков сохраняется КАК ЕСТЬ: документация рекомендует текст
 * ПОСЛЕ медиа, и класть медиа первым — обязанность вызывающего кода
 * (ТЗ §5), клиент порядок не перетасовывает. */
function serializeInput(userPrompt: string | ContentBlock[]): Array<Record<string, unknown>> {
  if (typeof userPrompt === 'string') {
    return [{ type: 'text', text: userPrompt }];
  }
  return userPrompt.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    if (!block.resolved) {
      // Блок не прошёл через MediaUriResolver — это ошибка маршрута
      // (медиа мимо асинхронной полосы), падаем явно, а не шлём
      // провайдеру MediaRef, который он не поймёт.
      throw new Error('media block reached GeminiClient without a resolved URI — must go through the async lane');
    }
    return {
      type: 'video',
      uri: block.resolved.uri,
      // mime_type — только для blob-источника; для YouTube-URI не
      // передаётся (ТЗ §5).
      ...(block.ref.source === 'blob' && block.resolved.mimeType
        ? { mime_type: block.resolved.mimeType }
        : {}),
    };
  });
}

export class GeminiClient implements AIBackgroundProviderClient {
  /** Синхронный complete() намеренно не реализован: для текстовых
   * taskType этот клиент не используется вовсе (ТЗ §5), а медиа-вызов
   * не помещается в maxDuration функции (§4.1). Явная ошибка честнее
   * молчаливого медленного пути. */
  async complete(
    params: AIProviderCompletionParams,
    _credentials: { apiKey: string; apiEndpoint: string },
  ): Promise<AIProviderCompletionResult> {
    // Для строки текст есть, но синхронный путь всё равно закрыт —
    // единообразный отказ, чтобы конфигурационная ошибка (Gemini на
    // текстовом taskType) всплыла сразу.
    assertTextPrompt(params.userPrompt, 'Gemini (sync path is intentionally disabled)');
    throw new Error(
      'GeminiClient is background-only: use the async lane (enqueue/submitQueued/pollRunning), not execute()',
    );
  }

  async submitBackground(
    params: AIProviderCompletionParams,
    credentials: { apiKey: string; apiEndpoint: string },
  ): Promise<BackgroundSubmitResult> {
    const input = serializeInput(params.userPrompt);

    // Системный промпт — В ТЕКСТОВЫЙ БЛОК, не отдельным полем: живой
    // прогон подтвердил только форму A1 (model/background/input), поле
    // system_instruction не проверено и до подтверждения новым прогоном
    // diagnose-gemini.ts в тело не кладётся. Подклеиваем в ПЕРВЫЙ
    // текстовый блок — он и так идёт после медиа (порядок §5).
    if (params.systemPrompt) {
      const firstText = input.find((b) => b.type === 'text');
      if (firstText) {
        firstText.text = `${params.systemPrompt}\n\n${firstText.text}`;
      } else {
        input.push({ type: 'text', text: params.systemPrompt });
      }
    }

    // Ровно форма A1: model + background + input, БЕЗ generation_config
    // (params.maxTokens сознательно игнорируется: несуществующее поле в
    // теле — это прод-400 на каждый вызов, а дефолтный потолок модели
    // достаточно велик; статус incomplete обрабатывается воркером).
    // response_mime_type/structured output НЕ задаём (ТЗ §5): валидация
    // остаётся за validateOutput, требование JSON живёт в промпте.
    const body: Record<string, unknown> = {
      model: params.model,
      background: true,
      input,
    };

    const response = await fetch(`${credentials.apiEndpoint}/v1beta/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Header-auth подтверждён A1; query-вариант (?key=) в живом
        // прогоне не прошёл ни разу.
        'x-goog-api-key': credentials.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable body>');
      throw new GeminiApiError(response.status, errorText, 'submit');
    }

    const json: any = await response.json();
    const externalId = json?.id;
    if (typeof externalId !== 'string' || !externalId) {
      throw new Error('Gemini interactions submit returned unexpected shape (no id)');
    }
    return { externalId };
  }

  async fetchBackground(
    externalId: string,
    credentials: { apiKey: string; apiEndpoint: string },
  ): Promise<BackgroundFetchResult> {
    const response = await fetch(
      `${credentials.apiEndpoint}/v1beta/interactions/${encodeURIComponent(externalId)}`,
      // Header-auth — как в подтверждённом submit (A1); отдельно GET не
      // диагностировался, но схема auth у поверхности одна.
      { method: 'GET', headers: { 'x-goog-api-key': credentials.apiKey } },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable body>');
      throw new GeminiApiError(response.status, errorText, 'poll');
    }

    const json: any = await response.json();
    const status = json?.status;
    if (typeof status !== 'string') {
      throw new Error('Gemini interactions fetch returned unexpected shape (no status)');
    }

    // output_text — конкатенация последнего model_output; полная форма
    // — steps[].content[].text. Для completed без output_text — явная
    // ошибка о неожиданной форме, как у двух существующих клиентов.
    let text: string | undefined;
    if (status === 'completed') {
      if (typeof json?.output_text === 'string') {
        text = json.output_text;
      } else {
        throw new Error('Gemini interactions returned status=completed without output_text — unexpected shape');
      }
    }

    return {
      status: status as InteractionStatus,
      text,
      error: typeof json?.error?.message === 'string' ? json.error.message : undefined,
      usage: json?.usage
        ? {
            totalInputTokens: json.usage.total_input_tokens,
            totalOutputTokens: json.usage.total_output_tokens,
            totalTokens: json.usage.total_tokens,
            inputTokensByModality: json.usage.input_tokens_by_modality,
          }
        : undefined,
      raw: json,
    };
  }
}

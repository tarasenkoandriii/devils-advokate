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
// АВТОРИЗАЦИЯ: в отличие от OpenAI/Anthropic (ключ в заголовке), Gemini
// принимает ключ query-параметром. AIProvider.authMethod в схеме
// существовал с чекпоинта 1 и НИГДЕ не читался — этот клиент оживляет
// его вместе с vision/audio (§12.2 самоаудита ТЗ).
//
// ЧЕСТНАЯ ГРАНИЦА: контракт Interactions API восстановлен по
// официальной документации (включая страницу breaking changes), но НЕ
// подтверждён живым вызовом — в этой среде нет ключа. Та же оговорка,
// что у всего внешнего периметра проекта.

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
    const body: Record<string, unknown> = {
      model: params.model,
      background: true,
      input: serializeInput(params.userPrompt),
      generation_config: {
        max_output_tokens: params.maxTokens ?? 8192,
        thinking_level: 'medium',
      },
      ...(params.systemPrompt ? { system_instruction: params.systemPrompt } : {}),
      // response_mime_type/structured output НЕ задаём (ТЗ §5):
      // валидация остаётся за validateOutput, как у двух существующих
      // провайдеров; требование JSON живёт в тексте промпта.
    };

    const response = await fetch(
      `${credentials.apiEndpoint}/v1beta/interactions?key=${encodeURIComponent(credentials.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable body>');
      throw new Error(`Gemini interactions submit error: ${response.status} ${response.statusText} — ${errorText}`);
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
      `${credentials.apiEndpoint}/v1beta/interactions/${encodeURIComponent(externalId)}?key=${encodeURIComponent(credentials.apiKey)}`,
      { method: 'GET' },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable body>');
      throw new Error(`Gemini interactions fetch error: ${response.status} ${response.statusText} — ${errorText}`);
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

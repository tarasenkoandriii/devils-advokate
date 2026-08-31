// MVP-фича 1: клиенты AI-провайдеров
//
// Без внешних SDK намеренно — глобальный fetch (Node 18+) достаточен
// для простого chat-completion запроса, а SDK каждого вендора тянет
// свои зависимости и версии, которые на момент написания этого кода
// нельзя было установить (сеть отключена в среде разработки). Если
// позже понадобятся специфичные для SDK возможности (стриминг с
// удобной абстракцией, встроенный retry) — можно заменить конкретный
// клиент на официальный SDK, не трогая интерфейс AIProviderClient.

// ─────────────────────────────────────────────────────────────────────
// Пункт [multimodal] (devils-advocate-multimodal-media-analysis-tz.md,
// §3) — контракт медиа-блоков. Расширение, не замена: строка остаётся
// полностью валидным userPrompt, ни один из 85+ существующих taskType
// не меняется ни одной строкой кода.
// ─────────────────────────────────────────────────────────────────────

/** Ссылка на медиа, ещё НЕ разрешённая в URL. Хранится в таком виде в
 * AIJob.pendingRequest и участвует в hashInput() — подписанный URL
 * протухает и менялся бы при каждом presign, делая inputHash
 * бесполезным для дедупликации (ТЗ §10.1). Разрешение в URI происходит
 * в момент вызова провайдера — MediaUriResolver ниже. */
export type MediaRef =
  | { source: 'youtube'; videoId: string }
  | { source: 'blob'; pathname: string; mimeType: string };

export type ContentBlock =
  | { type: 'text'; text: string }
  /** mediaResolution — задел контракта (ТЗ §5): в Interactions API
   * параметр не подтверждён, клиент его на этом проходе ИГНОРИРУЕТ.
   * Рычаг стоимости — длительность ролика, не разрешение.
   * resolved — заполняется РОУТЕРОМ в момент вызова (MediaRef → URI);
   * до этого блок хранится и хэшируется без URL (§10.1). Клиент
   * провайдера читает только resolved и падает, если его нет. */
  | {
      type: 'media';
      ref: MediaRef;
      mediaResolution?: 'low' | 'default';
      resolved?: { uri: string; mimeType?: string };
    };

/** Есть ли в промпте медиа-блок — от этого зависит выбор модели
 * (resolveModelVersion фильтрует по vision/audio, ТЗ §10.3) и маршрут
 * исполнения (медиа идёт только через асинхронную полосу). */
export function requiresMedia(userPrompt: string | ContentBlock[]): boolean {
  return Array.isArray(userPrompt) && userPrompt.some((b) => b.type === 'media');
}

/** Разрешение MediaRef → URI. Отдельный интерфейс, чтобы клиент
 * провайдера не знал ни про Blob, ни про YouTube (ТЗ §3.3). */
export interface MediaUriResolver {
  resolve(ref: MediaRef): Promise<{ uri: string; mimeType?: string }>;
}

// ─────────────────────────────────────────────────────────────────────
// Константы времени асинхронной полосы (ТЗ §3.3, §7.2). Все три
// выведены из ОДНОГО потолка ожидания внешней задачи — назначать их
// независимо нельзя, разъедутся: файл будет удалён или подпись
// протухнет, пока Google ещё держит задачу в очереди.
//
// 2 часа — НАЗНАЧЕННОЕ значение, не измеренное: фактический SLA
// очереди Interactions API в этой среде замерить нельзя (ТЗ §12.2).
// Пересмотреть по реальным таймингам после первых прогонов.
// ─────────────────────────────────────────────────────────────────────
export const EXTERNAL_INTERACTION_MAX_WAIT_MS = 2 * 60 * 60 * 1000;
export const PRESIGN_TTL_MS = EXTERNAL_INTERACTION_MAX_WAIT_MS + 15 * 60 * 1000;
export const MEDIA_LEASE_MAX_AGE_MS = EXTERNAL_INTERACTION_MAX_WAIT_MS + 15 * 60 * 1000;

export interface AIProviderCompletionParams {
  model: string; // имя модели у провайдера, например "gpt-4.1", "claude-sonnet-5"
  systemPrompt?: string;
  /** Строка ИЛИ блоки. Провайдеры, не умеющие медиа, обязаны бросить
   * явную ошибку на блоках, а не сериализовать их в текст (ТЗ §3.2). */
  userPrompt: string | ContentBlock[];
  maxTokens?: number;
  temperature?: number;
  /** Если true — провайдер должен вернуть валидный JSON (где поддерживается). */
  jsonMode?: boolean;
}

/** Общий для текстовых клиентов отказ от медиа-блоков: провалиться
 * явно лучше, чем молча превратить видео в строку «[object Object]». */
export function assertTextPrompt(userPrompt: string | ContentBlock[], providerLabel: string): string {
  if (typeof userPrompt === 'string') return userPrompt;
  throw new Error(`${providerLabel} provider does not support media content blocks`);
}

export interface AIProviderCompletionResult {
  text: string;
  raw: unknown; // сырой ответ провайдера — для дебага/AIInference.output, если потребуется
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface AIProviderClient {
  complete(
    params: AIProviderCompletionParams,
    credentials: { apiKey: string; apiEndpoint: string },
  ): Promise<AIProviderCompletionResult>;
}

/**
 * OpenAI-совместимый chat/completions формат — подходит для OpenAI и
 * xAI Grok (Grok API OpenAI-совместим), поэтому один клиент на оба.
 */
export class OpenAiCompatibleClient implements AIProviderClient {
  async complete(
    params: AIProviderCompletionParams,
    credentials: { apiKey: string; apiEndpoint: string },
  ): Promise<AIProviderCompletionResult> {
    const userText = assertTextPrompt(params.userPrompt, 'OpenAI-compatible');
    const messages = [
      ...(params.systemPrompt
        ? [{ role: 'system', content: params.systemPrompt }]
        : []),
      { role: 'user', content: userText },
    ];

    const body: Record<string, unknown> = {
      model: params.model,
      messages,
      max_tokens: params.maxTokens ?? 1000,
      temperature: params.temperature ?? 0.7,
    };
    if (params.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(`${credentials.apiEndpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable body>');
      throw new Error(
        `OpenAI-compatible provider error: ${response.status} ${response.statusText} — ${errorText}`,
      );
    }

    const json: any = await response.json(); // runtime-shape проверяется ниже; @types/node >=20.19 типизирует json() как unknown
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new Error('OpenAI-compatible provider returned unexpected shape (no choices[0].message.content)');
    }

    return {
      text,
      raw: json,
      usage: {
        promptTokens: json?.usage?.prompt_tokens,
        completionTokens: json?.usage?.completion_tokens,
      },
    };
  }
}

/**
 * Anthropic Messages API — своя форма запроса/ответа (x-api-key вместо
 * Bearer, system как отдельное top-level поле, content — массив блоков).
 */
export class AnthropicClient implements AIProviderClient {
  async complete(
    params: AIProviderCompletionParams,
    credentials: { apiKey: string; apiEndpoint: string },
  ): Promise<AIProviderCompletionResult> {
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens ?? 1000,
      temperature: params.temperature ?? 0.7,
      messages: [{ role: 'user', content: assertTextPrompt(params.userPrompt, 'Anthropic') }],
      ...(params.systemPrompt ? { system: params.systemPrompt } : {}),
    };

    const response = await fetch(`${credentials.apiEndpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': credentials.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable body>');
      throw new Error(
        `Anthropic provider error: ${response.status} ${response.statusText} — ${errorText}`,
      );
    }

    const json: any = await response.json(); // runtime-shape проверяется ниже; @types/node >=20.19 типизирует json() как unknown
    const textBlock = Array.isArray(json?.content)
      ? json.content.find((block: { type?: string }) => block?.type === 'text')
      : undefined;
    const text = textBlock?.text;
    if (typeof text !== 'string') {
      throw new Error('Anthropic provider returned unexpected shape (no text content block)');
    }

    return {
      text,
      raw: json,
      usage: {
        promptTokens: json?.usage?.input_tokens,
        completionTokens: json?.usage?.output_tokens,
      },
    };
  }
}

/** Выбор клиента по имени провайдера (`AIProvider.name` из схемы). */
export function selectProviderClient(providerName: string): AIProviderClient {
  switch (providerName) {
    case 'openai':
    case 'xai':
      return new OpenAiCompatibleClient();
    case 'anthropic':
      return new AnthropicClient();
    // Пункт [multimodal] §5 — единственный клиент с медиа и фоновыми
    // задачами. Импорт внизу файла, не наверху: gemini-client.ts сам
    // импортирует типы отсюда, и верхний импорт дал бы цикл на этапе
    // инициализации модулей.
    case 'google': {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { GeminiClient } = require('./gemini-client') as typeof import('./gemini-client');
      return new GeminiClient();
    }
    default:
      throw new Error(`No AIProviderClient registered for provider "${providerName}"`);
  }
}

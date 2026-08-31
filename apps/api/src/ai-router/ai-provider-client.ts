// MVP-фича 1: клиенты AI-провайдеров
//
// Без внешних SDK намеренно — глобальный fetch (Node 18+) достаточен
// для простого chat-completion запроса, а SDK каждого вендора тянет
// свои зависимости и версии, которые на момент написания этого кода
// нельзя было установить (сеть отключена в среде разработки). Если
// позже понадобятся специфичные для SDK возможности (стриминг с
// удобной абстракцией, встроенный retry) — можно заменить конкретный
// клиент на официальный SDK, не трогая интерфейс AIProviderClient.

export interface AIProviderCompletionParams {
  model: string; // имя модели у провайдера, например "gpt-4.1", "claude-sonnet-5"
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Если true — провайдер должен вернуть валидный JSON (где поддерживается). */
  jsonMode?: boolean;
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
    const messages = [
      ...(params.systemPrompt
        ? [{ role: 'system', content: params.systemPrompt }]
        : []),
      { role: 'user', content: params.userPrompt },
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
      messages: [{ role: 'user', content: params.userPrompt }],
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
    default:
      throw new Error(`No AIProviderClient registered for provider "${providerName}"`);
  }
}

// Пункт [multimodal] §5, фаза C — юнит-тесты GeminiClient с мокнутым
// fetch, включая ВСЕ терминальные ветки status (критерий фазы).
//
// Живого вызова Interactions API в этой среде нет — тесты фиксируют
// контракт, восстановленный по документации: если он окажется другим,
// чиниться будет клиент, а тесты — вместе с ним, осознанно.

import { GeminiClient, GeminiApiError, isBackgroundCapable } from '../ai-router/gemini-client';
import { OpenAiCompatibleClient, AnthropicClient, ContentBlock } from '../ai-router/ai-provider-client';

const CREDS = { apiKey: 'gk-test', apiEndpoint: 'https://generativelanguage.googleapis.com' };

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

afterEach(() => jest.restoreAllMocks());

describe('GeminiClient.submitBackground', () => {
  it('КЛЮЧЕВОЙ ТЕСТ (форма A1, подтверждена живым вызовом 2026-08-31): header-auth, тело ТОЛЬКО model+background+input', async () => {
    const spy = mockFetchOnce({ id: 'int-1', status: 'queued' });
    const client = new GeminiClient();

    const prompt: ContentBlock[] = [
      { type: 'media', ref: { source: 'youtube', videoId: 'abc123' }, resolved: { uri: 'https://www.youtube.com/watch?v=abc123' } },
      { type: 'text', text: 'разбери ролик' },
    ];
    const res = await client.submitBackground({ model: 'gemini-3.7-flash', userPrompt: prompt, maxTokens: 8192 }, CREDS);

    expect(res.externalId).toBe('int-1');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    // Ключ в ЗАГОЛОВКЕ, не в query: A1 (header) прошёл, A3 (?key=) — нет.
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(url).not.toContain('key=');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('gk-test');
    const body = JSON.parse(init.body as string);
    expect(body.background).toBe(true);
    expect(body.model).toBe('gemini-3.7-flash');
    // РОВНО три поля: непроверенное поле в теле = прод-400 на каждый вызов.
    expect(Object.keys(body).sort()).toEqual(['background', 'input', 'model']);
    // generation_config/thinking_level убраны — maxTokens сознательно игнорируется.
    expect(body.generation_config).toBeUndefined();
    expect(body.input[0].type).toBe('video');
    expect(body.input[0].uri).toBe('https://www.youtube.com/watch?v=abc123');
    // mime_type для YouTube-URI НЕ передаётся (§5)
    expect(body.input[0].mime_type).toBeUndefined();
    expect(body.input[1]).toEqual({ type: 'text', text: 'разбери ролик' });
  });

  it('systemPrompt подклеивается в первый текстовый блок — поле system_instruction не отправляется (не подтверждено A1)', async () => {
    const spy = mockFetchOnce({ id: 'int-3', status: 'queued' });
    const client = new GeminiClient();
    await client.submitBackground(
      {
        model: 'm',
        systemPrompt: 'Ты строгий аналитик.',
        userPrompt: [
          { type: 'media', ref: { source: 'youtube', videoId: 'v' }, resolved: { uri: 'https://www.youtube.com/watch?v=v' } },
          { type: 'text', text: 'разбери ролик' },
        ],
      },
      CREDS,
    );
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.system_instruction).toBeUndefined();
    // Порядок сохранён: медиа первым, текст (с подклеенной системой) после.
    expect(body.input[0].type).toBe('video');
    expect(body.input[1].text).toBe('Ты строгий аналитик.\n\nразбери ролик');
  });

  it('poll идёт с тем же header-auth, без ?key=', async () => {
    const spy = mockFetchOnce({ id: 'int-1', status: 'in_progress' });
    const client = new GeminiClient();
    await client.fetchBackground('int-1', CREDS);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions/int-1');
    expect(url).not.toContain('key=');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('gk-test');
  });

  it('mime_type передаётся ТОЛЬКО для blob-источника', async () => {
    const spy = mockFetchOnce({ id: 'int-2', status: 'queued' });
    const client = new GeminiClient();
    await client.submitBackground(
      {
        model: 'm',
        userPrompt: [
          {
            type: 'media',
            ref: { source: 'blob', pathname: 'conversation-audio/c/f.m4a', mimeType: 'audio/mp4' },
            resolved: { uri: 'https://blob.example/signed', mimeType: 'audio/mp4' },
          },
          { type: 'text', text: 'p' },
        ],
      },
      CREDS,
    );
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.input[0].mime_type).toBe('audio/mp4');
    expect(body.input[0].uri).toBe('https://blob.example/signed');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: media-блок без resolved — явная ошибка, а не MediaRef в проводе', async () => {
    const client = new GeminiClient();
    await expect(
      client.submitBackground(
        { model: 'm', userPrompt: [{ type: 'media', ref: { source: 'youtube', videoId: 'x' } }] },
        CREDS,
      ),
    ).rejects.toThrow(/resolved URI/);
  });
});

describe('GeminiApiError — сырое тело и ретраебельность', () => {
  it('КЛЮЧЕВОЙ ТЕСТ (живой прогон 2026-08-31): 400 на submit — GeminiApiError с ТЕЛОМ ответа, isRetryable=false', async () => {
    mockFetchOnce({ error: { code: 400, message: 'Invalid JSON payload received. Unknown name "thinking_level"' } }, false, 400);
    const client = new GeminiClient();
    const err = await client
      .submitBackground({ model: 'm', userPrompt: 'p' }, CREDS)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(GeminiApiError);
    const apiErr = err as GeminiApiError;
    expect(apiErr.httpStatus).toBe(400);
    expect(apiErr.phase).toBe('submit');
    // Тело 400-го — единственный источник причины; оно НЕ теряется.
    expect(apiErr.body).toContain('thinking_level');
    expect(apiErr.isRetryable).toBe(false);
  });

  it('503/429 на опросе — GeminiApiError с isRetryable=true (транзиентная, ждём следующий тик)', async () => {
    mockFetchOnce({ error: { code: 503, message: 'The model is overloaded' } }, false, 503);
    const client = new GeminiClient();
    const err503 = (await client.fetchBackground('int-1', CREDS).then(() => null, (e: unknown) => e)) as GeminiApiError;
    expect(err503).toBeInstanceOf(GeminiApiError);
    expect(err503.phase).toBe('poll');
    expect(err503.isRetryable).toBe(true);

    mockFetchOnce({ error: { code: 429, message: 'quota' } }, false, 429);
    const err429 = (await client.fetchBackground('int-1', CREDS).then(() => null, (e: unknown) => e)) as GeminiApiError;
    expect(err429.isRetryable).toBe(true);
  });
});

describe('GeminiClient.fetchBackground — маппинг статусов', () => {
  it.each(['queued', 'in_progress', 'failed', 'cancelled', 'budget_exceeded', 'incomplete', 'requires_action'] as const)(
    'статус %s возвращается как есть, без text',
    async (status) => {
      mockFetchOnce({ id: 'int-1', status, error: { message: 'why' } });
      const client = new GeminiClient();
      const res = await client.fetchBackground('int-1', CREDS);
      expect(res.status).toBe(status);
      expect(res.text).toBeUndefined();
      expect(res.error).toBe('why');
    },
  );

  it('completed с output_text — текст и usage с разбивкой по модальностям', async () => {
    mockFetchOnce({
      id: 'int-1',
      status: 'completed',
      output_text: '{"ok":true}',
      usage: {
        total_input_tokens: 360000,
        total_output_tokens: 2000,
        total_tokens: 362000,
        input_tokens_by_modality: { video: 350000, audio: 8000, text: 2000 },
      },
    });
    const client = new GeminiClient();
    const res = await client.fetchBackground('int-1', CREDS);
    expect(res.text).toBe('{"ok":true}');
    // input_tokens_by_modality обязателен в телеметрии: иначе стоимость
    // медиа-вызова не отделить от текстовых (§5).
    expect(res.usage?.inputTokensByModality?.video).toBe(350000);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: completed БЕЗ output_text — ошибка о неожиданной форме, не пустой успех', async () => {
    mockFetchOnce({ id: 'int-1', status: 'completed' });
    const client = new GeminiClient();
    await expect(client.fetchBackground('int-1', CREDS)).rejects.toThrow(/output_text/);
  });
});

describe('Синхронный путь и текстовые клиенты', () => {
  it('GeminiClient.complete() отключён намеренно — асинхронная полоса или ничего', async () => {
    const client = new GeminiClient();
    await expect(client.complete({ model: 'm', userPrompt: 'text' }, CREDS)).rejects.toThrow(/background-only/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (фаза A): OpenAI/Anthropic на ContentBlock[] бросают явную ошибку, не сериализуют блоки в текст', async () => {
    const blocks: ContentBlock[] = [{ type: 'media', ref: { source: 'youtube', videoId: 'x' } }];
    await expect(
      new OpenAiCompatibleClient().complete({ model: 'm', userPrompt: blocks }, { apiKey: 'k', apiEndpoint: 'e' }),
    ).rejects.toThrow(/does not support media content blocks/);
    await expect(
      new AnthropicClient().complete({ model: 'm', userPrompt: blocks }, { apiKey: 'k', apiEndpoint: 'e' }),
    ).rejects.toThrow(/does not support media content blocks/);
  });

  it('isBackgroundCapable отличает Gemini от текстовых клиентов', () => {
    expect(isBackgroundCapable(new GeminiClient())).toBe(true);
    expect(isBackgroundCapable(new OpenAiCompatibleClient())).toBe(false);
    expect(isBackgroundCapable(new AnthropicClient())).toBe(false);
  });
});

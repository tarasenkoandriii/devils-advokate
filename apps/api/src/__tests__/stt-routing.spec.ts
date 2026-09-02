// Пункт [stt-multi] 2026-09-02 — маршрутизация распознавания речи.
//
// Продуктовое решение владельца: Soniox для русского и украинского,
// прежний провайдер для английского, общий фоллбек — ElevenLabs.
// Фактическая причина правки: у AssemblyAI НЕТ ни русского, ни
// украинского в потоковом режиме ни в одной модели — живой прогон
// голосового ввода на русском вернул галлюцинацию на английском и
// иврите (см. transcribeShortNoteSync, обходной путь того же дня).
import { ServiceUnavailableException } from '@nestjs/common';
import {
  normalizeSttLanguage,
  sttFallbackChain,
  sttLanguageHints,
  sttProviderForLanguage,
} from '../stt/stt-language';
import { formatSttJobId, parseSttJobId, sttJobIdVariants, SttService } from '../stt/stt.service';
import { parseSttWebhookPayload } from '../stt/stt-webhook-payload';
import { sonioxTokensToSegments, dominantSonioxLanguage } from '../stt/soniox-stt.provider';
import { AssemblyAiSttProvider } from '../stt/assemblyai-stt.provider';

describe('sttProviderForLanguage', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: русский и украинский идут в Soniox', () => {
    expect(sttProviderForLanguage('ru')).toBe('soniox');
    expect(sttProviderForLanguage('uk')).toBe('soniox');
    expect(sttProviderForLanguage('ru-RU')).toBe('soniox');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: английский остаётся на прежнем провайдере', () => {
    expect(sttProviderForLanguage('en')).toBe('assemblyai');
    expect(sttProviderForLanguage('en-US')).toBe('assemblyai');
  });

  it('язык неизвестен — мультиязычный Soniox, а не англоязычный по умолчанию', () => {
    // Аудитория продукта — Украина. «Не знаем язык» здесь ближе к ru/uk,
    // и ошибка в эту сторону дешевле: у Soniox есть определение языка,
    // у потоковой модели AssemblyAI нет самих языков.
    expect(sttProviderForLanguage(null)).toBe('soniox');
    expect(sttProviderForLanguage('мусор')).toBe('soniox');
  });

  it('normalizeSttLanguage режет регион и отбрасывает мусор', () => {
    expect(normalizeSttLanguage('uk-UA')).toBe('uk');
    expect(normalizeSttLanguage('  ')).toBeNull();
    expect(normalizeSttLanguage('12')).toBeNull();
  });
});

describe('sttFallbackChain', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: на короткой записи фоллбек для ЛЮБОГО языка — ElevenLabs', () => {
    expect(sttFallbackChain('ru', 'sync')).toEqual(['soniox', 'elevenlabs']);
    expect(sttFallbackChain('en', 'sync')).toEqual(['assemblyai', 'elevenlabs']);
  });

  it('на длинном файле фоллбек — второй ВЕБХУЧНЫЙ провайдер, не ElevenLabs', () => {
    // У ElevenLabs подпись вебхука задаётся в рабочем пространстве, а не
    // в запросе: наш guard такой вебхук не примет, и результат
    // потерялся бы МОЛЧА — худший вид отказа.
    expect(sttFallbackChain('ru', 'webhook')).toEqual(['soniox', 'assemblyai']);
    expect(sttFallbackChain('en', 'webhook')).toEqual(['assemblyai', 'soniox']);
  });

  it('в живом режиме второй попытки нет — подключается клиент, не мы', () => {
    expect(sttFallbackChain('ru', 'realtime')).toEqual(['soniox']);
    expect(sttFallbackChain('en', 'realtime')).toEqual(['assemblyai']);
  });

  it('подсказки языков для ru/uk — обе: разговор бывает смешанным', () => {
    expect(sttLanguageHints('ru')).toEqual(['ru', 'uk']);
    expect(sttLanguageHints('uk')).toEqual(['uk', 'ru']);
    expect(sttLanguageHints('en')).toEqual(['en']);
    expect(sttLanguageHints(null)).toEqual(['uk', 'ru']);
  });
});

describe('идентификатор задачи', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: идентификатор без префикса читается как AssemblyAI', () => {
    // Так лежат все задачи, поставленные ДО этой правки. Они висят в
    // очереди провайдера часами — их результат обязан дочитаться.
    expect(parseSttJobId('abc-123')).toEqual({ provider: 'assemblyai', externalJobId: 'abc-123' });
  });

  it('префикс определяет провайдера, а не язык — задачу мог взять запасной', () => {
    expect(parseSttJobId('soniox:uuid-1')).toEqual({ provider: 'soniox', externalJobId: 'uuid-1' });
    expect(formatSttJobId('soniox', 'uuid-1')).toBe('soniox:uuid-1');
  });

  it('двоеточие внутри чужого идентификатора не путается с префиксом', () => {
    expect(parseSttJobId('weird:id:1').provider).toBe('assemblyai');
  });

  it('КЛЮЧЕВОЙ ТЕСТ (ревью 2026-09-02): голый id из вебхука ищется во ВСЕХ написаниях', () => {
    // Блокер, найденный ревью: варианты строились по провайдеру,
    // выведенному из самой строки, — для голого id (а именно такой
    // приносит вебхук) получалось только `assemblyai:<id>`, и вебхук
    // Soniox не находил разговор НИКОГДА. Расшифровка уже оплачена, а
    // разговор навсегда завис бы в TRANSCRIBING.
    expect(sttJobIdVariants('uuid-1')).toContain('soniox:uuid-1');
    expect(sttJobIdVariants('uuid-1')).toContain('assemblyai:uuid-1');
    expect(sttJobIdVariants('uuid-1')[0]).toBe('uuid-1');
    // Префиксная форма тоже ищет «голую»: строки до выката лежат без
    // префикса.
    expect(sttJobIdVariants('soniox:uuid-1')).toContain('uuid-1');
  });
});

describe('parseSttWebhookPayload', () => {
  it('понимает обе формы тела: transcript_id у AssemblyAI, id у Soniox', () => {
    expect(parseSttWebhookPayload({ transcript_id: 'a1', status: 'completed' })).toEqual({
      externalJobId: 'a1',
      status: 'completed',
    });
    expect(parseSttWebhookPayload({ id: 's1', status: 'error' })).toEqual({
      externalJobId: 's1',
      status: 'error',
    });
  });

  it('пустое тело — null, а не undefined: Prisma трактует undefined как «фильтра нет»', () => {
    // Ровно та ошибка, которую в проекте уже ловили: findFirst с
    // undefined возвращал ПЕРВУЮ попавшуюся запись таблицы.
    expect(parseSttWebhookPayload({}).externalJobId).toBeNull();
    expect(parseSttWebhookPayload(null).externalJobId).toBeNull();
  });
});

describe('разбор ответа Soniox', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: токены склеиваются в реплики по говорящему', () => {
    // Soniox отдаёт потокенную разметку, наша модель данных — реплики.
    const segments = sonioxTokensToSegments([
      { text: 'Привіт', start_ms: 0, end_ms: 500, speaker: '1', confidence: 0.9 },
      { text: ', як ', start_ms: 500, end_ms: 800, speaker: '1', confidence: 0.8 },
      { text: 'справи', start_ms: 800, end_ms: 1200, speaker: '1', confidence: 0.95 },
      { text: 'Нормально', start_ms: 1300, end_ms: 2000, speaker: '2', confidence: 0.7 },
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      diarizationLabel: '1',
      text: 'Привіт, як справи',
      startMs: 0,
      endMs: 1200,
      // Уверенность реплики — минимальная из токенов: реплика не
      // надёжнее своего худшего слова.
      confidence: 0.8,
    });
    expect(segments[1].diarizationLabel).toBe('2');
  });

  it('без диаризации всё уходит одному говорящему, пустые куски отбрасываются', () => {
    const segments = sonioxTokensToSegments([
      { text: 'Одна' },
      { text: ' фраза' },
      { text: '   ' },
    ]);
    expect(segments).toEqual([
      { diarizationLabel: 'A', text: 'Одна фраза', startMs: 0, endMs: 0, confidence: null },
    ]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ (ревью 2026-09-02): служебный токен <end> не попадает в текст', () => {
    // enable_endpoint_detection у Soniox добавляет токен <end>
    // («is always final» по документации) — без фильтра он дописался бы
    // прямо в реплику пользователя и уехал бы в LLM.
    const segments = sonioxTokensToSegments([
      { text: 'Слово', start_ms: 0, end_ms: 300 },
      { text: '<end>', start_ms: 300, end_ms: 300 },
      { text: ' звук', start_ms: 300, end_ms: 400, is_audio_event: true },
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('Слово');
  });

  it('КЛЮЧЕВОЙ ТЕСТ (ревью 2026-09-02): пауза режет реплику даже у одного говорящего', () => {
    // Иначе монолог (и любая запись, где диаризация не разделила
    // говорящих) давал ОДИН сегмент на всю запись, и всё, что висит на
    // сегментах, деградировало до одной строки.
    const segments = sonioxTokensToSegments([
      { text: 'Первая мысль', start_ms: 0, end_ms: 1000, speaker: '1' },
      { text: 'Вторая мысль', start_ms: 3000, end_ms: 4000, speaker: '1' },
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[1].startMs).toBe(3000);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: язык записи — преобладающий, а не первый попавшийся', () => {
    // Смешанная речь — норма для нашей аудитории: одно украинское слово
    // в русском разговоре не должно делать разговор украинским.
    expect(
      dominantSonioxLanguage([
        { text: 'привет как дела вообще', language: 'ru' },
        { text: 'дякую', language: 'uk' },
      ]),
    ).toBe('ru');
    expect(dominantSonioxLanguage([{ text: 'без языка' }])).toBeNull();
  });
});

describe('AssemblyAiSttProvider.mintRealtimeToken', () => {
  // РЕВЬЮ 2026-09-02: единственный метод обёртки, который НЕ делегирует
  // в TranscriptionService, — живой HTTP-вызов, перенесённый из
  // LiveSessionService. После переноса он остался без покрытия: спека
  // live-session теперь подставляет фейк SttService.
  const originalFetch = (global as never as { fetch: unknown }).fetch;
  afterEach(() => {
    (global as never as { fetch: unknown }).fetch = originalFetch;
  });

  it('запрашивает временный токен и отдаёт реквизиты подключения', async () => {
    let calledUrl = '';
    let authHeader: string | undefined;
    (global as never as { fetch: unknown }).fetch = async (url: string, init: { headers: Record<string, string> }) => {
      calledUrl = url;
      authHeader = init.headers.Authorization;
      return { ok: true, json: async () => ({ token: 'temp-abc' }) };
    };

    const provider = new AssemblyAiSttProvider({} as never);
    const creds = await provider.mintRealtimeToken('sk-live', 300, ['en']);

    expect(calledUrl).toContain('streaming.assemblyai.com/v3/token');
    expect(calledUrl).toContain('expires_in_seconds=300');
    // Ключ уходит БЕЗ Bearer — форма именно этого провайдера.
    expect(authHeader).toBe('sk-live');
    expect(creds).toEqual({
      provider: 'assemblyai',
      token: 'temp-abc',
      expiresInSeconds: 300,
      websocketUrl: 'wss://streaming.assemblyai.com/v3/ws',
      model: 'universal-3-5-pro',
      languageHints: ['en'],
    });
  });

  it('ошибка провайдера — SttProviderError с телом ответа, а не молчание', async () => {
    (global as never as { fetch: unknown }).fetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'bad key',
    });
    const provider = new AssemblyAiSttProvider({} as never);
    await expect(provider.mintRealtimeToken('sk-live', 300, ['en'])).rejects.toThrow(/401/);
  });
});

describe('SttService: фоллбек', () => {
  function buildService(behaviour: {
    sonioxFails?: boolean;
    assemblyFails?: boolean;
    elevenFails?: boolean;
  }) {
    const calls: string[] = [];
    const make = (name: string, fails: boolean | undefined) => ({
      name,
      lanes: ['sync', 'webhook', 'realtime'],
      async transcribeSync() {
        calls.push(name);
        if (fails) throw new Error(`${name} упал`);
        return { text: `текст от ${name}`, language: 'ru' };
      },
      async submitWebhookJob() {
        calls.push(name);
        if (fails) throw new Error(`${name} упал`);
        return { externalJobId: `${name}-job` };
      },
      async fetchResult() {
        return { language: 'ru', segments: [] };
      },
      async uploadAudio() {
        return `${name}-url`;
      },
    });

    const secrets = { resolve: async () => 'key' };
    const service = new SttService(
      secrets as never,
      make('soniox', behaviour.sonioxFails) as never,
      make('assemblyai', behaviour.assemblyFails) as never,
      make('elevenlabs', behaviour.elevenFails) as never,
    );
    return { service, calls };
  }

  it('КЛЮЧЕВОЙ ТЕСТ: отказ Soniox на короткой записи подхватывает ElevenLabs', () => {
    const { service, calls } = buildService({ sonioxFails: true });
    return service.transcribeSync(Buffer.from('x'), 'ru').then((result) => {
      expect(calls).toEqual(['soniox', 'elevenlabs']);
      expect(result.provider).toBe('elevenlabs');
      expect(result.text).toBe('текст от elevenlabs');
    });
  });

  it('отказали все — честная 503 с перечислением причин, а не тишина', async () => {
    const { service } = buildService({ sonioxFails: true, elevenFails: true });
    await expect(service.transcribeSync(Buffer.from('x'), 'ru')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('КЛЮЧЕВОЙ ТЕСТ: на длинном файле задача уходит второму ВЕБХУЧНОМУ провайдеру', async () => {
    const { service, calls } = buildService({ sonioxFails: true });
    const job = await service.submitWebhookJob({
      audioUrl: 'https://blob/x',
      webhookUrl: 'https://api/webhook',
      languageCode: 'uk',
      diarize: true,
    });

    expect(calls).toEqual(['soniox', 'assemblyai']);
    // Идентификатор помнит, КТО взял задачу — иначе вебхук пошёл бы за
    // результатом не к тому провайдеру.
    expect(job.storedId).toBe('assemblyai:assemblyai-job');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: если байты уже отданы провайдеру, фоллбека нет', async () => {
    // Ссылка на файл внутри одного провайдера другому бесполезна:
    // «молча уйти к соседу» здесь означает отправить его в никуда.
    const { service, calls } = buildService({ sonioxFails: true });
    await expect(
      service.submitWebhookJob({
        audioUrl: 'soniox-file:abc',
        webhookUrl: 'https://api/webhook',
        languageCode: 'ru',
        diarize: false,
        uploadedTo: 'soniox',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(calls).toEqual(['soniox']);
  });
});

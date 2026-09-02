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
import { sonioxTokensToSegments, dominantSonioxLanguage, SonioxSttProvider, normalizeAudioMime, audioExtensionFor } from '../stt/soniox-stt.provider';
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
    // providerHint — по имени поля: он нужен, чтобы убрать у провайдера
    // задачу, владельца которой у нас уже нет (аудит 2026-09-02).
    expect(parseSttWebhookPayload({ transcript_id: 'a1', status: 'completed' })).toEqual({
      externalJobId: 'a1',
      status: 'completed',
      providerHint: 'assemblyai',
    });
    expect(parseSttWebhookPayload({ id: 's1', status: 'error' })).toEqual({
      externalJobId: 's1',
      status: 'error',
      providerHint: 'soniox',
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

describe('SonioxSttProvider: уборка у провайдера (аудит 2026-09-02)', () => {
  // Soniox хранит файл и транскрипт до 30 дней, и удаление транскрипта
  // не удаляет файл. Согласие пользователя обещает транзит, не хранение
  // у субподрядчика — поэтому после чтения результата уходят оба DELETE.
  const originalFetch = (global as never as { fetch: unknown }).fetch;
  afterEach(() => {
    (global as never as { fetch: unknown }).fetch = originalFetch;
  });

  function installFetch(status: 'completed' | 'processing' | 'error', log: string[]) {
    (global as never as { fetch: unknown }).fetch = async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      log.push(`${method} ${url.replace('https://api.soniox.com/v1', '')}`);
      if (method === 'DELETE') return { ok: true, status: 204, statusText: 'No Content', json: async () => ({}), text: async () => '' };
      if (url.endsWith('/transcript')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 'tr-1', tokens: [{ text: 'привет', language: 'ru', start_ms: 0, end_ms: 400, speaker: 1 }] }) };
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 'tr-1', status, file_id: 'file-9', error_message: status === 'error' ? 'bad audio' : undefined }) };
    };
  }

  it('КЛЮЧЕВОЙ ТЕСТ: после успешного чтения результата удаляются транскрипт И файл — и только ПОСЛЕ чтения', async () => {
    const log: string[] = [];
    installFetch('completed', log);
    const parsed = await new SonioxSttProvider().fetchResult('key', 'tr-1');
    expect(parsed.segments.map((s) => s.text)).toEqual(['привет']);
    expect(log).toEqual([
      'GET /transcriptions/tr-1',
      'GET /transcriptions/tr-1/transcript',
      'DELETE /transcriptions/tr-1',
      'DELETE /files/file-9',
    ]);
  });

  it('задача ещё не готова — НИЧЕГО не удаляется: вебхук придёт снова', async () => {
    const log: string[] = [];
    installFetch('processing', log);
    await expect(new SonioxSttProvider().fetchResult('key', 'tr-1')).rejects.toThrow(/ещё не готова/);
    expect(log.filter((l) => l.startsWith('DELETE'))).toEqual([]);
  });

  it('задача провалена — убираем и файл, и задачу, ошибка всё равно пробрасывается', async () => {
    const log: string[] = [];
    installFetch('error', log);
    await expect(new SonioxSttProvider().fetchResult('key', 'tr-1')).rejects.toThrow(/bad audio/);
    expect(log.filter((l) => l.startsWith('DELETE'))).toEqual(['DELETE /transcriptions/tr-1', 'DELETE /files/file-9']);
  });

  it('отказ уборки не теряет результат пользователя', async () => {
    (global as never as { fetch: unknown }).fetch = async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'DELETE') throw new Error('network down');
      if (url.endsWith('/transcript')) return { ok: true, json: async () => ({ id: 'tr-1', tokens: [{ text: 'ок', language: 'ru' }] }) };
      return { ok: true, json: async () => ({ id: 'tr-1', status: 'completed', file_id: 'file-9' }) };
    };
    const parsed = await new SonioxSttProvider().fetchResult('key', 'tr-1');
    expect(parsed.segments[0].text).toBe('ок');
  });
});

describe('Soniox: имя и тип файла при загрузке (аудит 2026-09-02)', () => {
  it('MIME из запроса нормализуется и даёт расширение; мусор — без типа и расширения', () => {
    expect(normalizeAudioMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(normalizeAudioMime('Audio/MP4')).toBe('audio/mp4');
    expect(normalizeAudioMime('application/octet-stream')).toBeNull();
    expect(normalizeAudioMime(undefined)).toBeNull();
    expect(audioExtensionFor('audio/webm')).toBe('.webm');
    expect(audioExtensionFor('audio/mp4')).toBe('.m4a');
    expect(audioExtensionFor(null)).toBe('');
  });

  it('uploadAudio кладёт в multipart файл с типом и расширением', async () => {
    const originalFetch = (global as never as { fetch: unknown }).fetch;
    let sentForm: FormData | null = null;
    (global as never as { fetch: unknown }).fetch = async (_url: string, init: { body: FormData }) => {
      sentForm = init.body;
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 'file-1' }) };
    };
    try {
      const ref = await new SonioxSttProvider().uploadAudio('key', new Blob([new Uint8Array([1, 2, 3])]).stream(), 'audio/webm;codecs=opus');
      expect(ref).toBe('soniox-file:file-1');
      const file = sentForm!.get('file') as File;
      expect(file.name).toBe('audio.webm');
      expect(file.type).toBe('audio/webm');
    } finally {
      (global as never as { fetch: unknown }).fetch = originalFetch;
    }
  });
});

describe('SttService.discardOrphan (аудит 2026-09-02)', () => {
  function build(discardLog: string[], failing = false) {
    const make = (name: string, withDiscard: boolean) => ({
      name,
      lanes: ['sync', 'webhook', 'realtime'],
      ...(withDiscard
        ? {
            async discard(_key: string, id: string) {
              if (failing) throw new Error('сеть');
              discardLog.push(`${name}:${id}`);
            },
          }
        : {}),
    });
    const secrets = { resolve: async () => 'key' };
    return new SttService(secrets as never, make('soniox', true) as never, make('assemblyai', true) as never, make('elevenlabs', false) as never);
  }

  it('убирает задачу у провайдера, названного формой вебхука; без подсказки — ничего', async () => {
    const log: string[] = [];
    const svc = build(log);
    await svc.discardOrphan('soniox', 'tr-1');
    await svc.discardOrphan('assemblyai', 'a-1');
    await svc.discardOrphan(null, 'x');
    expect(log).toEqual(['soniox:tr-1', 'assemblyai:a-1']);
  });

  it('отказ уборки не бросает наружу — вебхук всё равно подтверждается', async () => {
    const svc = build([], true);
    await expect(svc.discardOrphan('soniox', 'tr-1')).resolves.toBeUndefined();
  });
});

describe('AssemblyAiSttProvider: удаление транскрипта после чтения (аудит 2026-09-02)', () => {
  it('fetchResult читает результат и затем DELETE; отказ DELETE не теряет результат', async () => {
    const calls: string[] = [];
    const transcription = {
      getTranscriptResult: async (_k: string, id: string) => { calls.push(`GET ${id}`); return { status: 'completed', id, utterances: [] }; },
      parseTranscriptResult: () => ({ language: 'en', segments: [{ diarizationLabel: 'A', text: 'hi', startMs: 0, endMs: 1, confidence: null }] }),
      deleteTranscript: async (_k: string, id: string) => { calls.push(`DELETE ${id}`); },
    };
    const parsed = await new AssemblyAiSttProvider(transcription as never).fetchResult('key', 'a-1');
    expect(parsed.segments[0].text).toBe('hi');
    expect(calls).toEqual(['GET a-1', 'DELETE a-1']);
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

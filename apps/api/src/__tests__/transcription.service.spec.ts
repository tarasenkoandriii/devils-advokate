// Пункт 32 (расширенный аудит тестов) — TranscriptionService не имела
// ВООБЩЕ никакого выделенного тестового файла. parseWebhookPayload()
// была косвенно покрыта через conversations.service.spec.ts (реальный
// экземпляр вызывался внутри FakeTranscriptionService), но submitJob()
// и streamUpload() — реальные fetch-вызовы к AssemblyAI — не
// исполнялись НИ РАЗУ ни в одном тесте: FakeTranscriptionService в
// conversations.service.spec.ts полностью подменяет оба метода
// заглушками, не делегируя в реальную реализацию (в отличие от
// parseWebhookPayload, которая делегирует). Найдено систематической
// сверкой .service.ts файлов без соответствующего .spec.ts.

import {
  TranscriptionService,
  TranscriptionProviderError,
  AssemblyAiTranscriptResult,
} from '../conversations/transcription.service';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

function assertThrows(fn: () => unknown, expectedType: any, message: string) {
  try {
    fn();
    throw new Error(`FAIL: ${message} — expected to throw ${expectedType.name}, did not throw`);
  } catch (err: any) {
    if (!(err instanceof expectedType)) {
      throw new Error(`FAIL: ${message} — expected ${expectedType.name}, got ${err?.constructor?.name}: ${err?.message}`);
    }
  }
}

async function assertThrowsAsync(fn: () => Promise<unknown>, expectedType: any, message: string) {
  try {
    await fn();
    throw new Error(`FAIL: ${message} — expected to throw ${expectedType.name}, did not throw`);
  } catch (err: any) {
    if (!(err instanceof expectedType)) {
      throw new Error(`FAIL: ${message} — expected ${expectedType.name}, got ${err?.constructor?.name}: ${err?.message}`);
    }
  }
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void> | void][] = [];
  const test = (name: string, fn: () => Promise<void> | void) => scenarios.push([name, fn]);

  // ── Финальный аудит 2026-08-30: реальный вебхук AssemblyAI несёт
  // ── только transcript_id/status — полный результат получается
  // ── отдельным GET /v2/transcript/{id}. parseTranscriptResult()
  // ── работает над этим результатом, не над телом вебхука.

  test('parseTranscriptResult() парсит успешный результат в сегменты', () => {
    const svc = new TranscriptionService({ resolve: async () => 'whsec-test' } as any);
    const result: AssemblyAiTranscriptResult = {
      status: 'completed',
      id: 'job-1',
      language_code: 'ru',
      utterances: [
        { speaker: 'A', text: 'Привет', start: 0, end: 1000, confidence: 0.95 },
        { speaker: 'B', text: 'Здравствуйте', start: 1000, end: 2500 },
      ],
    };
    const parsed = svc.parseTranscriptResult(result);
    assertEqual(parsed.language, 'ru', 'язык распознан');
    assertEqual(parsed.segments.length, 2, 'оба сегмента распознаны');
    assertEqual(parsed.segments[0].diarizationLabel, 'A', 'лейбл диаризации первого сегмента');
    assertEqual(parsed.segments[0].confidence, 0.95, 'confidence сохранён, если провайдер его дал');
    assertEqual(parsed.segments[1].confidence, null, 'confidence=null, если провайдер его НЕ дал (не выдумываем число)');
  });

  test('parseTranscriptResult() бросает TranscriptionProviderError при status=error', () => {
    const svc = new TranscriptionService({ resolve: async () => 'whsec-test' } as any);
    assertThrows(
      () => svc.parseTranscriptResult({ status: 'error', id: 'job-2', error: 'audio too short' }),
      TranscriptionProviderError,
      'parseTranscriptResult() при ошибке провайдера',
    );
  });

  test('parseTranscriptResult() возвращает пустой массив сегментов, если utterances отсутствует', () => {
    const svc = new TranscriptionService({ resolve: async () => 'whsec-test' } as any);
    const parsed = svc.parseTranscriptResult({ status: 'completed', id: 'job-3' });
    assertEqual(parsed.segments, [], 'пустой массив, не падение, если utterances нет вообще');
    assertEqual(parsed.language, null, 'язык null, если провайдер его не прислал');
  });

  // ── getTranscriptResult() — реальный fetch GET /v2/transcript/{id} ──

  test('РЕГРЕСІЯ (фінальний аудит 2026-08-30): getTranscriptResult() б’є в правильний URL і передає ключ без Bearer', async () => {
    const svc = new TranscriptionService({ resolve: async () => 'whsec-test' } as any);
    let capturedUrl: string | undefined;
    let capturedHeaders: any;
    (global as any).fetch = async (url: string, init: any) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      return { ok: true, json: async () => ({ status: 'completed', id: 'tr-123', language_code: 'en', utterances: [] }) };
    };

    const result = await svc.getTranscriptResult('test-api-key', 'tr-123');

    assertEqual(capturedUrl, 'https://api.assemblyai.com/v2/transcript/tr-123', 'правильний ендпоінт з transcript_id у шляху');
    assertEqual(capturedHeaders.Authorization, 'test-api-key', 'ключ без Bearer-префіксу (правило AssemblyAI для REST)');
    assertEqual(result.status, 'completed', 'результат розпарсено');
  });

  test('getTranscriptResult() бросает TranscriptionProviderError при не-ok ответе', async () => {
    const svc = new TranscriptionService({ resolve: async () => 'whsec-test' } as any);
    (global as any).fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => 'not found' });
    await assertThrowsAsync(() => svc.getTranscriptResult('k', 'missing'), TranscriptionProviderError, 'getTranscriptResult() при 404');
  });

  // ── submitJob() — реальный fetch, мокаем global.fetch ──

  test('submitJob() отправляет корректную форму запроса и возвращает externalJobId', async () => {
    const svc = new TranscriptionService({ resolve: async () => 'whsec-test' } as any);
    let capturedUrl: string | undefined;
    let capturedBody: any;
    let capturedHeaders: any;
    (global as any).fetch = async (url: string, init: any) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      capturedHeaders = init.headers;
      return { ok: true, json: async () => ({ id: 'ext-job-42' }) };
    };

    const result = await svc.submitJob('test-api-key', {
      audioUrl: 'https://cdn.example.com/audio.mp3',
      webhookUrl: 'https://api.example.com/webhook',
      languageCode: 'ru',
    });

    assertEqual(result.externalJobId, 'ext-job-42', 'externalJobId возвращён из ответа провайдера');
    assertEqual(capturedUrl, 'https://api.assemblyai.com/v2/transcript', 'запрос ушёл на правильный endpoint');
    assertEqual(capturedBody.audio_url, 'https://cdn.example.com/audio.mp3', 'audio_url передан');
    assertEqual(capturedBody.speech_models, ['universal-3-5-pro', 'universal-2'], 'фінальний аудит 2026-08-30: speech_models заданий явно (без цього AssemblyAI мовчки відкочується на застарілу universal-3-pro)');
    assertEqual(capturedBody.speaker_labels, true, 'диаризация запрошена явно (ради неё и выбран AssemblyAI)');
    assertEqual(capturedBody.redact_pii, false, 'redact_pii=false по умолчанию — не решаем за пользователя молча');
    assertEqual(capturedHeaders.Authorization, 'test-api-key', 'API-ключ передан в заголовке');
    assertEqual(capturedBody.webhook_auth_header_name, 'x-stt-webhook-secret', 'аудит 2026-08-30 + [stt-multi] 2026-09-02: заголовок секрета общий на двух провайдеров');
    assertEqual(capturedBody.webhook_auth_header_value, 'whsec-test', 'аудит 2026-08-30: секрет вебхука передан провайдеру');
  });

  test('РЕГРЕСІЯ (аудит 2026-08-30): без ASSEMBLYAI_WEBHOOK_SECRET submitJob() відмовляє (fail closed), запит до провайдера не йде', async () => {
    const svc = new TranscriptionService({ resolve: async () => null } as any);
    let fetched = false;
    (global as any).fetch = async () => { fetched = true; return { ok: true, json: async () => ({ id: 'x' }) }; };
    await assertThrowsAsync(() => svc.submitJob('k', { audioUrl: 'x', webhookUrl: 'y' }), TranscriptionProviderError, 'без секрету вебхука задачу відправляти не можна — результат ніколи не пройде guard');
    assertEqual(fetched, false, 'fetch не викликався');
  });

  test('submitJob() бросает TranscriptionProviderError при неуспешном ответе', async () => {
    const svc = new TranscriptionService({ resolve: async () => 'whsec-test' } as any);
    (global as any).fetch = async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => 'rate limit exceeded',
    });

    await assertThrowsAsync(
      () => svc.submitJob('test-api-key', { audioUrl: 'x', webhookUrl: 'y' }),
      TranscriptionProviderError,
      'submitJob() при ответе провайдера не-ok',
    );
  });

  // ── streamUpload() — реальный fetch, мокаем global.fetch ──

  test('streamUpload() возвращает upload_url из успешного ответа', async () => {
    const svc = new TranscriptionService({ resolve: async () => 'whsec-test' } as any);
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({ upload_url: 'https://cdn.assemblyai.com/upload/abc123' }),
    });

    const url = await svc.streamUpload('test-api-key', new ReadableStream());
    assertEqual(url, 'https://cdn.assemblyai.com/upload/abc123', 'upload_url возвращён как есть');
  });

  test('streamUpload() бросает TranscriptionProviderError при неуспешном ответе', async () => {
    const svc = new TranscriptionService({ resolve: async () => 'whsec-test' } as any);
    (global as any).fetch = async () => ({
      ok: false,
      status: 413,
      statusText: 'Payload Too Large',
      text: async () => 'file exceeds size limit',
    });

    await assertThrowsAsync(
      () => svc.streamUpload('test-api-key', new ReadableStream()),
      TranscriptionProviderError,
      'streamUpload() при ответе провайдера не-ok (например файл слишком большой)',
    );
  });

  // ── transcribeShortNoteSync() — Пункт [voice-note-ru] 2026-09-01 ──
  // Синхронная транскрипция голосовой заметки через async-путь
  // /v2/transcript (universal поддерживает ru/uk, которых НЕТ в
  // стриминге v3 — из-за чего русская речь выходила англо-ивритской
  // мешаниной). upload → submit БЕЗ вебхука → опрос до completed.

  test('transcribeShortNoteSync(): upload → submit с language_code → опрос до completed; вебхук НЕ передаётся', async () => {
    const svc = new TranscriptionService({ resolve: async () => 'whsec-test' } as any);
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test'; // нулевая пауза опроса
    const calls: { url: string; body?: any }[] = [];
    let polls = 0;
    let deletes = 0;
    (global as any).fetch = async (url: string, init: any) => {
      calls.push({ url, body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.endsWith('/v2/upload')) return { ok: true, json: async () => ({ upload_url: 'https://cdn.assemblyai.com/upload/note-1' }) };
      if (url.endsWith('/v2/transcript')) return { ok: true, json: async () => ({ id: 'tr-note-1' }) };
      // Аудит 2026-09-02 (продолжение): после результата — DELETE
      // транскрипта у провайдера; это не опрос.
      if (init?.method === 'DELETE') { deletes += 1; return { ok: true, status: 204 }; }
      polls += 1;
      return polls < 3
        ? { ok: true, json: async () => ({ status: 'processing', id: 'tr-note-1' }) }
        : { ok: true, json: async () => ({ status: 'completed', id: 'tr-note-1', text: 'привет, это заметка', language_code: 'ru' }) };
    };
    try {
      const res = await svc.transcribeShortNoteSync('test-api-key', Buffer.from('fake-audio'), 'ru');
      assertEqual(res, { text: 'привет, это заметка', language: 'ru' }, 'текст и язык из completed-результата');
      const submit = calls.find((c) => c.url.endsWith('/v2/transcript'))!;
      assertEqual(submit.body.language_code, 'ru', 'выбранный язык пробрасывается провайдеру как language_code');
      assertEqual(submit.body.language_detection, undefined, 'автоопределение выключено, когда язык задан явно');
      assertEqual(submit.body.speaker_labels, false, 'диаризация заметке не нужна — один говорящий, быстрее ответ');
      assertEqual(submit.body.speech_models, ['universal-3-5-pro', 'universal-2'], 'та же явная пара моделей, что в основном submitJob');
      assertEqual(submit.body.webhook_url, undefined, 'КЛЮЧЕВОЕ: без вебхука — результат забирается опросом, секрет вебхука не нужен');
      assertEqual(polls, 3, 'processing-статусы переживаются опросом до completed');
      assertEqual(deletes, 1, 'текст заметки удалён у провайдера сразу после получения (DELETE /v2/transcript/{id})');
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  test('transcribeShortNoteSync() без языка включает language_detection (режим «Автоопределение»)', async () => {
    const svc = new TranscriptionService({ resolve: async () => 'whsec-test' } as any);
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    let submitBody: any;
    (global as any).fetch = async (url: string, init: any) => {
      if (url.endsWith('/v2/upload')) return { ok: true, json: async () => ({ upload_url: 'https://cdn/u' }) };
      if (url.endsWith('/v2/transcript')) {
        submitBody = JSON.parse(init.body);
        return { ok: true, json: async () => ({ id: 'tr-2' }) };
      }
      return { ok: true, json: async () => ({ status: 'completed', id: 'tr-2', text: 'hello', language_code: 'en' }) };
    };
    try {
      const res = await svc.transcribeShortNoteSync('k', Buffer.from('a'));
      assertEqual(submitBody.language_detection, true, 'без выбранного языка — автоопределение');
      assertEqual(submitBody.language_code, undefined, 'language_code не передаётся при автоопределении');
      assertEqual(res.language, 'en', 'определённый провайдером язык возвращается вызвавшему');
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  test('transcribeShortNoteSync() бросает TranscriptionProviderError при status=error и при исчерпании опроса', async () => {
    const svc = new TranscriptionService({ resolve: async () => 'whsec-test' } as any);
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      (global as any).fetch = async (url: string) => {
        if (url.endsWith('/v2/upload')) return { ok: true, json: async () => ({ upload_url: 'https://cdn/u' }) };
        if (url.endsWith('/v2/transcript')) return { ok: true, json: async () => ({ id: 'tr-3' }) };
        return { ok: true, json: async () => ({ status: 'error', id: 'tr-3', error: 'audio too short' }) };
      };
      await assertThrowsAsync(
        () => svc.transcribeShortNoteSync('k', Buffer.from('a'), 'uk'),
        TranscriptionProviderError,
        'status=error от провайдера — честная ошибка, не пустой текст',
      );

      (global as any).fetch = async (url: string) => {
        if (url.endsWith('/v2/upload')) return { ok: true, json: async () => ({ upload_url: 'https://cdn/u' }) };
        if (url.endsWith('/v2/transcript')) return { ok: true, json: async () => ({ id: 'tr-4' }) };
        return { ok: true, json: async () => ({ status: 'processing', id: 'tr-4' }) };
      };
      await assertThrowsAsync(
        () => svc.transcribeShortNoteSync('k', Buffer.from('a'), 'ru'),
        TranscriptionProviderError,
        'вечный processing — ошибка по потолку опроса, не бесконечное ожидание',
      );
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  const failed = results.filter((r) => r.error);
  console.log(`\nTranscriptionService: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  // Падение вне тела теста (в фейке, в модульном коде) — это
  // провал файла, а не тихий unhandled rejection.
  console.error(err);
  process.exit(1);
});

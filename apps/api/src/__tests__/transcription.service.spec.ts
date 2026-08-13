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
  AssemblyAiWebhookPayload,
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

  // ── parseWebhookPayload() — чистая функция, без сети ──

  test('parseWebhookPayload() парсит успешный payload в сегменты', () => {
    const svc = new TranscriptionService();
    const payload: AssemblyAiWebhookPayload = {
      status: 'completed',
      id: 'job-1',
      language_code: 'ru',
      utterances: [
        { speaker: 'A', text: 'Привет', start: 0, end: 1000, confidence: 0.95 },
        { speaker: 'B', text: 'Здравствуйте', start: 1000, end: 2500 },
      ],
    };
    const parsed = svc.parseWebhookPayload(payload);
    assertEqual(parsed.language, 'ru', 'язык распознан');
    assertEqual(parsed.segments.length, 2, 'оба сегмента распознаны');
    assertEqual(parsed.segments[0].diarizationLabel, 'A', 'лейбл диаризации первого сегмента');
    assertEqual(parsed.segments[0].confidence, 0.95, 'confidence сохранён, если провайдер его дал');
    assertEqual(parsed.segments[1].confidence, null, 'confidence=null, если провайдер его НЕ дал (не выдумываем число)');
  });

  test('parseWebhookPayload() бросает TranscriptionProviderError при status=error', () => {
    const svc = new TranscriptionService();
    assertThrows(
      () => svc.parseWebhookPayload({ status: 'error', id: 'job-2', error: 'audio too short' }),
      TranscriptionProviderError,
      'parseWebhookPayload() при ошибке провайдера',
    );
  });

  test('parseWebhookPayload() возвращает пустой массив сегментов, если utterances отсутствует', () => {
    const svc = new TranscriptionService();
    const parsed = svc.parseWebhookPayload({ status: 'completed', id: 'job-3' });
    assertEqual(parsed.segments, [], 'пустой массив, не падение, если utterances нет вообще');
    assertEqual(parsed.language, null, 'язык null, если провайдер его не прислал');
  });

  // ── submitJob() — реальный fetch, мокаем global.fetch ──

  test('submitJob() отправляет корректную форму запроса и возвращает externalJobId', async () => {
    const svc = new TranscriptionService();
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
    assertEqual(capturedBody.speaker_labels, true, 'диаризация запрошена явно (ради неё и выбран AssemblyAI)');
    assertEqual(capturedBody.redact_pii, false, 'redact_pii=false по умолчанию — не решаем за пользователя молча');
    assertEqual(capturedHeaders.Authorization, 'test-api-key', 'API-ключ передан в заголовке');
  });

  test('submitJob() бросает TranscriptionProviderError при неуспешном ответе', async () => {
    const svc = new TranscriptionService();
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
    const svc = new TranscriptionService();
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({ upload_url: 'https://cdn.assemblyai.com/upload/abc123' }),
    });

    const url = await svc.streamUpload('test-api-key', new ReadableStream());
    assertEqual(url, 'https://cdn.assemblyai.com/upload/abc123', 'upload_url возвращён как есть');
  });

  test('streamUpload() бросает TranscriptionProviderError при неуспешном ответе', async () => {
    const svc = new TranscriptionService();
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

run();

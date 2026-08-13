// Пункт 33 (дозакрытие мелких пробелов) — features.ts содержит ~65
// функций-обёрток над api.ts (apiGet/apiPost/... уже покрыты в
// api.spec.ts), подавляющее большинство — однострочная конструкция
// URL с делегацией. Писать отдельный тест на каждую из 65 было бы
// низкоценным дублированием (все построены на уже протестированном
// фундаменте). Здесь — выборочная проверка (по одному представителю
// на GET/POST с телом/URL-параметр) плюс ПОЛНОЕ покрытие единственной
// функции с нетривиальной логикой: uploadConversationAudio() не
// использует apiGet/Post/... обёртки вообще (стриминг File-объекта
// напрямую, не JSON) — собственная сборка заголовков через
// динамический await import('./telegram'), единственное такое место
// в файле. Пункт 34: РАЗБОР ответа теперь переиспользует handle() из
// api.ts (экспортирован именно ради этого) — раньше была урезанная
// копия той же логики, теперь одна функция на всё.

process.env.NEXT_PUBLIC_DEV_USER_ID = 'test-user-1';

import { listPeople, createCommitment, uploadConversationAudio } from '../lib/features';
import { ApiRequestError } from '../lib/api';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

function mockFetchOnce(status: number, jsonBody: unknown) {
  let captured: { url: string; init: any } | null = null;
  (global as any).fetch = async (url: string, init: any) => {
    captured = { url, init };
    return { status, json: async () => jsonBody };
  };
  return () => captured;
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('listPeople() подставляет projectId в URL и делает GET', async () => {
    const getCaptured = mockFetchOnce(200, { success: true, data: [{ personId: 'p1' }] });
    const result = await listPeople('proj-42');
    assertEqual(result, [{ personId: 'p1' }], 'данные развёрнуты из конверта');
    assertEqual(getCaptured()!.url.endsWith('/projects/proj-42/people'), true, 'projectId корректно подставлен в путь');
    assertEqual(getCaptured()!.init.method, 'GET', 'метод GET');
  });

  test('createCommitment() отправляет POST с телом, включающим все переданные поля', async () => {
    const getCaptured = mockFetchOnce(200, { success: true, data: { id: 'c1' } });
    await createCommitment('proj-1', { personId: 'person-1', owner: 'FIGURANT', description: 'Пришлёт документы', dueDate: '2026-03-15' });
    const captured = getCaptured()!;
    assertEqual(captured.init.method, 'POST', 'метод POST');
    assertEqual(
      JSON.parse(captured.init.body),
      { personId: 'person-1', owner: 'FIGURANT', description: 'Пришлёт документы', dueDate: '2026-03-15' },
      'тело содержит все переданные поля как есть',
    );
    assertEqual(captured.url.endsWith('/projects/proj-1/commitments'), true, 'путь собран из projectId');
  });

  // ── uploadConversationAudio() — не использует api.ts-обёртки вообще ──

  test('uploadConversationAudio() отправляет файл напрямую как body, с Content-Type из file.type', async () => {
    const getCaptured = mockFetchOnce(200, { success: true, data: { audioUrl: 'https://cdn.example.com/a.mp3' } });
    const file = new File(['fake audio bytes'], 'recording.mp3', { type: 'audio/mpeg' });

    const result = await uploadConversationAudio('conv-1', file);
    assertEqual(result, { audioUrl: 'https://cdn.example.com/a.mp3' }, 'audioUrl возвращён из ответа');
    const captured = getCaptured()!;
    assertEqual(captured.init.headers['Content-Type'], 'audio/mpeg', 'Content-Type взят из file.type, не захардкожен');
    assertEqual(captured.init.body, file, 'файл передан как body напрямую, не обёрнут в JSON (стриминг, не JSON-запрос)');
    assertEqual(captured.url.endsWith('/conversations/conv-1/upload'), true, 'conversationId подставлен в путь');
  });

  test('uploadConversationAudio() подставляет application/octet-stream, если у файла нет type', async () => {
    mockFetchOnce(200, { success: true, data: { audioUrl: 'x' } });
    const getCaptured = mockFetchOnce(200, { success: true, data: { audioUrl: 'x' } });
    const file = new File(['bytes'], 'recording'); // без указания type — file.type будет пустой строкой

    await uploadConversationAudio('conv-1', file);
    assertEqual(
      getCaptured()!.init.headers['Content-Type'],
      'application/octet-stream',
      'запасной Content-Type для файла без определённого MIME-типа',
    );
  });

  // Пункт 34 (реальное исправление находки из Пункта 33) —
  // uploadConversationAudio() теперь переиспользует handle() из api.ts,
  // как и все остальные функции файла: бросает ApiRequestError с
  // реальным httpStatus, не обычный Error. Асимметрия устранена, не
  // просто задокументирована — тест проверяет ИСПРАВЛЕННОЕ поведение.
  test('uploadConversationAudio() при success:false бросает ApiRequestError (асимметрия с остальными функциями устранена)', async () => {
    mockFetchOnce(413, { success: false, error: { message: 'Файл слишком большой' } });
    const file = new File(['bytes'], 'huge.mp3', { type: 'audio/mpeg' });

    try {
      await uploadConversationAudio('conv-1', file);
      throw new Error('FAIL: ожидалось исключение, не брошено');
    } catch (err: any) {
      if (!(err instanceof ApiRequestError)) {
        throw new Error(`FAIL: ожидался ApiRequestError (та же обработка ошибок, что у остальных функций), получен ${err.constructor.name}`);
      }
      assertEqual(err.message, 'Файл слишком большой', 'сообщение сервера дошло до вызывающего кода');
      assertEqual(err.httpStatus, 413, 'httpStatus взят из реального response.status, как у всех остальных функций');
    }
  });

  test('uploadConversationAudio() бросает ApiRequestError при некорректном JSON от сервера (устойчивость, которой раньше не было вообще)', async () => {
    // До исправления эта функция сама делала await response.json() без
    // try/catch — некорректный JSON приводил бы к необработанному
    // отклонению промиса (SyntaxError напрямую наружу), не к понятной
    // ошибке. handle() уже умеет это перехватывать — теперь умеет и
    // uploadConversationAudio(), просто за счёт переиспользования.
    (global as any).fetch = async () => ({
      status: 500,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    });
    const file = new File(['bytes'], 'x.mp3', { type: 'audio/mpeg' });

    try {
      await uploadConversationAudio('conv-1', file);
      throw new Error('FAIL: ожидалось исключение, не брошено');
    } catch (err: any) {
      if (!(err instanceof ApiRequestError)) {
        throw new Error(`FAIL: ожидался ApiRequestError, получен ${err.constructor.name}: ${err.message}`);
      }
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
  console.log(`\nfeatures.ts: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

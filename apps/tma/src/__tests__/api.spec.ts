// Пункт 33 (дозакрытие мелких пробелов) — TMA-фронтенд не имел
// ВООБЩЕ никакой тестовой инфраструктуры за всю сессию. Полноценные
// React-компонентные тесты (рендер, взаимодействие пользователя)
// требуют @testing-library/react + jsdom — недоступны без npm install
// (сеть отключена в этой среде разработки, та же причина, что уже не
// раз честно зафиксирована для реальных интеграционных прогонов на
// backend). НО вся реальная ЛОГИКА фронтенда — не в JSX-рендере, а в
// lib/api.ts + lib/features.ts (URL/метод/тело запроса, разбор
// конверта ответа) — это чистые функции, не требующие DOM вообще,
// тестируются той же техникой (Node + мок global.fetch), что уже
// применялась для backend-сервисов весь этот проект.
//
// api.ts — ФУНДАМЕНТ: все ~65 функций features.ts построены поверх
// пяти обёрток apiGet/apiPost/apiPut/apiPatch/apiDelete. Если эти пять
// корректны, вся API-логика фронтенда наследует эту корректность —
// приоритет здесь выше, чем тестировать каждую из 65 функций отдельно
// (которые в подавляющем большинстве — однострочная конструкция URL).

process.env.NEXT_PUBLIC_DEV_USER_ID = 'test-user-1'; // getAuthHeaders() иначе бросает — нет window в Node, нет реального Telegram WebApp

import { apiGet, apiPost, apiPut, apiPatch, apiDelete, ApiRequestError } from '../lib/api';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
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

function mockFetchOnce(status: number, jsonBody: unknown) {
  let captured: { url: string; init: any } | null = null;
  (global as any).fetch = async (url: string, init: any) => {
    captured = { url, init };
    return {
      status,
      json: async () => jsonBody,
    };
  };
  return () => captured;
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('apiGet() отправляет GET без тела и разворачивает success:true в data', async () => {
    const getCaptured = mockFetchOnce(200, { success: true, data: { hello: 'world' } });
    const result = await apiGet<{ hello: string }>('/projects/1');
    assertEqual(result, { hello: 'world' }, 'data развёрнута из конверта');
    const captured = getCaptured()!;
    assertEqual(captured.init.method, 'GET', 'метод GET');
    assertEqual(captured.init.body, undefined, 'GET не отправляет тело');
    assertEqual(captured.url.endsWith('/projects/1'), true, 'путь передан как есть в URL');
  });

  test('apiPost() отправляет POST с JSON-сериализованным телом', async () => {
    const getCaptured = mockFetchOnce(200, { success: true, data: { id: 'new-1' } });
    await apiPost('/projects', { question: 'Стоит ли просить о повышении?' });
    const captured = getCaptured()!;
    assertEqual(captured.init.method, 'POST', 'метод POST');
    assertEqual(captured.init.body, JSON.stringify({ question: 'Стоит ли просить о повышении?' }), 'тело сериализовано в JSON');
  });

  test('apiPost() без аргумента body отправляет undefined, не "undefined"-строку', async () => {
    const getCaptured = mockFetchOnce(200, { success: true, data: {} });
    await apiPost('/projects/1/agenda/generate');
    const captured = getCaptured()!;
    assertEqual(captured.init.body, undefined, 'body действительно undefined, не JSON.stringify(undefined)="undefined" строкой');
  });

  test('apiPut()/apiPatch()/apiDelete() используют правильные HTTP-методы', async () => {
    const getCapturedPut = mockFetchOnce(200, { success: true, data: {} });
    await apiPut('/projects/1/objective', { desiredOutcome: 'x' });
    assertEqual(getCapturedPut()!.init.method, 'PUT', 'apiPut() → PUT');

    const getCapturedPatch = mockFetchOnce(200, { success: true, data: {} });
    await apiPatch('/commitments/1', { status: 'COMPLETED' });
    assertEqual(getCapturedPatch()!.init.method, 'PATCH', 'apiPatch() → PATCH');

    const getCapturedDelete = mockFetchOnce(200, { success: true, data: {} });
    await apiDelete('/protected-notes/1');
    assertEqual(getCapturedDelete()!.init.method, 'DELETE', 'apiDelete() → DELETE');
  });

  test('запрос всегда отправляет Content-Type: application/json и заголовок авторизации', async () => {
    const getCaptured = mockFetchOnce(200, { success: true, data: {} });
    await apiGet('/bootstrap');
    const headers = getCaptured()!.init.headers;
    assertEqual(headers['Content-Type'], 'application/json', 'Content-Type всегда JSON');
    assertEqual(headers['X-Dev-User-Id'], 'test-user-1', 'dev-заголовок авторизации подставлен (нет реального Telegram WebApp в тестовой среде)');
  });

  test('при success:false бросает ApiRequestError с сообщением сервера, не проглатывает молча', async () => {
    mockFetchOnce(404, { success: false, error: { message: 'Project not found' } });
    await assertThrowsAsync(
      () => apiGet('/projects/does-not-exist'),
      ApiRequestError,
      'apiGet() при success:false',
    );
  });

  test('ApiRequestError сохраняет httpStatus из реального HTTP-ответа', async () => {
    mockFetchOnce(403, { success: false, error: { message: 'Forbidden' } });
    try {
      await apiGet('/projects/1');
      throw new Error('FAIL: ожидалось исключение, не брошено');
    } catch (err) {
      if (!(err instanceof ApiRequestError)) throw err;
      assertEqual(err.httpStatus, 403, 'httpStatus взят из реального response.status, не выдуман');
      // Пункт [error-language] 2026-09-04: раньше здесь проверялось, что
      // текст сервера доходит до человека дословно. Именно это и было
      // дефектом: сообщение без кириллицы написано для разработчика, а
      // экран показывает `err.message` как есть. Теперь человеку —
      // человеческая фраза, а исходный текст сохраняется рядом.
      assertEqual(err.technicalMessage, 'Forbidden', 'исходный текст сервера не потерян');
      assertEqual(err.message, 'Это действие вам недоступно.', 'человеку — фраза на его языке');
    }
  });

  test('КЛЮЧЕВОЙ ТЕСТ [error-language]: русское сообщение сервера доходит ДОСЛОВНО', async () => {
    // Обратная половина правила и более важная: сообщений, написанных
    // для человека, в продукте большинство, и они осмысленны. Подменять
    // их общей фразой было бы хуже исходного дефекта — человек потерял
    // бы единственное объяснение, что именно не так.
    const exact = 'Спарринг уже завершён — писать в него больше нельзя';
    mockFetchOnce(400, { success: false, error: { message: exact } });
    try {
      await apiGet('/projects/1');
      throw new Error('FAIL: ожидалось исключение, не брошено');
    } catch (err) {
      if (!(err instanceof ApiRequestError)) throw err;
      assertEqual(err.message, exact, 'осмысленное русское сообщение не заменено общей фразой');
    }
  });

  test('КЛЮЧЕВОЙ ТЕСТ [error-language]: инженерная строка с внутренним идентификатором не доходит до человека', async () => {
    // Ровно то, что человек видел на экране: имя модели и cuid.
    mockFetchOnce(404, {
      success: false,
      error: { message: 'DtpParticipant cmf3x9q0000abcdefghijklm not found' },
    });
    try {
      await apiGet('/projects/1');
      throw new Error('FAIL: ожидалось исключение, не брошено');
    } catch (err) {
      if (!(err instanceof ApiRequestError)) throw err;
      assertEqual(err.message.includes('cmf3x9q'), false, 'внутренний идентификатор не показан человеку');
      assertEqual(err.message.includes('DtpParticipant'), false, 'имя модели не показано человеку');
      assertEqual(
        err.technicalMessage,
        'DtpParticipant cmf3x9q0000abcdefghijklm not found',
        'для диагностики исходный текст сохранён',
      );
    }
  });

  test('[error-language]: незнакомый статус — общая фраза по-русски, а не пустая строка', async () => {
    mockFetchOnce(418, { success: false, error: { message: 'I am a teapot' } });
    try {
      await apiGet('/projects/1');
      throw new Error('FAIL: ожидалось исключение, не брошено');
    } catch (err) {
      if (!(err instanceof ApiRequestError)) throw err;
      assertEqual(/[А-Яа-я]/.test(err.message), true, 'человеку сказано что-то по-русски');
    }
  });

  test('бросает ApiRequestError, если сервер вернул некорректный JSON (не глотает молча)', async () => {
    (global as any).fetch = async () => ({
      status: 500,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    });
    await assertThrowsAsync(
      () => apiGet('/anything'),
      ApiRequestError,
      'apiGet() при некорректном JSON от сервера (например HTML страница ошибки вместо API-ответа)',
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
  console.log(`\napi.ts: ${results.length - failed.length}/${results.length} passed\n`);
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

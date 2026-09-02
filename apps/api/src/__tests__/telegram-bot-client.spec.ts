import { sendTelegramMessage, TelegramSendError } from '../common/telegram-bot-client';

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

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void> | void][] = [];
  const test = (name: string, fn: () => Promise<void> | void) => scenarios.push([name, fn]);

  test('sendTelegramMessage() отправляет POST на правильный URL с токеном в пути', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    (global as any).fetch = async (url: string, init: any) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    };
    await sendTelegramMessage('123:ABC-token', '456789', 'Не забудьте про разговор через час');
    assertEqual(capturedUrl, 'https://api.telegram.org/bot123:ABC-token/sendMessage', 'URL с токеном в пути корректный');
    assertEqual(capturedBody.chat_id, '456789', 'chat_id передан');
    assertEqual(capturedBody.text, 'Не забудьте про разговор через час', 'текст передан');
  });

  test('sendTelegramMessage() бросает TelegramSendError при не-ok HTTP-ответе', async () => {
    (global as any).fetch = async () => ({ ok: false, status: 403, statusText: 'Forbidden', text: async () => 'bot was blocked by the user' });
    await assertThrowsAsync(() => sendTelegramMessage('token', 'chat-1', 'x'), TelegramSendError, 'sendTelegramMessage() при 403');
  });

  test('sendTelegramMessage() бросает TelegramSendError, если Telegram вернул ok:false в теле (200, но логическая ошибка)', async () => {
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ ok: false, description: 'chat not found' }) });
    await assertThrowsAsync(() => sendTelegramMessage('token', 'chat-1', 'x'), TelegramSendError, 'sendTelegramMessage() при ok:false в теле');
  });

  test('sendTelegramMessage() бросает TelegramSendError при сетевой ошибке', async () => {
    (global as any).fetch = async () => { throw new Error('network down'); };
    await assertThrowsAsync(() => sendTelegramMessage('token', 'chat-1', 'x'), TelegramSendError, 'sendTelegramMessage() при сетевой ошибке');
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
  console.log(`\ntelegram-bot-client: ${results.length - failed.length}/${results.length} passed\n`);
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

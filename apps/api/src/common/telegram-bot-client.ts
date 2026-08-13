// Пункт 50: telegram-bot-client.ts — минимальный клиент для исходящих
// сообщений через Telegram Bot API (§3.20 ТЗ, push-напоминания), сырой
// fetch() без SDK-пакета, тот же принцип, что vercel-blob.ts/
// serpapi-client.ts/nominatim-client.ts.
//
// СЕКРЕТ УЖЕ СУЩЕСТВУЕТ, НОВЫЙ НЕ НУЖЕН — TELEGRAM_BOT_TOKEN уже
// используется для проверки X-Telegram-Init-Data (см.
// telegram-auth.guard.ts) — та же переменная резолвится тем же
// способом (через ConfigService там, через SecretsService здесь для
// консистентности с остальными внешними вызовами этого прохода —
// см. обоснование выбора в telegram-scheduler.service.ts).
//
// ЧЕСТНО: контракт sendMessage — стандартный, широко задокументированный
// Telegram Bot API (POST /bot<token>/sendMessage, {chat_id, text}),
// не проверен вызовом против реального бота в этой среде — та же
// оговорка, что у остальных внешних интеграций проекта.

const TELEGRAM_API_HOST = 'https://api.telegram.org';

export class TelegramSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramSendError';
  }
}

export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
  const url = `${TELEGRAM_API_HOST}/bot${botToken}/sendMessage`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    throw new TelegramSendError(`Не удалось связаться с Telegram Bot API: ${err instanceof Error ? err.message : 'неизвестная ошибка сети'}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new TelegramSendError(`Telegram Bot API вернул ${response.status} ${response.statusText}: ${body}`);
  }

  const data = await response.json();
  if (data.ok !== true) {
    throw new TelegramSendError(`Telegram Bot API: ${data.description ?? 'неизвестная ошибка'}`);
  }
}

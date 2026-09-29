// Пункт [job-domain-v2] К-20 — разбор входящего update Telegram.
//
// ЧИСТАЯ ФУНКЦИЯ, ОТДЕЛЬНЫМ ФАЙЛОМ, потому что здесь проходит граница
// приватности, а границу лучше проверять тестом без сети и без базы.
//
// ЧТО МЫ БЕРЁМ ИЗ ПЕРЕСЛАННОГО СООБЩЕНИЯ: только `text` и id того, КОМУ
// принадлежит бот-чат (наш пользователь). Всё остальное отбрасывается здесь,
// на входе, а не «не сохраняется дальше по коду»:
//   • `forward_origin` / `forward_from` / `forward_sender_name` — кто автор
//     исходного сообщения. Это третье лицо, которое не давало нам согласия
//     ни на что; ТЗ §11.43 требует, чтобы этого поля не было в системе,
//     и здесь оно даже не доезжает до сервиса;
//   • `caption` у медиа, сами медиа, контакты, геометки — не наш случай:
//     вакансия — это текст.
//
// ПОЧЕМУ ОБЫЧНОЕ СООБЩЕНИЕ НЕ СТАНОВИТСЯ ВАКАНСИЕЙ. Пользователь пишет боту
// и вопросы, и заметки. Молча превратить «привет, а как это работает?» в
// вакансию — тот же класс ошибки, что «AI решил за вас»: продукт делает
// вывод, которого человек не делал. Пересылка — явное действие, вставленный
// текст — тоже (для него есть экран), а просто написанное в чат — нет.

/** Что мы умеем обрабатывать. Всё прочее — `ignored` с причиной: причина
 *  нужна не пользователю, а логу и тесту. */
export type ParsedUpdate =
  | { kind: 'forwarded'; telegramId: string; chatId: string; text: string }
  | { kind: 'start'; telegramId: string; chatId: string; payload: string | null }
  | { kind: 'plain_text'; telegramId: string; chatId: string; length: number }
  | { kind: 'ignored'; reason: string };

/** Минимальная форма update — описываем только то, что читаем сами. */
interface TelegramMessage {
  chat?: { id?: number | string; type?: string };
  from?: { id?: number | string; is_bot?: boolean };
  text?: string;
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  forward_sender_name?: unknown;
  forward_date?: unknown;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

/** Признак пересылки — любой из полей, которыми Telegram помечает форвард
 * (Bot API 7.0 заменил `forward_from*` на `forward_origin`, но старые клиенты
 * и тестовые фикстуры присылают прежние поля). Значения не читаются: нам
 * важен только факт «это переслано», а не кем. */
function isForwarded(message: TelegramMessage): boolean {
  return (
    message.forward_origin !== undefined ||
    message.forward_from !== undefined ||
    message.forward_from_chat !== undefined ||
    message.forward_sender_name !== undefined ||
    message.forward_date !== undefined
  );
}

export const MIN_FORWARD_TEXT_CHARS = 40;

export function parseUpdate(update: TelegramUpdate | null | undefined): ParsedUpdate {
  const message = update?.message ?? update?.edited_message;
  if (!message) return { kind: 'ignored', reason: 'update без сообщения' };
  if (message.from?.is_bot) return { kind: 'ignored', reason: 'сообщение от бота' };

  const telegramId = message.from?.id !== undefined ? String(message.from.id) : null;
  const chatId = message.chat?.id !== undefined ? String(message.chat.id) : null;
  if (!telegramId || !chatId) return { kind: 'ignored', reason: 'нет отправителя или чата' };
  // Групповые чаты не обслуживаем: проект пользователя — личный, и писать в
  // группу «сохранено в ваш проект» значило бы раскрывать её участникам, чем
  // человек занят.
  if (message.chat?.type && message.chat.type !== 'private') return { kind: 'ignored', reason: 'не личный чат' };

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text) return { kind: 'ignored', reason: 'сообщение без текста' };

  if (text.startsWith('/start')) {
    const payload = text.slice('/start'.length).trim();
    return { kind: 'start', telegramId, chatId, payload: payload.length > 0 ? payload.slice(0, 64) : null };
  }

  if (isForwarded(message)) {
    return { kind: 'forwarded', telegramId, chatId, text };
  }

  return { kind: 'plain_text', telegramId, chatId, length: text.length };
}

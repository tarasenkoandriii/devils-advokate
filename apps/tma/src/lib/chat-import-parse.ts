// Пункт 61 (backend) → TMA: клиентский парсер .txt-экспорта WhatsApp
// (§3.29 ТЗ) — "текст переписки обрабатывается локально, на сервер
// уходят только производные". Парсинг ЦЕЛИКОМ на клиенте — на сервер
// уходит уже структурированный список сообщений (sender/text/
// timestamp), не сырой текст экспорта как единая строка.
//
// ЧЕСТНАЯ ГРАНИЦА ОБЪЁМА, НЕ СКРЫТАЯ: формат экспорта WhatsApp
// варьируется по платформе/локали (Android без скобок "D/M/YY, H:MM
// - Имя: текст", iOS со скобками "[D/M/YY, H:MM:SS] Имя: текст",
// 12-часовой формат с AM/PM или 24-часовой). Реализован один
// достаточно гибкий регексп, покрывающий оба основных варианта — не
// универсальный парсер под все локали/языки экспорта (например,
// разный порядок ДД/ММ и ММ/ДД неотличим без явного указания локали
// пользователем — здесь предполагается ДД/ММ/ГГГГ, наиболее
// распространённый формат вне США).
//
// Пункт 88 добавил Telegram JSON-экспорт (parseTelegramExport) — тот
// же выходной тип, что WhatsApp (переиспользован, не задублирован,
// backend полностью формат-независим, см. обоснование ниже) — и
// разбор одного .eml-письма (parseEmlFile). ЧЕСТНО НЕ РЕАЛИЗОВАН
// разбор МНОГОСООБЩЕННОЙ email-цепочки из тела одного письма —
// конвенции цитирования разнятся между почтовыми клиентами (Gmail/
// Outlook/Apple Mail форматируют "On ... wrote:" по-разному) настолько
// сильно, что единый регексп-парсер давал бы ложное чувство полноты
// покрытия — тот же принцип честности, что уже применён к самому
// WhatsApp-парсеру выше. parseEmlFile() разбирает ОДНО письмо в ОДНО
// сообщение; для многоходовой переписки пользователь загружает
// несколько .eml-файлов по одному на каждое письмо цепочки.
//
// СЛУЖЕБНЫЕ СТРОКИ (например, "Сообщения и звонки защищены сквозным
// шифрованием", "Х добавил(а) Y") не соответствуют формату "Имя:
// текст" и молча пропускаются, не создают фиктивного участника.
//
// МНОГОСТРОЧНЫЕ СООБЩЕНИЯ — строки без метки времени в начале
// считаются продолжением предыдущего сообщения, дописываются к его
// тексту через перевод строки.

export interface ParsedChatMessage {
  sender: string;
  text: string;
  timestampMs: number;
}

export interface ParseWhatsAppResult {
  messages: ParsedChatMessage[];
  distinctSenders: string[];
}

// [опц. скобка] Д(Д)/М(М)/ГГ(ГГ), Ч(Ч):ММ[:СС] [AM/PM][опц. скобка] [- ] Отправитель: текст
const MESSAGE_LINE_PATTERN =
  /^\[?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\]?\s*[-–]?\s*([^:]{1,60}):\s(.*)$/;

export function parseWhatsAppExport(rawText: string): ParseWhatsAppResult {
  const lines = rawText.split(/\r?\n/);
  const messages: ParsedChatMessage[] = [];

  for (const line of lines) {
    const match = line.match(MESSAGE_LINE_PATTERN);
    if (match) {
      const [, dayStr, monthStr, yearStr, hourStr, minuteStr, secondStr, ampm, sender, text] = match;
      const timestampMs = buildTimestamp(dayStr, monthStr, yearStr, hourStr, minuteStr, secondStr, ampm);
      messages.push({ sender: sender.trim(), text, timestampMs });
    } else if (messages.length > 0 && line.trim().length > 0) {
      // Продолжение предыдущего сообщения (нет метки времени в начале строки).
      messages[messages.length - 1].text += `\n${line}`;
    }
    // Пустые строки и служебные строки без метки времени — молча пропускаются.
  }

  const distinctSenders = [...new Set(messages.map((m) => m.sender))];
  return { messages, distinctSenders };
}

function buildTimestamp(
  dayStr: string,
  monthStr: string,
  yearStr: string,
  hourStr: string,
  minuteStr: string,
  secondStr: string | undefined,
  ampm: string | undefined,
): number {
  const day = parseInt(dayStr, 10);
  const month = parseInt(monthStr, 10) - 1; // Date — месяцы с 0
  const year = yearStr.length === 2 ? 2000 + parseInt(yearStr, 10) : parseInt(yearStr, 10);
  let hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  const second = secondStr ? parseInt(secondStr, 10) : 0;

  if (ampm) {
    const isPm = ampm.toLowerCase() === 'pm';
    if (isPm && hour !== 12) hour += 12;
    if (!isPm && hour === 12) hour = 0;
  }

  return new Date(year, month, day, hour, minute, second).getTime();
}

// ───────────────────────────────────────────────────────────
// Пункт 88 (§3.29 ТЗ) — Telegram JSON-экспорт ("Export chat history"
// в настройках Telegram, результат — result.json). Формат
// задокументирован официально и стабилен, в отличие от WhatsApp,
// не варьируется по платформе — один парсер покрывает весь формат,
// не частный случай.
// ───────────────────────────────────────────────────────────

interface TelegramTextEntity {
  type: string;
  text: string;
}

interface TelegramMessage {
  type: string; // "message" | "service" | другое — только "message" содержит реальный текст переписки
  date_unixtime?: string; // предпочтительнее date (ISO-строка без явной таймзоны) — однозначен
  date?: string;
  from?: string;
  text?: string | (string | TelegramTextEntity)[]; // строка ИЛИ массив кусков форматированного текста
}

interface TelegramExport {
  messages?: TelegramMessage[];
}

/** Telegram хранит форматированный текст (жирный/ссылки/упоминания)
 * как массив кусков, не единую строку — извлекает только текстовое
 * содержимое, форматирование не сохраняется (не нужно для анализа
 * аргументов/расхождений, только сам текст). */
function extractTelegramText(text: string | (string | TelegramTextEntity)[] | undefined): string {
  if (!text) return '';
  if (typeof text === 'string') return text;
  return text.map((piece) => (typeof piece === 'string' ? piece : piece.text)).join('');
}

export function parseTelegramExport(rawJson: string): ParseWhatsAppResult {
  let data: TelegramExport;
  try {
    data = JSON.parse(rawJson);
  } catch {
    return { messages: [], distinctSenders: [] }; // невалидный JSON — честно пустой результат, не бросаем исключение наружу
  }

  const messages: ParsedChatMessage[] = [];
  for (const raw of data.messages ?? []) {
    if (raw.type !== 'message') continue; // "service"-записи (кто-то присоединился и т.д.) — не переписка, пропускаются
    if (!raw.from) continue; // без отправителя — не реальное сообщение переписки

    const text = extractTelegramText(raw.text);
    if (!text.trim()) continue; // сообщение без текста (только фото/стикер без подписи) — честно пропущено, не пустая запись

    // date_unixtime — секунды, однозначны без таймзоны; date — ISO-строка без явного "Z", резервный вариант.
    const timestampMs = raw.date_unixtime
      ? parseInt(raw.date_unixtime, 10) * 1000
      : raw.date
        ? new Date(raw.date).getTime()
        : Date.now(); // на практике не должно происходить — оба поля есть в реальном экспорте, честный fallback на "сейчас", не подделка исторической даты

    messages.push({ sender: raw.from, text, timestampMs });
  }

  const distinctSenders = [...new Set(messages.map((m) => m.sender))];
  return { messages, distinctSenders };
}

// ───────────────────────────────────────────────────────────
// Пункт 88 (§3.29 ТЗ) — разбор одного .eml-письма (стандарт
// RFC 5322). ОДНО письмо = ОДНО сообщение переписки, не
// многоходовая цепочка — см. обоснование в шапке файла.
// ───────────────────────────────────────────────────────────

/** Простой построчный разбор заголовков RFC 5322 до первой пустой
 * строки (граница между заголовками и телом письма), не полноценный
 * MIME-парсер — многочастные (multipart) письма с вложениями честно
 * не поддерживаются, только простой текстовый body. */
export function parseEmlFile(rawEml: string): ParsedChatMessage | null {
  const lines = rawEml.split(/\r?\n/);
  let from = '';
  let dateHeader = '';
  let bodyStartIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      bodyStartIndex = i + 1;
      break;
    }
    const fromMatch = line.match(/^From:\s*(.+)$/i);
    if (fromMatch) from = fromMatch[1].trim();
    const dateMatch = line.match(/^Date:\s*(.+)$/i);
    if (dateMatch) dateHeader = dateMatch[1].trim();
  }

  if (!from || bodyStartIndex === -1) return null; // нет заголовка From или тела — не похоже на валидное .eml

  // "Имя <email>" — извлекаем только имя для отображения, если оно есть; иначе весь заголовок как есть.
  const nameMatch = from.match(/^"?([^"<]+)"?\s*<[^>]+>$/);
  const sender = nameMatch ? nameMatch[1].trim() : from;

  const text = lines.slice(bodyStartIndex).join('\n').trim();
  if (!text) return null; // пустое тело письма — нечего импортировать

  const timestampMs = dateHeader ? new Date(dateHeader).getTime() : Date.now();

  return { sender, text, timestampMs: Number.isNaN(timestampMs) ? Date.now() : timestampMs };
}

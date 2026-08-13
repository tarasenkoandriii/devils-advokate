import { parseWhatsAppExport, parseTelegramExport, parseEmlFile } from '../lib/chat-import-parse';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => void][] = [];
  const test = (name: string, fn: () => void) => scenarios.push([name, fn]);

  test('parseWhatsAppExport() разбирает Android-формат (без скобок, "- ")', () => {
    const raw = [
      '15/03/24, 14:05 - Иван: Привет, как дела с ТЗ?',
      '15/03/24, 14:06 - Пётр: Работаю, скоро скину черновик',
    ].join('\n');

    const result = parseWhatsAppExport(raw);
    assertEqual(result.messages.length, 2, 'два сообщения распознаны');
    assertEqual(result.messages[0].sender, 'Иван', 'первый отправитель');
    assertEqual(result.messages[0].text, 'Привет, как дела с ТЗ?', 'текст первого сообщения');
    assertEqual(result.distinctSenders.sort(), ['Иван', 'Пётр'].sort(), 'оба уникальных отправителя найдены');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: parseWhatsAppExport() разбирает iOS-формат (со скобками, секундами, AM/PM)', () => {
    const raw = '[15/03/24, 2:05:30 PM] Иван: Проверь вложение';

    const result = parseWhatsAppExport(raw);
    assertEqual(result.messages.length, 1, 'сообщение распознано');
    assertEqual(result.messages[0].sender, 'Иван', 'отправитель распознан');
    // PM 2:05 → 14:05 в 24-часовом формате — проверяем через объект Date
    const date = new Date(result.messages[0].timestampMs);
    assertEqual(date.getHours(), 14, 'PM корректно конвертирован в 24-часовой формат');
    assertEqual(date.getMinutes(), 5, 'минуты корректны');
    assertEqual(date.getSeconds(), 30, 'секунды из iOS-формата распознаны');
  });

  test('parseWhatsAppExport() дописывает многострочное сообщение к предыдущему', () => {
    const raw = [
      '15/03/24, 14:05 - Иван: Вот план на завтра:',
      '1. Встреча в 10',
      '2. Звонок в 15',
    ].join('\n');

    const result = parseWhatsAppExport(raw);
    assertEqual(result.messages.length, 1, 'ровно одно сообщение, не три отдельных');
    assertEqual(
      result.messages[0].text,
      'Вот план на завтра:\n1. Встреча в 10\n2. Звонок в 15',
      'продолжения дописаны к тексту через перевод строки',
    );
  });

  test('parseWhatsAppExport() молча пропускает служебные строки без формата "Имя: текст"', () => {
    const raw = [
      '15/03/24, 14:00 - Сообщения и звонки защищены сквозным шифрованием.',
      '15/03/24, 14:05 - Иван: Привет',
    ].join('\n');

    const result = parseWhatsAppExport(raw);
    assertEqual(result.messages.length, 1, 'служебная строка не создала фиктивное сообщение');
    assertEqual(result.distinctSenders, ['Иван'], 'служебная строка не создала фиктивного отправителя');
  });

  test('parseWhatsAppExport() возвращает пустой результат для пустого текста, не падает', () => {
    const result = parseWhatsAppExport('');
    assertEqual(result.messages.length, 0, 'пустой список сообщений');
    assertEqual(result.distinctSenders.length, 0, 'пустой список отправителей');
  });

  // ── Пункт 88: parseTelegramExport() ──

  test('КЛЮЧЕВОЙ ТЕСТ: parseTelegramExport() разбирает реалистичный result.json', () => {
    const json = JSON.stringify({
      name: 'Тестовый чат',
      type: 'personal_chat',
      id: 123456,
      messages: [
        { id: 1, type: 'message', date: '2026-01-15T10:30:00', date_unixtime: '1768466400', from: 'Иван', text: 'Привет' },
        { id: 2, type: 'message', date: '2026-01-15T10:31:00', date_unixtime: '1768466460', from: 'Мария', text: 'Привет, как дела?' },
      ],
    });
    const result = parseTelegramExport(json);
    assertEqual(result.messages.length, 2, 'оба реальных сообщения разобраны');
    assertEqual(result.messages[0].sender, 'Иван', 'отправитель первого сообщения корректен');
    assertEqual(result.distinctSenders, ['Иван', 'Мария'], 'оба уникальных отправителя найдены');
  });

  test('parseTelegramExport() пропускает service-записи (не message)', () => {
    const json = JSON.stringify({
      messages: [
        { id: 1, type: 'service', action: 'invite_members', actor: 'Иван' },
        { id: 2, type: 'message', date_unixtime: '1768466400', from: 'Иван', text: 'Реальное сообщение' },
      ],
    });
    const result = parseTelegramExport(json);
    assertEqual(result.messages.length, 1, 'service-запись честно пропущена, не создан фиктивный участник');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: parseTelegramExport() извлекает текст из форматированного массива (жирный/ссылки)', () => {
    const json = JSON.stringify({
      messages: [
        {
          id: 1,
          type: 'message',
          date_unixtime: '1768466400',
          from: 'Иван',
          text: ['Проверь ', { type: 'bold', text: 'это' }, ' по ссылке: ', { type: 'link', text: 'example.com' }],
        },
      ],
    });
    const result = parseTelegramExport(json);
    assertEqual(result.messages[0].text, 'Проверь это по ссылке: example.com', 'куски форматированного текста склеены в читаемую строку');
  });

  test('parseTelegramExport() пропускает сообщения без текста (фото без подписи)', () => {
    const json = JSON.stringify({
      messages: [
        { id: 1, type: 'message', date_unixtime: '1768466400', from: 'Иван', photo: 'photo.jpg' }, // нет поля text вообще
      ],
    });
    const result = parseTelegramExport(json);
    assertEqual(result.messages.length, 0, 'сообщение без текстового содержимого честно пропущено, не пустая запись');
  });

  test('parseTelegramExport() возвращает пустой результат для невалидного JSON, не бросает исключение', () => {
    const result = parseTelegramExport('не json{{{');
    assertEqual(result, { messages: [], distinctSenders: [] }, 'битый JSON — честный пустой результат');
  });

  test('parseTelegramExport() использует date_unixtime как источник времени, не date', () => {
    // Специально расходящиеся значения — тест доказывает, какое поле реально используется.
    const json = JSON.stringify({
      messages: [{ id: 1, type: 'message', date: '2000-01-01T00:00:00', date_unixtime: '1768466400', from: 'Иван', text: 'x' }],
    });
    const result = parseTelegramExport(json);
    assertEqual(result.messages[0].timestampMs, 1768466400 * 1000, 'date_unixtime использован, не менее однозначный date');
  });

  // ── Пункт 88: parseEmlFile() ──

  test('КЛЮЧЕВОЙ ТЕСТ: parseEmlFile() разбирает реалистичное .eml-письмо', () => {
    const eml = [
      'From: "Иван Петров" <ivan@example.com>',
      'To: maria@example.com',
      'Date: Mon, 15 Jan 2026 10:30:00 +0200',
      'Subject: Раздел имущества',
      '',
      'Здравствуйте, Мария.',
      'Предлагаю обсудить раздел имущества на следующей неделе.',
    ].join('\r\n');

    const result = parseEmlFile(eml);
    assertEqual(result?.sender, 'Иван Петров', 'имя извлечено из заголовка From, не весь "Имя <email>"');
    assertEqual(result?.text, 'Здравствуйте, Мария.\nПредлагаю обсудить раздел имущества на следующей неделе.', 'тело письма разобрано корректно, многострочное сохранено');
  });

  test('parseEmlFile() использует весь заголовок From, если формат "Имя <email>" не совпал', () => {
    const eml = ['From: ivan@example.com', 'Date: Mon, 15 Jan 2026 10:30:00 +0200', '', 'Текст письма'].join('\r\n');
    const result = parseEmlFile(eml);
    assertEqual(result?.sender, 'ivan@example.com', 'без совпадения формата "Имя <email>" — весь заголовок как есть');
  });

  test('parseEmlFile() возвращает null без заголовка From', () => {
    const eml = ['Date: Mon, 15 Jan 2026 10:30:00 +0200', 'Subject: x', '', 'Текст'].join('\r\n');
    assertEqual(parseEmlFile(eml), null, 'без From — не похоже на валидное письмо, честный null');
  });

  test('parseEmlFile() возвращает null для пустого тела письма', () => {
    const eml = ['From: ivan@example.com', 'Date: Mon, 15 Jan 2026 10:30:00 +0200', '', '   '].join('\r\n');
    assertEqual(parseEmlFile(eml), null, 'пустое тело — нечего импортировать, честный null');
  });

  for (const [name, fn] of scenarios) {
    try {
      fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  const failed = results.filter((r) => r.error);
  console.log(`\nchat-import-parse: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

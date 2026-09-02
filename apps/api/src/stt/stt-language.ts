// Пункт [stt-multi] 2026-09-02 — какой STT-провайдер обслуживает какой язык.
//
// ПОВОД (продуктовое решение владельца: «Soniox для русского и
// украинского, для английского старый вариант, фоллбек для всех —
// ElevenLabs»).
//
// Фактическая причина, по которой это вообще понадобилось: AssemblyAI
// НЕ поддерживает ни русский, ни украинский в ПОТОКОВОМ режиме — ни
// одна из трёх streaming-моделей (Universal-3.5 Pro: en/es/de/fr/pt/it/
// tr/nl/sv/no/da/fi/hi/vi/ar/he/ja/zh; Multilingual: шесть европейских;
// English: только английский). Проект это уже один раз почувствовал:
// живой прогон голосового ввода на русском вернул галлюцинацию на
// английском и иврите — отсюда обходной путь transcribeShortNoteSync()
// через асинхронную модель. В асинхронном режиме ru/uk есть, но только
// у universal-2, и сам AssemblyAI относит их к категории «good»
// (WER 10–25%).
//
// Soniox: ru и uk в реальном времени И в файлах, единая мультиязычная
// модель с переключением языка ВНУТРИ ФРАЗЫ. Для нашей аудитории это не
// украшение: суржик и ru↔uk смесь в одном разговоре — норма, а не край.
//
// Разбор и сравнение провайдеров — docs/devils-advocate-stt-provider-2026-09-02.md.

/** Провайдеры распознавания речи, для которых в проекте есть клиент. */
export type SttProviderName = 'soniox' | 'assemblyai' | 'elevenlabs';

/**
 * Полоса исполнения — то же разделение, что у AI-роутера
 * ([router-lanes]), и по той же причине: «клиент есть» не означает
 * «эту задачу он возьмёт».
 *
 *  • `realtime` — браузер подключается к провайдеру напрямую по
 *    короткоживущему токену (у нас нет постоянных WebSocket'ов);
 *  • `webhook`  — длинный файл, результат приходит вебхуком;
 *  • `sync`     — короткая запись, ответ в том же вызове.
 */
export type SttLane = 'realtime' | 'webhook' | 'sync';

/** Языки, которые остаются на прежнем провайдере (AssemblyAI).
 *  Всё остальное — Soniox, см. sttProviderForLanguage. */
const ASSEMBLYAI_LANGUAGES = new Set(['en']);

/** Нормализация кода языка: 'ru-RU' → 'ru', мусор → null. Та же
 *  функция по смыслу, что normalizeLanguageCode для языка ОТВЕТА AI, но
 *  отдельная: здесь речь про язык ЗВУКА, и списки провайдеров свои. */
export function normalizeSttLanguage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}

/**
 * Кто ведёт этот язык.
 *
 * Язык НЕИЗВЕСТЕН — тоже Soniox: он один умеет определять язык сам и
 * держит 60+ языков одной моделью, тогда как выбор AssemblyAI вслепую
 * означал бы для русскоязычного пользователя ровно ту галлюцинацию, из-за
 * которой всё и затевалось. Аудитория продукта — Украина: «не знаем
 * язык» здесь ближе к ru/uk, чем к английскому.
 */
export function sttProviderForLanguage(rawLanguage: string | null | undefined): SttProviderName {
  const language = normalizeSttLanguage(rawLanguage);
  if (language && ASSEMBLYAI_LANGUAGES.has(language)) return 'assemblyai';
  return 'soniox';
}

/**
 * Порядок попыток: основной провайдер языка, затем фоллбек.
 *
 * ElevenLabs — общий фоллбек (продуктовое решение владельца; он уже
 * вендор проекта по TTS, отдельного договора и ключа не нужно). Но
 * только там, где он реально может помочь:
 *
 *  • `sync` — да: один multipart-запрос, ответ сразу;
 *  • `webhook` — НЕТ: у ElevenLabs асинхронный результат уходит на
 *    вебхук, настроенный на уровне рабочего пространства, с подписью
 *    HMAC, а не с заголовком, который мы задаём в самом запросе (так
 *    умеют AssemblyAI и Soniox). Подставлять сюда провайдера, чей
 *    вебхук наш guard не примет, значит потерять результат молча —
 *    поэтому на длинном файле фоллбек идёт во ВТОРОГО вебхучного
 *    провайдера, а ElevenLabs честно не участвует;
 *  • `realtime` — НЕТ: языковое покрытие Scribe v2 Realtime по ru/uk
 *    провайдером не подтверждено (в анонсе названы шесть языков плюс
 *    общая цифра «90»). Деградация живого режима — не в него, а в
 *    короткую синхронную расшифровку, где ElevenLabs как раз доступен.
 */
export function sttFallbackChain(
  rawLanguage: string | null | undefined,
  lane: SttLane,
): SttProviderName[] {
  const primary = sttProviderForLanguage(rawLanguage);

  if (lane === 'realtime') {
    // Живой режим: у AssemblyAI нет ru/uk вовсе, у Soniox — есть.
    // Второй попытки нет: подключение устанавливает браузер, «повторить
    // другим провайдером» — это другой WebSocket, и решает это клиент.
    return [primary];
  }

  if (lane === 'webhook') {
    const other: SttProviderName = primary === 'soniox' ? 'assemblyai' : 'soniox';
    return [primary, other];
  }

  return primary === 'elevenlabs' ? [primary] : [primary, 'elevenlabs'];
}

/**
 * Подсказки языка для мультиязычных провайдеров. Пустой список = «определи
 * сам»; для нашей аудитории даже при известном языке полезно передать
 * оба — разговор на русском регулярно содержит украинские вставки.
 */
export function sttLanguageHints(rawLanguage: string | null | undefined): string[] {
  const language = normalizeSttLanguage(rawLanguage);
  if (!language) return ['uk', 'ru'];
  if (language === 'ru') return ['ru', 'uk'];
  if (language === 'uk') return ['uk', 'ru'];
  return [language];
}

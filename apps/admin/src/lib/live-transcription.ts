// Пункт 82 (§3.4 ТЗ) → клиентское подключение к AssemblyAI Streaming
// v3 API напрямую из браузера, по короткоживущему токену из
// mintTranscriptionToken() (Пункт 81). Использует mintTranscriptionToken()
// впервые не только как задел — это первый реальный потребитель.
//
// ЧЕСТНО НЕ ПРОВЕРЕНО ПРОТИВ РЕАЛЬНОГО ПОДКЛЮЧЕНИЯ — в этой среде
// разработки нет доступа к сети (bash_tool изолирован), протокол
// WebSocket-обмена реализован по задокументированному формату
// (wss://streaming.assemblyai.com/v3/ws, PCM16 16kHz моно, события
// Begin/Turn/Termination), но не тестировался против живого сервиса.
// Та же честная оговорка, что у live-audio-capture.ts про стабильность
// захвата — первое реальное использование в TMA станет первой
// настоящей проверкой, не прогон юнит-тестов.
//
// РАЗБОР СООБЩЕНИЙ ВЫНЕСЕН В ОТДЕЛЬНУЮ ЧИСТУЮ ФУНКЦИЮ (parseStreamingMessage)
// — единственная часть этого файла, которую реально можно проверить
// числовым тестом на реалистичных примерах payload, без живого
// подключения. Вся остальная логика (WebSocket, ресемплинг PCM) —
// неизбежно непроверяемый в этой среде код, тот же класс ограничения,
// что уже был честно принят для decodeToRawAudio() в Пункте 71.
//
// ДИАРИЗАЦИЯ (Пункт 87) — параметр speaker_labels=true подтверждён
// исследованием как включающий потоковую диаризацию у AssemblyAI.
// ТОЧНОЕ ИМЯ ПОЛЯ С МЕТКОЙ ГОВОРЯЩЕГО В САМОМ JSON-ОТВЕТЕ НЕ
// ПОДТВЕРЖДЕНО документацией с той же точностью, что формат Turn/
// transcript/end_of_turn — предположение по распространённому
// паттерну (`speaker`), не факт. Честно: если поле называется иначе,
// speakerLabel будет всегда undefined, диаризация молча не сработает,
// не сломает остальной транскрипт (текст всё равно разбирается
// корректно независимо от наличия speaker-поля).

export interface TranscriptUpdate {
  text: string;
  isFinal: boolean;
  // undefined, если диаризация не запрошена или поле в ответе называется
  // иначе, чем предполагалось — см. обоснование выше.
  speakerLabel?: string;
}

/** Чистая функция — разбирает одно сообщение от AssemblyAI Streaming
 * v3 в унифицированный TranscriptUpdate. Формат ("Turn" события с
 * полями transcript/end_of_turn) взят из документированного протокола
 * — тестируется на реалистичных примерах JSON, не на живом соединении. */
export function parseStreamingMessage(raw: string): TranscriptUpdate | null {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data.type !== 'Turn') return null;
  if (typeof data.transcript !== 'string' || !data.transcript.trim()) return null;
  return {
    text: data.transcript,
    isFinal: !!data.end_of_turn,
    speakerLabel: typeof data.speaker === 'string' ? data.speaker : undefined,
  };
}

/** Конвертирует Float32 PCM (любой sample rate источника) в Int16 PCM
 * при целевом sampleRate — простая линейная интерполяция при
 * ресемплинге, не студийное качество, но достаточно для распознавания
 * речи (AssemblyAI сам устойчив к умеренным артефактам ресемплинга). */
export function resampleTo16kMono(input: Float32Array, inputSampleRate: number): Int16Array<ArrayBuffer> {
  const targetRate = 16000;
  const ratio = inputSampleRate / targetRate;
  const outputLength = Math.floor(input.length / ratio);
  // Явно выделяем конкретный ArrayBuffer (не обобщённый ArrayBufferLike,
  // который включает SharedArrayBuffer) — иначе WebSocket.send() в
  // строгой типизации lib.dom.d.ts отказывается принимать результат.
  const buffer = new ArrayBuffer(outputLength * 2);
  const output = new Int16Array(buffer);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const frac = srcIndex - srcIndexFloor;
    const s0 = input[srcIndexFloor] ?? 0;
    const s1 = input[srcIndexFloor + 1] ?? s0;
    const sample = s0 + (s1 - s0) * frac;
    const clamped = Math.max(-1, Math.min(1, sample));
    output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
}

export interface LiveTranscriptionHandle {
  stop: () => void;
}

/** Открывает WebSocket к AssemblyAI, качает PCM из mediaStream через
 * ScriptProcessorNode (устаревший, но самый широко поддерживаемый API
 * для доступа к сырым сэмплам синхронно — AudioWorkletNode современнее,
 * но требует отдельный модульный файл, что усложняет сборку в этой
 * среде без проверки на реальной сборке). */
export function connectLiveTranscription(
  token: string,
  audioContext: AudioContext,
  mediaStream: MediaStream,
  onTranscript: (update: TranscriptUpdate) => void,
  onError: (message: string) => void,
  // Пункт [voice-note-ru] 2026-09-01: пин языка стриминга. ВАЖНО:
  // стриминг v3 поддерживает 18 языков БЕЗ русского/украинского —
  // для них этот транспорт не годится вовсе (галлюцинации чужими
  // языками), используйте async-путь короткой заметки. Массив
  // кодируется JSON'ом в query — формат из спецификации API.
  options?: { languageCodes?: string[] },
): LiveTranscriptionHandle {
  // Финальный аудит 2026-08-30 (продолжение) — WS URL не задавал speech_model
  // и mode вообще. Живая документация AssemblyAI по этому конкретному параметру
  // противоречива между источниками (часть говорит «обязателен, без дефолта»,
  // часть — «недавно стал опциональным с дефолтом на стороне аккаунта») — то
  // есть сам API в этой части ещё не устоялся. При любой трактовке отсутствие
  // параметра — плохой исход: либо соединение не открывается вовсе, либо тихо
  // закрепляется за моделью, отличной от той, что нужна продукту (older
  // universal-streaming-* модели не поддерживают, например, mode). Явно
  // указываем ту же модель, что и в async-пути (transcription.service.ts) —
  // universal-3-5-pro, и mode=balanced как основной регулятор
  // латентность/точность, который сама документация советует ставить в первую
  // очередь. Точное имя параметра/значения — сверить с
  // /docs/streaming/select-the-speech-model перед следующим релизом, если
  // AssemblyAI выпустит новую модель речи.
  const languageParam = options?.languageCodes?.length
    ? `&language_codes=${encodeURIComponent(JSON.stringify(options.languageCodes))}`
    : '';
  const ws = new WebSocket(
    `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&speech_model=universal-3-5-pro&mode=balanced&speaker_labels=true${languageParam}&token=${encodeURIComponent(token)}`,
  );

  const source = audioContext.createMediaStreamSource(mediaStream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  source.connect(processor);
  processor.connect(audioContext.destination);

  processor.onaudioprocess = (event) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    const pcm16 = resampleTo16kMono(input, audioContext.sampleRate);
    // Передаём сам TypedArray, не .buffer — Int16Array валиден как
    // BufferSource напрямую, избегает несовпадения типов
    // ArrayBuffer|SharedArrayBuffer с lib.dom.d.ts у WebSocket.send().
    ws.send(pcm16);
  };

  ws.onmessage = (event) => {
    const update = parseStreamingMessage(typeof event.data === 'string' ? event.data : '');
    if (update) onTranscript(update);
  };

  ws.onerror = () => {
    onError('Подключение к транскрипции прервалось');
  };

  // Финальный аудит 2026-08-30 (продолжение) — до этой правки не было
  // ws.onclose вообще. Проблема: сервер может закрыть сокет с конкретным
  // кодом (документация перечисляет 1008/3005-3009) БЕЗ события error —
  // по спецификации WebSocket error и close различны, серверное закрытие
  // с ненулевым кодом не обязано порождать error. Без onclose live-функции
  // (подсказки, экран сопровождения) молча переставали бы получать
  // транскрипт, ничем это не показывая — пользователь считал бы сессию
  // всё ещё активной. closingIntentionally отличает наш собственный
  // stop() (Terminate → ожидаемое закрытие) от закрытия по инициативе
  // сервера — не полагаемся на угадывание, каким кодом AssemblyAI
  // закроет сокет после Terminate.
  let closingIntentionally = false;
  const CLOSE_CODE_MESSAGES: Record<number, string> = {
    1008: 'Не удалось авторизоваться в сервисе транскрипции — токен недействителен или истёк',
    3005: 'Сессия транскрипции отменена сервисом (внутренняя ошибка провайдера)',
    3006: 'Сервис транскрипции отклонил сообщение — некорректный формат',
    3007: 'Сервис транскрипции прервал передачу аудио — поток передавался некорректно',
    3008: 'Сессия транскрипции истекла по времени — начните заново',
    3009: 'Слишком много одновременных сессий транскрипции — попробуйте позже',
  };
  ws.onclose = (event) => {
    if (closingIntentionally || event.code === 1000) return;
    onError(CLOSE_CODE_MESSAGES[event.code] ?? `Соединение с сервисом транскрипции закрыто (код ${event.code})`);
  };

  return {
    stop: () => {
      processor.disconnect();
      source.disconnect();
      closingIntentionally = true;
      // Финальный аудит 2026-08-30 (продолжение) — раньше здесь сразу
      // вызывался ws.close() без отправки управляющего сообщения Terminate.
      // Документация прямо называет это обязательным шагом: без него
      // AssemblyAI продолжает тарифицировать соединение вплоть до
      // 3-часового потолка (код закрытия 3008), даже если браузер уже
      // разорвал сокет со своей стороны. С speaker_labels=true (включён
      // выше) это имеет и вторую цену: SpeakerRevision — уточнение меток
      // говорящих по всей сессии — приходит СТРОГО в ответ на Terminate,
      // прямо перед закрытием; без него клиент никогда не получил бы
      // уточнённую диаризацию (сам разбор SpeakerRevision в
      // parseStreamingMessage — отдельная задача, здесь только
      // корректное завершение сессии, не ретроактивная перерисовка уже
      // показанных реплик).
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'Terminate' }));
        // Защитный таймаут: сервер обычно закрывает сокет сам после
        // Terminate/SpeakerRevision (~400 мс), но если вкладка сворачивается
        // или сеть моргает, форсируем закрытие, чтобы не держать ресурс
        // браузера открытым бесконечно.
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) ws.close();
        }, 2000);
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}

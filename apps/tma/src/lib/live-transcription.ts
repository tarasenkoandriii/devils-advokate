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
): LiveTranscriptionHandle {
  const ws = new WebSocket(
    `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&speaker_labels=true&token=${encodeURIComponent(token)}`,
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

  return {
    stop: () => {
      processor.disconnect();
      source.disconnect();
      if (ws.readyState === WebSocket.OPEN) ws.close();
    },
  };
}

import { connectLiveTranscription, parseStreamingMessage, resampleTo16kMono } from '../lib/live-transcription';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => void][] = [];
  const test = (name: string, fn: () => void) => scenarios.push([name, fn]);

  test('parseStreamingMessage() возвращает null для невалидного JSON — не бросает исключение', () => {
    assertEqual(parseStreamingMessage('not json{{{'), null, 'битый JSON — честный null, не падение');
  });

  test('parseStreamingMessage() игнорирует сообщения не типа Turn (Begin/Termination)', () => {
    assertEqual(parseStreamingMessage('{"type":"Begin","id":"session-1"}'), null, 'Begin — не транскрипт, честно пропущен');
    assertEqual(parseStreamingMessage('{"type":"Termination"}'), null, 'Termination — не транскрипт, честно пропущен');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: parseStreamingMessage() корректно разбирает частичный (не финальный) Turn', () => {
    const result = parseStreamingMessage('{"type":"Turn","transcript":"привет как","end_of_turn":false}');
    assertEqual(result, { text: 'привет как', isFinal: false }, 'частичный транскрипт разобран с isFinal=false');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: parseStreamingMessage() корректно разбирает финальный Turn', () => {
    const result = parseStreamingMessage('{"type":"Turn","transcript":"привет как дела","end_of_turn":true}');
    assertEqual(result, { text: 'привет как дела', isFinal: true }, 'финальный транскрипт разобран с isFinal=true');
  });

  test('parseStreamingMessage() игнорирует Turn с пустым transcript', () => {
    assertEqual(parseStreamingMessage('{"type":"Turn","transcript":"","end_of_turn":false}'), null, 'пустая строка транскрипта — честно пропущена, не пустой хинт');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: resampleTo16kMono() сохраняет длительность звука при понижении частоты дискретизации', () => {
    // 48000 сэмплов при 48kHz = 1 секунда. При ресемплинге до 16kHz — должно получиться ~16000 сэмплов.
    const input = new Float32Array(48000).fill(0.1);
    const output = resampleTo16kMono(input, 48000);
    assertEqual(Math.abs(output.length - 16000) < 10, true, 'длительность 1 секунда сохранена — ~16000 сэмплов на выходе, не искажена по времени');
  });

  test('resampleTo16kMono() не меняет длину, если вход уже на целевой частоте 16kHz', () => {
    const input = new Float32Array(16000).fill(0.1);
    const output = resampleTo16kMono(input, 16000);
    assertEqual(output.length, 16000, 'коэффициент ресемплинга 1:1 — длина не изменилась');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: resampleTo16kMono() корректно конвертирует амплитуду Float32 [-1,1] в Int16 диапазон', () => {
    const input = new Float32Array([1.0, -1.0, 0.0, 0.5]);
    // При downsample с одинаковой частоты (1:1) значения должны пройти почти без искажения.
    const output = resampleTo16kMono(input, 16000);
    assertEqual(output[0], 0x7fff, 'амплитуда +1.0 отображена в максимальное положительное Int16 значение');
    assertEqual(output[1], -0x8000, 'амплитуда -1.0 отображена в минимальное отрицательное Int16 значение (не -0x7fff — асимметрия PCM корректна)');
    assertEqual(output[2], 0, 'тишина (0.0) отображена в 0');
  });

  test('resampleTo16kMono() ограничивает (clamp) значения вне диапазона [-1,1], не переполняет Int16', () => {
    const input = new Float32Array([1.5, -1.5]); // выход за пределы валидного диапазона
    const output = resampleTo16kMono(input, 16000);
    assertEqual(output[0], 0x7fff, 'значение выше 1.0 обрезано до максимума, не переполнено');
    assertEqual(output[1], -0x8000, 'значение ниже -1.0 обрезано до минимума, не переполнено');
  });

  // ── Пункт 87: диаризация в TranscriptUpdate ──

  test('КЛЮЧЕВОЙ ТЕСТ: parseStreamingMessage() извлекает speakerLabel, если поле speaker присутствует', () => {
    const result = parseStreamingMessage('{"type":"Turn","transcript":"привет","end_of_turn":true,"speaker":"A"}');
    assertEqual(result?.speakerLabel, 'A', 'метка говорящего извлечена');
  });

  test('parseStreamingMessage() честно возвращает speakerLabel=undefined, если поле speaker отсутствует', () => {
    const result = parseStreamingMessage('{"type":"Turn","transcript":"привет","end_of_turn":true}');
    assertEqual(result?.speakerLabel, undefined, 'без диаризации — честный undefined, не выдуманная метка, остальной транскрипт всё равно разобран корректно');
  });

  // ── Финальный аудит 2026-08-30 (продолжение) — connectLiveTranscription()
  // ── не имел вообще ни одного теста; заодно у него отсутствовал speech_model/
  // ── mode в URL (см. docs/AUDIT-ASSEMBLYAI-2026-08-30.md). Браузерные API
  // ── (WebSocket/AudioContext/MediaStream) минимально застублены — сама
  // ── функция синхронна (открывает сокет, возвращает handle сразу), поэтому
  // ── тест тоже синхронный, без сети.

  test('РЕГРЕСІЯ: connectLiveTranscription() задає speech_model і mode в URL WebSocket (найпоширеніша помилка інтеграції за словами самої документації AssemblyAI)', () => {
    let capturedUrl: string | undefined;
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 0;
      onmessage: ((e: any) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) { capturedUrl = url; }
      close() {}
    }
    (global as any).WebSocket = FakeWebSocket;
    const fakeNode = { connect: () => {}, disconnect: () => {} };
    const fakeAudioContext: any = {
      sampleRate: 16000,
      createMediaStreamSource: () => fakeNode,
      createScriptProcessor: () => ({ ...fakeNode, onaudioprocess: null }),
      destination: {},
    };
    const handle = connectLiveTranscription('test-token', fakeAudioContext, {} as any, () => {}, () => {});
    handle.stop();

    assertEqual(capturedUrl?.startsWith('wss://streaming.assemblyai.com/v3/ws?'), true, 'правильний endpoint');
    assertEqual(capturedUrl?.includes('speech_model=universal-3-5-pro'), true, 'speech_model заданий явно — без нього AssemblyAI або відхиляє з’єднання, або мовчки закріплює застарілу модель (документація суперечлива щодо required/optional, тому явне значення безпечне за будь-якого трактування)');
    assertEqual(capturedUrl?.includes('mode=balanced'), true, 'mode — основний регулятор латентність/точність, документація радить задавати його першим');
    assertEqual(capturedUrl?.includes('token=test-token'), true, 'токен передано браузеру для прямого підключення, ключ на клієнт не потрапляє');
  });

  test('РЕГРЕСІЯ: connectLiveTranscription().stop() надсилає {"type":"Terminate"} ПЕРЕД закриттям сокету, не закриває його напряму (документація прямо вимагає — інакше AssemblyAI тарифікує сесію до 3-годинного стелі)', () => {
    const sentMessages: string[] = [];
    let closeCalled = false;
    class FakeWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 1; // OPEN — сессия уже установлена на момент вызова stop()
      onmessage: ((e: any) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(_url: string) {} // URL этот тест не проверяет — проверяет Terminate
      send(data: string) { sentMessages.push(data); }
      close() { closeCalled = true; }
    }
    (global as any).WebSocket = FakeWebSocket;
    const fakeNode = { connect: () => {}, disconnect: () => {} };
    const fakeAudioContext: any = {
      sampleRate: 16000,
      createMediaStreamSource: () => fakeNode,
      createScriptProcessor: () => ({ ...fakeNode, onaudioprocess: null }),
      destination: {},
    };
    // stop() ставит защитный setTimeout(…, 2000) на форсированное закрытие —
    // в браузере это корректно (см. комментарий в live-transcription.ts), но
    // здесь, в синхронном ts-node раннере, реальный таймер держал бы процесс
    // живым лишние 2 секунды на каждый прогон файла. Подменяем global.setTimeout
    // на no-op локально для этого теста — таймер не запускаем вовсе, тест
    // проверяет только синхронную часть stop() (Terminate отправлен, close() нет).
    const realSetTimeout = global.setTimeout;
    (global as any).setTimeout = () => 0 as any;
    try {
      const handle = connectLiveTranscription('test-token', fakeAudioContext, {} as any, () => {}, () => {});
      handle.stop();
    } finally {
      global.setTimeout = realSetTimeout;
    }

    assertEqual(sentMessages, [JSON.stringify({ type: 'Terminate' })], 'Terminate відправлено як контрольне повідомлення перед закриттям');
    assertEqual(closeCalled, false, 'close() НЕ викликається синхронно — сервер сам закриє сокет після Terminate/SpeakerRevision, форсоване закриття лише як захисний таймаут');
  });

  test('РЕГРЕСІЯ: серверне закриття з кодом із таблиці документації (напр. 3008 — сесія прострочена) викликає onError з осмисленим повідомленням, навіть коли onerror НЕ спрацював', () => {
    let lastInstance: any;
    class FakeWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 1;
      onmessage: ((e: any) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((e: any) => void) | null = null;
      // Тестовый дубль: экземпляр создаёт тестируемый код, и добраться
      // до него можно только так — это не aliasing ради удобства.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      constructor(_url: string) { lastInstance = this; }
      send() {}
      close() {}
    }
    (global as any).WebSocket = FakeWebSocket;
    const fakeNode = { connect: () => {}, disconnect: () => {} };
    const fakeAudioContext: any = {
      sampleRate: 16000,
      createMediaStreamSource: () => fakeNode,
      createScriptProcessor: () => ({ ...fakeNode, onaudioprocess: null }),
      destination: {},
    };
    let capturedError: string | undefined;
    connectLiveTranscription('test-token', fakeAudioContext, {} as any, () => {}, (msg) => { capturedError = msg; });

    // onerror НЕ викликається — саме так реально поводиться браузерний WebSocket
    // при серверному закритті з ненульовим кодом (error і close — різні події).
    lastInstance.onclose({ code: 3008 });

    assertEqual(capturedError, 'Сессия транскрипции истекла по времени — начните заново', 'osмислене повідомлення по коду 3008 з таблиці документації, без будь-якого onerror');
  });

  test('РЕГРЕСІЯ: власний stop() (Terminate → нормальне закриття) НЕ викликає onError — closingIntentionally відрізняє намірене закриття від серверного', () => {
    let lastInstance: any;
    class FakeWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 1;
      onmessage: ((e: any) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((e: any) => void) | null = null;
      // Тестовый дубль: экземпляр создаёт тестируемый код, и добраться
      // до него можно только так — это не aliasing ради удобства.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      constructor(_url: string) { lastInstance = this; }
      send() {}
      close() {}
    }
    (global as any).WebSocket = FakeWebSocket;
    const fakeNode = { connect: () => {}, disconnect: () => {} };
    const fakeAudioContext: any = {
      sampleRate: 16000,
      createMediaStreamSource: () => fakeNode,
      createScriptProcessor: () => ({ ...fakeNode, onaudioprocess: null }),
      destination: {},
    };
    let capturedError: string | undefined;
    const realSetTimeout = global.setTimeout;
    (global as any).setTimeout = () => 0 as any;
    let handle: any;
    try {
      handle = connectLiveTranscription('test-token', fakeAudioContext, {} as any, () => {}, (msg) => { capturedError = msg; });
      handle.stop();
    } finally {
      global.setTimeout = realSetTimeout;
    }
    // Сервер закриває сокет після Terminate — навіть довільним кодом (не завжди 1000).
    lastInstance.onclose({ code: 3005 });

    assertEqual(capturedError, undefined, 'закриття після власного stop() — очікуване, onError не викликається незалежно від коду, який надішле сервер');
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
  console.log(`\nlive-transcription: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

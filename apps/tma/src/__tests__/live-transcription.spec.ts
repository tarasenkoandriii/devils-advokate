import { parseStreamingMessage, resampleTo16kMono } from '../lib/live-transcription';

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

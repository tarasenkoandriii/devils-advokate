import { embeddingToArray } from '../lib/voice-embedding';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => void][] = [];
  const test = (name: string, fn: () => void) => scenarios.push([name, fn]);

  test('embeddingToArray() корректно конвертирует Float32Array в обычный массив чисел', () => {
    const input = new Float32Array([0.1, -0.5, 0.9, 0.0]);
    const result = embeddingToArray(input);
    assertEqual(result, [
      Math.fround(0.1),
      Math.fround(-0.5),
      Math.fround(0.9),
      0,
    ], 'значения сохранены, тип — обычный массив, не типизированный');
    assertEqual(Array.isArray(result), true, 'результат — реальный Array, не Float32Array (важно для JSON.stringify при отправке на backend)');
  });

  test('embeddingToArray() сохраняет длину вектора', () => {
    const input = new Float32Array(192).fill(0.5); // типичная размерность эмбеддинга голоса — 192 или 256
    const result = embeddingToArray(input);
    assertEqual(result.length, 192, 'размерность не потеряна при конвертации');
  });

  test('embeddingToArray() корректно обрабатывает пустой вектор', () => {
    const input = new Float32Array(0);
    assertEqual(embeddingToArray(input), [], 'пустой вектор — пустой массив, не ошибка');
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
  console.log(`\nvoice-embedding: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

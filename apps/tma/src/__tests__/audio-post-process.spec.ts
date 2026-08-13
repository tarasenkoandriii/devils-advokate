import { normalizeVolume, removeSilence, applyHighPassFilter, encodeToWav, RawAudioData } from '../lib/audio-post-process';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

function assertClose(actual: number, expected: number, tolerance: number, message: string) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`FAIL: ${message}\n  expected ≈${expected} (±${tolerance})\n  actual:   ${actual}`);
  }
}

function makeMono(samples: number[], sampleRate = 16000): RawAudioData {
  return { numberOfChannels: 1, sampleRate, length: samples.length, channels: [new Float32Array(samples)] };
}

function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => void][] = [];
  const test = (name: string, fn: () => void) => scenarios.push([name, fn]);

  test('normalizeVolume() поднимает тихий сигнал до целевого пика 0.9', () => {
    const audio = makeMono([0.1, -0.2, 0.15, -0.1]); // пик = 0.2
    const result = normalizeVolume(audio, 0.9);
    const peak = Math.max(...Array.from(result.channels[0]).map(Math.abs));
    assertClose(peak, 0.9, 0.001, 'пик после нормализации близок к целевому значению');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: normalizeVolume() сохраняет ОТНОСИТЕЛЬНУЮ форму сигнала, не искажает пропорции', () => {
    const audio = makeMono([0.1, 0.2, 0.05]); // отношения 2:1 и 4:1 между сэмплами
    const result = normalizeVolume(audio, 0.9);
    const [a, b, c] = Array.from(result.channels[0]);
    assertClose(a / b, 0.5, 0.001, 'пропорция между первым и вторым сэмплом сохранена');
    assertClose(c / a, 0.5, 0.001, 'пропорция между третьим и первым сэмплом сохранена');
  });

  test('normalizeVolume() не падает на полной тишине (пик=0), не делит на ноль', () => {
    const audio = makeMono([0, 0, 0, 0]);
    const result = normalizeVolume(audio, 0.9);
    assertEqual(Array.from(result.channels[0]), [0, 0, 0, 0], 'тишина остаётся тишиной, без NaN/Infinity');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: removeSilence() реально укорачивает запись с длинной паузой в середине', () => {
    const sampleRate = 1000; // 1000 сэмплов = 1 секунда, удобно для расчёта
    const loud = new Array(200).fill(0.5); // 200мс громкого сигнала
    const silence = new Array(600).fill(0); // 600мс тишины — дольше порога в 400мс, должна сжаться
    const loud2 = new Array(200).fill(0.5); // ещё 200мс громкого сигнала
    const audio = makeMono([...loud, ...silence, ...loud2], sampleRate);

    const result = removeSilence(audio, { minSilenceMs: 400, keepGapMs: 150, windowMs: 50 });
    assertEqual(result.length < audio.length, true, 'итоговая длина короче исходной — длинная пауза сжата');
    assertEqual(result.length > 350, true, 'громкие участки (400мс суммарно) не потеряны, только пауза сжата');
  });

  test('removeSilence() НЕ трогает короткие естественные паузы между словами', () => {
    const sampleRate = 1000;
    const loud = new Array(200).fill(0.5);
    const shortPause = new Array(100).fill(0); // 100мс — короче порога в 400мс
    const audio = makeMono([...loud, ...shortPause, ...loud], sampleRate);

    const result = removeSilence(audio, { minSilenceMs: 400, keepGapMs: 150, windowMs: 50 });
    // Короткая пауза должна остаться почти нетронутой — итоговая длина близка к исходной.
    assertEqual(Math.abs(result.length - audio.length) < 100, true, 'короткая пауза не сжимается, длина почти не изменилась');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: applyHighPassFilter() ослабляет постоянную составляющую (DC-смещение = имитация низкочастотного гула)', () => {
    // Константный сигнал = чистая частота 0 Гц — заведомо ниже любого cutoff, фильтр высоких частот должен его подавить к нулю.
    const audio = makeMono(new Array(2000).fill(0.5), 16000);
    const result = applyHighPassFilter(audio, 100);
    const tail = Array.from(result.channels[0]).slice(-200); // берём хвост, дав фильтру время сойтись
    const avgTail = tail.reduce((s, v) => s + Math.abs(v), 0) / tail.length;
    assertEqual(avgTail < 0.05, true, 'постоянная составляющая (аналог низкочастотного гула) заметно подавлена фильтром');
  });

  test('applyHighPassFilter() пропускает быстро меняющийся сигнал почти без изменений', () => {
    // Сигнал, чередующий +1/-1 на каждом сэмпле — очень высокая частота (Найквист), должен пройти почти без ослабления.
    const samples = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5));
    const audio = makeMono(samples, 16000);
    const result = applyHighPassFilter(audio, 100);
    const tail = Array.from(result.channels[0]).slice(-50);
    const avgAbs = tail.reduce((s, v) => s + Math.abs(v), 0) / tail.length;
    assertEqual(avgAbs > 0.3, true, 'высокочастотный сигнал проходит фильтр почти без ослабления, не убит вместе с шумом');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: encodeToWav() производит корректный WAV-заголовок, читаемый обратно', () => {
    const audio = makeMono([0.5, -0.5, 0.25, -0.25], 8000);
    const blob = encodeToWav(audio);
    assertEqual(blob.type, 'audio/wav', 'MIME-тип корректен');
    assertEqual(blob.size, 44 + 4 * 2, '44 байта заголовка + 4 сэмпла × 2 байта (16-bit)');
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
  console.log(`\naudio-post-process: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

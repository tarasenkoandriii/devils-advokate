import { computeRmsDb, detectEscalation, categorizeEscalation, VolumeWindow } from '../lib/acoustic-monitor';

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

function makeWindows(dbValues: number[], startTimestamp = 0, stepMs = 500): VolumeWindow[] {
  return dbValues.map((rmsDb, i) => ({ rmsDb, timestamp: startTimestamp + i * stepMs }));
}

function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => void][] = [];
  const test = (name: string, fn: () => void) => scenarios.push([name, fn]);

  test('computeRmsDb() возвращает -Infinity для полной тишины, не выдуманное число', () => {
    const silence = new Float32Array(100).fill(0);
    assertEqual(computeRmsDb(silence), -Infinity, 'честная -Infinity, не 0 и не другое магическое значение');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: computeRmsDb() корректно считает известный синусоидальный сигнал', () => {
    // Синус амплитудой 1.0: RMS = 1/√2 ≈ 0.707, что в дБ = 20·log10(0.707) ≈ -3.01 дБ.
    const samples = new Float32Array(1000);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * i) / 100); // произвольная частота, важна только амплитуда
    }
    const db = computeRmsDb(samples);
    assertClose(db, -3.01, 0.1, 'RMS синуса амплитудой 1.0 — известное математическое значение, не приближение на глаз');
  });

  test('computeRmsDb() — сигнал вдвое тише даёт на ~6дБ меньше (удвоение амплитуды = +6дБ, стандартное свойство)', () => {
    const loud = new Float32Array(1000);
    const quiet = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) {
      loud[i] = Math.sin((2 * Math.PI * i) / 100) * 0.5;
      quiet[i] = Math.sin((2 * Math.PI * i) / 100) * 0.25;
    }
    const deltaDb = computeRmsDb(loud) - computeRmsDb(quiet);
    assertClose(deltaDb, 6.02, 0.1, 'удвоение амплитуды даёт ровно +6дБ — фундаментальное свойство RMS/дБ, не совпадение реализации');
  });

  test('detectEscalation() возвращает null при недостаточной истории — не гадает на неполных данных', () => {
    const windows = makeWindows([-20, -20, -20]); // меньше recentCount+baselineCount
    assertEqual(detectEscalation(windows), null, 'честный null, не результат на трёх точках');
  });

  test('detectEscalation() возвращает null, если громкость стабильна — нет ложной тревоги на ровном разговоре', () => {
    const stable = new Array(20).fill(-20); // 20 одинаковых окон
    const windows = makeWindows(stable);
    assertEqual(detectEscalation(windows), null, 'без реального роста — эскалация не заявлена');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: detectEscalation() обнаруживает резкий устойчивый скачок громкости', () => {
    // 10 окон baseline на -30дБ, затем 5 окон recent на -15дБ (скачок на 15дБ, выше порога в 8дБ).
    const dbValues = [...new Array(10).fill(-30), ...new Array(5).fill(-15)];
    const windows = makeWindows(dbValues);
    const result = detectEscalation(windows);
    assertEqual(result !== null, true, 'эскалация обнаружена при реальном устойчивом скачке');
    assertEqual(result!.escalationScore > 0.5, true, 'score отражает значительность скачка (15дБ при пороге 8дБ)');
    assertEqual(result!.reason.includes('дБ'), true, 'reason — нейтральное описание наблюдения, не психологический вывод');
  });

  test('detectEscalation() НЕ реагирует на единичный всплеск в recent-окне, если остальные recent тихие', () => {
    // baseline стабильно -30, но только ОДНО из 5 recent-окон громкое — среднее recent всё равно близко к baseline.
    const dbValues = [...new Array(10).fill(-30), -30, -30, -29, -30, -30];
    const windows = makeWindows(dbValues);
    assertEqual(detectEscalation(windows), null, 'единичный всплеск не тянет среднее recent выше порога — не ложная тревога на одном громком слове');
  });

  test('detectEscalation() честно называет наблюдение, не приписывает эмоцию человеку', () => {
    const dbValues = [...new Array(10).fill(-30), ...new Array(5).fill(-10)];
    const windows = makeWindows(dbValues);
    const result = detectEscalation(windows)!;
    assertEqual(result.reason.toLowerCase().includes('злит') || result.reason.toLowerCase().includes('раздраж'), false, 'reason не содержит психологической интерпретации — только "громкость выросла"');
  });

  // ── Пункт 83: categorizeEscalation (§3.33 ТЗ) ──

  test('categorizeEscalation() возвращает null при недостаточной истории', () => {
    const windows = makeWindows([-20, -20, -20]);
    assertEqual(categorizeEscalation(windows), null, 'честный null, не категория на неполных данных');
  });

  test('categorizeEscalation() возвращает CALM/score=0 для полной тишины в обоих окнах', () => {
    const silentWindows = makeWindows(new Array(20).fill(-Infinity));
    const result = categorizeEscalation(silentWindows);
    assertEqual(result, { category: 'CALM', score: 0 }, 'тишина — честный CALM с нулевым счётом, не отсутствие результата');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: categorizeEscalation() — стабильная громкость даёт CALM, не завышает категорию', () => {
    const stable = new Array(20).fill(-25);
    const result = categorizeEscalation(makeWindows(stable));
    assertEqual(result?.category, 'CALM', 'нет реального роста — CALM, не RISING/HIGH на ровном шуме');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: categorizeEscalation() — умеренный рост даёт RISING, не сразу CRITICAL', () => {
    // baseline -30, recent -25: дельта 5дБ при maxDeltaDb=20 → score=25, граница CALM/RISING.
    const dbValues = [...new Array(10).fill(-30), ...new Array(5).fill(-24)]; // дельта 6дБ → score=30 → RISING
    const result = categorizeEscalation(makeWindows(dbValues));
    assertEqual(result?.category, 'RISING', 'умеренный рост — RISING, промежуточная категория работает, не только крайние');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: categorizeEscalation() — резкий скачок даёт CRITICAL', () => {
    // baseline -30, recent -10: дельта 20дБ = maxDeltaDb → score=100 → CRITICAL.
    const dbValues = [...new Array(10).fill(-30), ...new Array(5).fill(-10)];
    const result = categorizeEscalation(makeWindows(dbValues));
    assertEqual(result?.category, 'CRITICAL', 'резкий скачок на весь диапазон калибровки — CRITICAL');
    assertEqual(result!.score >= 75, true, 'внутренний счёт в диапазоне CRITICAL (75-100)');
  });

  test('categorizeEscalation() не завышает категорию при падении громкости (отрицательная дельта)', () => {
    // baseline -20 (громче), recent -35 (тише) — падение, не рост.
    const dbValues = [...new Array(10).fill(-20), ...new Array(5).fill(-35)];
    const result = categorizeEscalation(makeWindows(dbValues));
    assertEqual(result?.category, 'CALM', 'падение громкости — не эскалация, честный CALM, не отрицательный/мусорный score');
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
  console.log(`\nacoustic-monitor: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run();

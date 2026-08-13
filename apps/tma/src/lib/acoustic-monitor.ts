// Пункт 81 (§3.31 ТЗ) — акустический слой "наблюдения" (§3.3 ТЗ):
// "то, что измеримо — пауза длиной N секунд, изменение громкости на
// X дБ, изменение темпа речи. Фиксируется как факт сигнала, а не как
// вывод о человеке" (buкально ТЗ). Только этот слой — НЕ психологи-
// ческая интерпретация, та отдельным 🟡-помеченным слоем нигде здесь
// не строится.
//
// ЧИСТЫЕ ФУНКЦИИ НАД Float32Array — тот же принцип, что
// audio-post-process.ts (Пункт 71): вся математика тестируется
// реальными числами в Node, без браузерных API. Единственная
// браузерная зависимость (AnalyserNode.getFloatTimeDomainData) живёт
// СНАРУЖИ этого файла, в вызывающем коде компонента.

export interface VolumeWindow {
  rmsDb: number;
  timestamp: number;
}

/** RMS громкости окна в дБ (relative to full scale, 0dBFS = макс).
 * Возвращает -Infinity для полной тишины — вызывающий код должен
 * сам решить, как это отображать, функция не подменяет реальное
 * значение выдуманным числом. */
export function computeRmsDb(samples: Float32Array): number {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  if (rms === 0) return -Infinity;
  return 20 * Math.log10(rms);
}

export interface EscalationResult {
  escalationScore: number; // 0..1
  peakVolumeDb: number;
  reason: string; // нейтральное описание НАБЛЮДЕНИЯ, не интерпретация ("резкий рост громкости", не "человек злится")
}

/** "Резкий рост эмоционального напряжения" (buкально ТЗ) — детекция
 * по скользящему окну громкости: сравнивает средний уровень последних
 * recentWindows с baselineWindows ДО них. Резкий, устойчивый скачок
 * (не единичный всплеск) — эскалация. НЕ анализирует темп речи или
 * паузы отдельно в этой версии — честно суженный объём первого
 * прохода, только громкость, самый однозначно измеримый сигнал. */
export function detectEscalation(
  windows: VolumeWindow[],
  options: { recentCount?: number; baselineCount?: number; thresholdDb?: number } = {},
): EscalationResult | null {
  const recentCount = options.recentCount ?? 5;
  const baselineCount = options.baselineCount ?? 10;
  const thresholdDb = options.thresholdDb ?? 8; // эмпирический порог, не откалиброван на реальных данных — честно предварительное значение

  if (windows.length < recentCount + baselineCount) return null; // недостаточно истории — не гадаем на неполных данных

  const sorted = [...windows].sort((a, b) => a.timestamp - b.timestamp);
  const recent = sorted.slice(-recentCount);
  const baseline = sorted.slice(-(recentCount + baselineCount), -recentCount);

  const finiteRecent = recent.map((w) => w.rmsDb).filter((db) => Number.isFinite(db));
  const finiteBaseline = baseline.map((w) => w.rmsDb).filter((db) => Number.isFinite(db));
  if (finiteRecent.length === 0 || finiteBaseline.length === 0) return null;

  const avgRecent = finiteRecent.reduce((a, b) => a + b, 0) / finiteRecent.length;
  const avgBaseline = finiteBaseline.reduce((a, b) => a + b, 0) / finiteBaseline.length;
  const delta = avgRecent - avgBaseline;

  if (delta < thresholdDb) return null;

  // Простая линейная нормализация delta→score, потолок на 1 при 2×threshold — не заявляем большую точность, чем есть.
  const escalationScore = Math.min(1, delta / (thresholdDb * 2));
  const peakVolumeDb = Math.max(...finiteRecent);

  return {
    escalationScore,
    peakVolumeDb,
    reason: `Громкость выросла на ${delta.toFixed(1)} дБ относительно предыдущего периода`,
  };
}

// Пункт 83 (§3.33 ТЗ) — "Индикатор накала", часть 1 из двух согласованных
// срезов экрана сопровождения. "Пользователю показываются категории:
// 🟢 CALM → 🟡 RISING → 🟠 HIGH → 🔴 CRITICAL. Внутренний числовой score
// (0-100) продолжает существовать... но никогда не показывается
// пользователю как объективная эмоциональная температура" (buкально ТЗ).

export type EscalationCategory = 'CALM' | 'RISING' | 'HIGH' | 'CRITICAL';

export interface EscalationState {
  category: EscalationCategory;
  score: number; // 0..100, ВНУТРЕННЯЯ величина — TMA не должна показывать это число напрямую пользователю
}

/** В отличие от detectEscalation() (спорадическая детекция всплеска,
 * честно null в подавляющем большинстве циклов), эта функция ВСЕГДА
 * возвращает категорию, если истории достаточно — непрерывный
 * индикатор, не событие. Пороги категорий (25/50/75) — эмпирические,
 * не откалиброванные на реальных данных, тот же честный статус, что
 * thresholdDb в detectEscalation(). */
export function categorizeEscalation(
  windows: VolumeWindow[],
  options: { recentCount?: number; baselineCount?: number; maxDeltaDb?: number } = {},
): EscalationState | null {
  const recentCount = options.recentCount ?? 5;
  const baselineCount = options.baselineCount ?? 10;
  const maxDeltaDb = options.maxDeltaDb ?? 20; // дельта в дБ, соответствующая score=100 — калибровка предварительная

  if (windows.length < recentCount + baselineCount) return null; // недостаточно истории — не гадаем

  const sorted = [...windows].sort((a, b) => a.timestamp - b.timestamp);
  const recent = sorted.slice(-recentCount);
  const baseline = sorted.slice(-(recentCount + baselineCount), -recentCount);

  const finiteRecent = recent.map((w) => w.rmsDb).filter((db) => Number.isFinite(db));
  const finiteBaseline = baseline.map((w) => w.rmsDb).filter((db) => Number.isFinite(db));

  // Тишина в обоих окнах — честно CALM с нулевым счётом, не отсутствие результата.
  if (finiteRecent.length === 0 || finiteBaseline.length === 0) {
    return { category: 'CALM', score: 0 };
  }

  const avgRecent = finiteRecent.reduce((a, b) => a + b, 0) / finiteRecent.length;
  const avgBaseline = finiteBaseline.reduce((a, b) => a + b, 0) / finiteBaseline.length;
  // Только положительная дельта считается эскалацией — падение громкости не CRITICAL.
  const delta = Math.max(0, avgRecent - avgBaseline);

  const score = Math.min(100, (delta / maxDeltaDb) * 100);

  let category: EscalationCategory;
  if (score < 25) category = 'CALM';
  else if (score < 50) category = 'RISING';
  else if (score < 75) category = 'HIGH';
  else category = 'CRITICAL';

  return { category, score };
}

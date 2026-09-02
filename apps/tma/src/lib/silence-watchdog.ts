// 2026-09-02 (решение владельца): авто-стоп голосового ввода после 30 с
// тишины.
//
// ЗАЧЕМ. Запись, которую забыли остановить, — это (а) открытый микрофон,
// стримящий комнату внешнему провайдеру, пока человек отвлёкся, и
// (б) счёт за минуты тишины (провайдеры тарифицируют соединение, а не
// речь). Оба — против обещаний продукта.
//
// КАК. Два сигнала активности, любой из них сбрасывает таймер:
//  1. акустический — RMS сигнала с AnalyserNode (уже поднят в
//     live-audio-capture для всех live-фич), опрос каждые 250 мс;
//  2. семантический — любое обновление текста от провайдера (partial или
//     final): тихий голос, который распознаётся, — не тишина, даже если
//     RMS под порогом.
// Порог RMS — 0,02 в нормированной шкале (байты вокруг 128): шум комнаты
// и дыхание в микрофон обычно 0,003–0,01, речь — от 0,03. Это эвристика,
// не VAD: цель — не пропустить речь, а не поймать каждую паузу; ошибка
// «не остановили» дешевле, чем «остановили посреди фразы».
//
// Один файл на TMA и админку (копия — как live-transcription.ts): пакеты
// не делят код.

export const SILENCE_AUTO_STOP_MS = 30_000;
const POLL_MS = 250;
const RMS_THRESHOLD = 0.02;

export interface SilenceWatchdogHandle {
  /** Любая внешняя активность (текст от провайдера) — таймер с нуля. */
  touch: () => void;
  stop: () => void;
}

/** Нормированный RMS отклонения от тишины по byte-time-domain данным. */
export function rmsOfByteTimeDomain(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

export function startSilenceWatchdog(
  analyser: AnalyserNode | null,
  onSilence: () => void,
  options: { silenceMs?: number; threshold?: number; now?: () => number; pollMs?: number } = {},
): SilenceWatchdogHandle {
  const silenceMs = options.silenceMs ?? SILENCE_AUTO_STOP_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const threshold = options.threshold ?? RMS_THRESHOLD;
  const now = options.now ?? (() => Date.now());
  let lastActivity = now();
  let fired = false;
  const buffer = analyser ? new Uint8Array(analyser.fftSize) : null;

  const timer = setInterval(() => {
    if (fired) return;
    if (analyser && buffer) {
      analyser.getByteTimeDomainData(buffer);
      if (rmsOfByteTimeDomain(buffer) >= threshold) lastActivity = now();
    }
    if (now() - lastActivity >= silenceMs) {
      fired = true;
      clearInterval(timer);
      onSilence();
    }
  }, pollMs);

  return {
    touch: () => {
      lastActivity = now();
    },
    stop: () => {
      fired = true;
      clearInterval(timer);
    },
  };
}

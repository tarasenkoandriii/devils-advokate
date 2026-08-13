// Пункт 71 (§3.41 ТЗ) — обработка записи собственного голоса для
// компромиссного листа. "Пост-обработка по возможности выполняется на
// устройстве" (буквально ТЗ) — вся математика ниже работает на
// ПЛОСКИХ Float32Array, НЕ на браузерном AudioBuffer/OfflineAudioContext
// напрямую — намеренное архитектурное решение: OfflineAudioContext
// недоступен в Node.js, что сделало бы эти функции непроверяемыми
// реальным тестом (только компиляцией). Только decodeToRawAudio()
// (сама расшифровка Blob → сэмплы) требует браузерного AudioContext —
// границу неизбежной браузерной зависимости сведена к одной функции,
// остальное — чистые, тестируемые в Node функции.
//
// "УБРАТЬ СТОРОННИЕ ШУМЫ" — ЧЕСТНО ОГРАНИЧЕНО ФИЛЬТРОМ ВЫСОКИХ ЧАСТОТ,
// согласовано с пользователем перед реализацией (см. /TODO.md).
// Полноценное спектральное шумоподавление требует FFT-алгоритма,
// рискованного для ручной реализации без эталона для сверки — вместо
// этого простой, надёжный однополюсный IIR-фильтр высоких частот
// (убирает низкочастотный гул/рокот, не широкополосный шум).

export interface RawAudioData {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  channels: Float32Array[];
}

export interface PostProcessingOptions {
  normalizeVolume: boolean;
  removePauses: boolean;
  removeNoise: boolean;
}

/** Единственная функция здесь, требующая браузерного AudioContext —
 * расшифровка сжатого аудио (webm/opus от MediaRecorder) в сырые
 * сэмплы. Всё остальное в этом файле работает на уже расшифрованных
 * Float32Array и не зависит от браузерных API. */
export async function decodeToRawAudio(blob: Blob): Promise<RawAudioData> {
  const AudioContextClass = (window as any).AudioContext ?? (window as any).webkitAudioContext;
  const audioContext = new AudioContextClass();
  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    channels.push(new Float32Array(audioBuffer.getChannelData(ch)));
  }
  await audioContext.close();
  return { numberOfChannels: audioBuffer.numberOfChannels, sampleRate: audioBuffer.sampleRate, length: audioBuffer.length, channels };
}

/** ☐ "выровнять громкость (нормализация)" — находит пиковую амплитуду
 * по всем каналам, применяет единый коэффициент усиления так, чтобы
 * пик достиг targetPeak (оставлен запас до 1.0, чтобы не клиппировать
 * при округлении позже). Полная, честная реализация — не упрощение. */
export function normalizeVolume(audio: RawAudioData, targetPeak = 0.9): RawAudioData {
  let peak = 0;
  for (const data of audio.channels) {
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }
  }
  if (peak === 0) return audio; // тишина — нечего нормализовать, не делить на ноль

  const gain = targetPeak / peak;
  const channels = audio.channels.map((data) => {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] * gain;
    return out;
  });
  return { ...audio, channels };
}

/** ☐ "убрать паузы (сжать неоправданные паузы/запинки)" — находит
 * участки тишины дольше minSilenceMs, сжимает их до keepGapMs (не
 * удаляет полностью — резкий монтажный склей звучал бы неестественно).
 * Короткие, естественные паузы между словами остаются нетронутыми. */
export function removeSilence(
  audio: RawAudioData,
  options: { silenceThreshold?: number; minSilenceMs?: number; keepGapMs?: number; windowMs?: number } = {},
): RawAudioData {
  const silenceThreshold = options.silenceThreshold ?? 0.02;
  const windowMs = options.windowMs ?? 50;
  const minSilenceMs = options.minSilenceMs ?? 400;
  const keepGapMs = options.keepGapMs ?? 150;

  const windowSize = Math.max(1, Math.floor((audio.sampleRate * windowMs) / 1000));
  const minSilenceWindows = Math.ceil(minSilenceMs / windowMs);
  const keepGapSamples = Math.floor((audio.sampleRate * keepGapMs) / 1000);

  const numWindows = Math.ceil(audio.length / windowSize);
  const isSilent: boolean[] = new Array(numWindows).fill(false);
  for (let w = 0; w < numWindows; w++) {
    const start = w * windowSize;
    const end = Math.min(start + windowSize, audio.length);
    let sumSq = 0;
    let count = 0;
    for (const data of audio.channels) {
      for (let i = start; i < end; i++) {
        sumSq += data[i] * data[i];
        count++;
      }
    }
    isSilent[w] = count > 0 && Math.sqrt(sumSq / count) < silenceThreshold;
  }

  const keepRanges: { start: number; end: number }[] = [];
  let i = 0;
  while (i < numWindows) {
    let j = i;
    while (j < numWindows && isSilent[j] === isSilent[i]) j++;
    const start = i * windowSize;
    const end = Math.min(j * windowSize, audio.length);
    if (isSilent[i] && j - i >= minSilenceWindows) {
      keepRanges.push({ start, end: Math.min(start + keepGapSamples, end) });
    } else {
      keepRanges.push({ start, end });
    }
    i = j;
  }

  const newLength = Math.max(1, keepRanges.reduce((sum, r) => sum + (r.end - r.start), 0));
  const channels = audio.channels.map((data) => {
    const out = new Float32Array(newLength);
    let pos = 0;
    for (const range of keepRanges) {
      for (let k = range.start; k < range.end; k++) out[pos++] = data[k];
    }
    return out;
  });

  return { ...audio, length: newLength, channels };
}

/** ☐ "убрать сторонние шумы (шумоподавление)" — ЧЕСТНО ограничено
 * фильтром высоких частот (однополюсный IIR-highpass, стандартная
 * формула RC-фильтра), не полноценным широкополосным шумоподавлением
 * — согласовано с пользователем, см. обоснование в шапке файла. */
export function applyHighPassFilter(audio: RawAudioData, cutoffHz = 100): RawAudioData {
  const dt = 1 / audio.sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = rc / (rc + dt);

  const channels = audio.channels.map((data) => {
    const out = new Float32Array(data.length);
    if (data.length === 0) return out;
    out[0] = data[0];
    for (let i = 1; i < data.length; i++) {
      out[i] = alpha * (out[i - 1] + data[i] - data[i - 1]);
    }
    return out;
  });
  return { ...audio, channels };
}

/** Стандартный, некомпрессированный WAV (PCM 16-bit) — простой,
 * надёжный формат для передачи на сервер, не требует внешних
 * энкодеров/библиотек. */
export function encodeToWav(audio: RawAudioData): Blob {
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = audio.numberOfChannels * bytesPerSample;
  const dataLength = audio.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, audio.numberOfChannels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < audio.length; i++) {
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, audio.channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/** Оркестратор — вызывает шаги в фиксированном порядке (шум → паузы →
 * громкость: фильтрация до сжатия пауз имеет смысл, чтобы не усилить
 * шум вместе с голосом при финальной нормализации). */
export async function postProcessAudio(blob: Blob, options: PostProcessingOptions): Promise<Blob> {
  let audio = await decodeToRawAudio(blob);
  if (options.removeNoise) audio = applyHighPassFilter(audio);
  if (options.removePauses) audio = removeSilence(audio);
  if (options.normalizeVolume) audio = normalizeVolume(audio);
  return encodeToWav(audio);
}

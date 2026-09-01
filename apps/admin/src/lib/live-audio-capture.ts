// Пункт 81 (§3.31 ТЗ) — инфраструктура захвата живого аудио, задел
// под все live-фичи (§3.4, §3.33), по прямому запросу. По прямому
// признанию проекта (Пункт 13, ConversationsSection.tsx): "поддержка
// захвата аудио в Telegram WebView нестабильна между платформами" —
// это первая попытка реально ПРОВЕРИТЬ длительный (не секунды, а
// потенциально десятки минут) захват на практике, не предположение.
//
// ЧЕСТНО НЕ РЕШАЕТ ПРОБЛЕМУ НЕСТАБИЛЬНОСТИ САМА ПО СЕБЕ — только
// даёт обёртку с явным отслеживанием состояния (idle/active/error) и
// коллбэком onError, чтобы вызывающий код (и пользователь) видел
// сбой честно, не тихо терял поток.

export type CaptureState = 'idle' | 'requesting' | 'active' | 'error' | 'stopped';

export interface LiveAudioCapture {
  state: CaptureState;
  stream: MediaStream | null;
  audioContext: AudioContext | null;
  analyserNode: AnalyserNode | null;
  errorMessage: string | null;
}

export interface LiveAudioCaptureHandle {
  stop: () => void;
  getAnalyser: () => AnalyserNode | null;
  // Пункт 82 — переиспользуются live-transcription.ts, чтобы не
  // запрашивать getUserMedia() повторно (второй запрос доступа к
  // микрофону был бы лишним и хрупким UX).
  getStream: () => MediaStream | null;
  getAudioContext: () => AudioContext | null;
}

/** Запрашивает доступ к микрофону, поднимает AudioContext+AnalyserNode
 * поверх живого потока. НЕ использует MediaRecorder (не нужен для
 * чисто акустического анализа — не сохраняем и не отправляем сам
 * звук никуда). onStateChange вызывается при каждом переходе
 * состояния — вызывающий код обязан честно показать пользователю
 * состояние 'error', не маскировать его. */
export async function startLiveAudioCapture(
  onStateChange: (state: CaptureState, errorMessage: string | null) => void,
): Promise<LiveAudioCaptureHandle | null> {
  if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) {
    onStateChange('error', 'Микрофон недоступен в этом браузере/приложении');
    return null;
  }

  onStateChange('requesting', null);
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    onStateChange('error', 'Доступ к микрофону не предоставлен');
    return null;
  }

  const AudioContextClass = (window as any).AudioContext ?? (window as any).webkitAudioContext;
  const audioContext = new AudioContextClass();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  // Отслеживаем обрыв потока (устройство отключено, вкладка потеряла
  // доступ и т.д.) — та самая нестабильность, которую честно нужно
  // проверить, а не предполагать, что её нет.
  const track = stream.getAudioTracks()[0];
  track.onended = () => {
    onStateChange('error', 'Поток микрофона неожиданно прервался');
  };

  onStateChange('active', null);

  return {
    stop: () => {
      stream.getTracks().forEach((t) => t.stop());
      audioContext.close();
      onStateChange('stopped', null);
    },
    getAnalyser: () => analyser,
    getStream: () => stream,
    getAudioContext: () => audioContext,
  };
}

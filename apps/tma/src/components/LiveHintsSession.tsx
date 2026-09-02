'use client';

// Пункт 82 (§3.4 ТЗ) → TMA UI: live-подсказки во время разговора.
// Первый реальный потребитель mintTranscriptionToken() (Пункт 81) —
// не только задел. Тот же паттерн "явно экспериментальная отдельная
// точка входа", что CooldownNudgeSession.tsx (Пункт 81) — не встроена
// молча в существующий поток загрузки разговора.
//
// ЦИКЛ ДО 30 СЕКУНД, НЕ МГНОВЕННО — согласовано явно перед
// реализацией, формулировка в UI ниже отражает это буквально, не
// выдаёт за настоящий real-time.
//
// ОКНО ТРАНСКРИПТА ОГРАНИЧЕНО ПОСЛЕДНИМИ ~10 МИНУТАМИ на клиенте —
// backend получает только уже урезанный текст, не хранит историю
// между циклами (см. обоснование в schema.prisma над LiveHintEvent).

import { useEffect, useRef, useState } from 'react';
import { startLiveAudioCapture, LiveAudioCaptureHandle, CaptureState } from '../lib/live-audio-capture';
import { connectLiveTranscription, LiveTranscriptionHandle, TranscriptUpdate } from '../lib/live-transcription';
import { mintTranscriptionToken, analyzeLiveHint, analyzeLiveHintForInterview, dismissLiveHintEvent } from '../lib/features';
import { checkThirdPartyAudioConsent, ThirdPartyAudioConsentPrompt } from './ThirdPartyAudioConsentPrompt';
import { LiveHintEvent } from '../lib/types';
import { haptic } from '../lib/telegram';

interface LiveHintsSessionProps {
  projectId: string;
  /** 'interview' — режим собеседования (следующий вопрос опросника), см. analyzeLiveHintForInterview */
  mode?: 'conversation' | 'interview';
}

const ANALYSIS_CYCLE_MS = 30_000; // до 30 секунд — согласованный, не мгновенный цикл
const TRANSCRIPT_WINDOW_MS = 10 * 60 * 1000; // последние ~10 минут

interface TranscriptSegment {
  text: string;
  timestamp: number;
}

export function LiveHintsSession({ projectId, mode = 'conversation' }: LiveHintsSessionProps) {
  const [expanded, setExpanded] = useState(false);
  const [captureState, setCaptureState] = useState<CaptureState>('idle');
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [hint, setHint] = useState<LiveHintEvent | null>(null);
  const [needsAudioConsent, setNeedsAudioConsent] = useState(false);

  const captureHandleRef = useRef<LiveAudioCaptureHandle | null>(null);
  const transcriptionHandleRef = useRef<LiveTranscriptionHandle | null>(null);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      transcriptionHandleRef.current?.stop();
      captureHandleRef.current?.stop();
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  function handleTranscript(update: TranscriptUpdate) {
    if (!update.isFinal) return; // копим только финализированные сегменты, не мельтешащие частичные
    segmentsRef.current.push({ text: update.text, timestamp: Date.now() });
  }

  async function handleStart() {
    if (!(await checkThirdPartyAudioConsent())) { setNeedsAudioConsent(true); return; }
    const captureHandle = await startLiveAudioCapture((state, errorMessage) => {
      setCaptureState(state);
      setCaptureError(errorMessage);
    });
    if (!captureHandle) return;
    captureHandleRef.current = captureHandle;
    segmentsRef.current = [];

    let token: string;
    try {
      const result = await mintTranscriptionToken();
      token = result.token;
    } catch {
      setCaptureState('error');
      setCaptureError('Не удалось получить доступ к транскрипции');
      captureHandle.stop();
      return;
    }

    // AudioContext и MediaStream переиспользуются напрямую из уже
    // открытого захвата (Пункт 81, расширен ради этого) — не второй
    // getUserMedia-запрос, не хрупкий доступ через приватные поля AnalyserNode.
    const audioContextForStream = captureHandle.getAudioContext();
    const transcriptionStream = captureHandle.getStream();
    if (!audioContextForStream || !transcriptionStream) {
      setCaptureState('error');
      setCaptureError('Не удалось получить аудиопоток для транскрипции');
      captureHandle.stop();
      return;
    }

    transcriptionHandleRef.current = connectLiveTranscription(
      token,
      audioContextForStream,
      transcriptionStream,
      handleTranscript,
      (message) => {
        setCaptureError(message);
      },
    );

    intervalRef.current = setInterval(async () => {
      const now = Date.now();
      const windowStart = now - TRANSCRIPT_WINDOW_MS;
      segmentsRef.current = segmentsRef.current.filter((s) => s.timestamp >= windowStart);
      const transcriptWindow = segmentsRef.current.map((s) => s.text).join(' ');
      if (!transcriptWindow.trim()) return;

      try {
        const result = mode === 'interview' ? await analyzeLiveHintForInterview(projectId, transcriptWindow) : await analyzeLiveHint(projectId, transcriptWindow);
        if (result) {
          setHint(result);
          haptic('light');
        }
      } catch {
        // Тихий сбой цикла анализа не должен ломать саму сессию — просто пропускаем этот цикл.
      }
    }, ANALYSIS_CYCLE_MS);
  }

  function handleStop() {
    transcriptionHandleRef.current?.stop();
    transcriptionHandleRef.current = null;
    captureHandleRef.current?.stop();
    captureHandleRef.current = null;
    if (intervalRef.current) clearInterval(intervalRef.current);
    setHint(null);
  }

  async function handleDismissHint() {
    if (hint) {
      dismissLiveHintEvent(projectId, hint.id).catch(() => {});
    }
    setHint(null);
  }

  if (!expanded) {
    return (
      <button type="button" onClick={() => setExpanded(true)}>
        🧪 Live-подсказки (экспериментально)
      </button>
    );
  }

  return (
    <section className="live-hints-session">
      <p className="steelman-case__label">Live-подсказки — экспериментально</p>
      <p className="conversations-section__hint">
        Подсказки приходят циклами до 30 секунд — не мгновенно, не настоящий real-time. Транскрипт разговора никуда
        не сохраняется, анализируется только последнее окно (~10 минут).
      </p>

      {hint && (
        <div className="live-hints-session__banner">
          <p>🟡 {hint.hintText}</p>
          <button type="button" onClick={handleDismissHint}>
            Понятно
          </button>
        </div>
      )}

      {needsAudioConsent && (
        <ThirdPartyAudioConsentPrompt source="live-hints-session" onGranted={() => { setNeedsAudioConsent(false); void handleStart(); }} onCancel={() => setNeedsAudioConsent(false)} />
      )}
      {!needsAudioConsent && captureState === 'idle' && (
        <button type="button" onClick={handleStart}>
          Начать
        </button>
      )}
      {captureState === 'requesting' && <p className="conversations-section__hint">Запрашиваем доступ к микрофону…</p>}
      {captureState === 'active' && (
        <>
          <p className="conversations-section__hint">🎙 Слушаем, анализируем циклами до 30 секунд…</p>
          <button type="button" onClick={handleStop}>
            Остановить
          </button>
        </>
      )}
      {captureState === 'error' && (
        <>
          <p className="generation-error">{captureError}</p>
          <button type="button" onClick={handleStart}>
            Попробовать снова
          </button>
        </>
      )}
      {captureState === 'stopped' && (
        <button type="button" onClick={handleStart}>
          Начать снова
        </button>
      )}
    </section>
  );
}

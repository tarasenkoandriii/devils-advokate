'use client';

// Пункт 81 (§3.31 ТЗ) → TMA UI: cooldown-нудж, первая живая фича за
// весь проект. Объединяет lib/live-audio-capture.ts (захват,
// непроверенная на практике стабильность в Telegram WebView, честно
// задокументированная как риск в Пункте 13) и lib/acoustic-monitor.ts
// (чистая, численно протестированная детекция).
//
// НАМЕРЕННО ОТДЕЛЬНАЯ ТОЧКА ВХОДА, НЕ ВСТРОЕНА В ЗАГРУЗКУ РАЗГОВОРА —
// ConversationsSection.tsx (Пункт 13) сознательно не строил живую
// запись из-за нестабильности. Эта секция — явный, маркированный как
// экспериментальный, первый реальный тест той стабильности, не тихая
// замена существующего потока загрузки.
//
// НЕ СОХРАНЯЕТ И НЕ ЗАГРУЖАЕТ САМ ЗВУК НИКУДА — только числовые
// метрики уже посчитанного локально сигнала уходят на backend при
// показе нуджа. "Живая сессия" здесь не создаёт Conversation-запись —
// это отдельная, честно суженная фича, не замена процесса загрузки.

import { useEffect, useRef, useState } from 'react';
import { startLiveAudioCapture, LiveAudioCaptureHandle, CaptureState } from '../lib/live-audio-capture';
import { computeRmsDb, detectEscalation, VolumeWindow, EscalationResult } from '../lib/acoustic-monitor';
import { logCooldownNudgeEvent, dismissCooldownNudgeEvent } from '../lib/features';
import { haptic } from '../lib/telegram';

interface CooldownNudgeSessionProps {
  projectId: string;
}

const SAMPLE_INTERVAL_MS = 500;
const NUDGE_COOLDOWN_MS = 60_000; // не показывать новый нудж чаще раза в минуту — "ненавязчиво", buкально ТЗ

export function CooldownNudgeSession({ projectId }: CooldownNudgeSessionProps) {
  const [expanded, setExpanded] = useState(false);
  const [captureState, setCaptureState] = useState<CaptureState>('idle');
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [nudge, setNudge] = useState<{ eventId: string; result: EscalationResult } | null>(null);

  const handleRef = useRef<LiveAudioCaptureHandle | null>(null);
  const windowsRef = useRef<VolumeWindow[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastNudgeAtRef = useRef<number>(0);

  useEffect(() => {
    // Остановка при размонтировании — не оставляем микрофон открытым
    // молча, если пользователь ушёл со страницы.
    return () => {
      handleRef.current?.stop();
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  async function handleStart() {
    const handle = await startLiveAudioCapture((state, errorMessage) => {
      setCaptureState(state);
      setCaptureError(errorMessage);
    });
    if (!handle) return;
    handleRef.current = handle;
    windowsRef.current = [];
    lastNudgeAtRef.current = 0;

    const dataArray = new Float32Array(2048);
    intervalRef.current = setInterval(async () => {
      const analyser = handle.getAnalyser();
      if (!analyser) return;
      analyser.getFloatTimeDomainData(dataArray);
      const rmsDb = computeRmsDb(dataArray);
      windowsRef.current.push({ rmsDb, timestamp: Date.now() });
      // Держим скользящее окно ограниченного размера, не растим буфер бесконечно на долгой сессии.
      if (windowsRef.current.length > 60) windowsRef.current.shift();

      const now = Date.now();
      if (now - lastNudgeAtRef.current < NUDGE_COOLDOWN_MS) return;
      const result = detectEscalation(windowsRef.current);
      if (result) {
        lastNudgeAtRef.current = now;
        try {
          const event = await logCooldownNudgeEvent(projectId, result.peakVolumeDb, result.escalationScore);
          setNudge({ eventId: event.id, result });
          haptic('light');
        } catch {
          // Тихий сбой логирования не должен ломать саму сессию — нудж всё равно показываем локально.
          setNudge({ eventId: '', result });
        }
      }
    }, SAMPLE_INTERVAL_MS);
  }

  function handleStop() {
    handleRef.current?.stop();
    handleRef.current = null;
    if (intervalRef.current) clearInterval(intervalRef.current);
    setNudge(null);
  }

  async function handleDismissNudge() {
    if (nudge?.eventId) {
      dismissCooldownNudgeEvent(projectId, nudge.eventId).catch(() => {});
    }
    setNudge(null);
  }

  if (!expanded) {
    return (
      <button type="button" onClick={() => setExpanded(true)}>
        🧪 Живая сессия (экспериментально)
      </button>
    );
  }

  return (
    <section className="cooldown-nudge-session">
      <p className="steelman-case__label">Живая сессия — экспериментально</p>
      <p className="conversations-section__hint">
        Проверка стабильности длительного захвата микрофона. Звук никуда не сохраняется и не передаётся — анализ
        полностью на устройстве, на сервер уходят только числа (не звук).
      </p>

      {nudge && (
        <div className="cooldown-nudge-session__banner">
          <p>🟡 Накал разговора вырос — возможно, стоит сделать паузу.</p>
          <p className="conversations-section__hint">{nudge.result.reason}</p>
          <button type="button" onClick={handleDismissNudge}>
            Понятно
          </button>
        </div>
      )}

      {captureState === 'idle' && (
        <button type="button" onClick={handleStart}>
          Начать
        </button>
      )}
      {captureState === 'requesting' && <p className="conversations-section__hint">Запрашиваем доступ к микрофону…</p>}
      {captureState === 'active' && (
        <>
          <p className="conversations-section__hint">🎙 Слушаем…</p>
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

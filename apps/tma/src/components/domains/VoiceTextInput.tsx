'use client';

// ТЗ §2.2 / §0 — голосовой ввод ответа как равноправный канал рядом с
// текстом. Переиспользует уже существующую live-транскрипцию (Пункты
// 81–82): токен с backend, браузер → сервис распознавания напрямую (провайдера выбирает язык: ru/uk — Soniox, en — AssemblyAI), аудио никуда
// не сохраняется. Без микрофона — честный текстовый fallback, не ошибка.
import { useEffect, useRef, useState } from 'react';
import { mintTranscriptionToken } from '../../lib/features';
import { checkThirdPartyAudioConsent, ThirdPartyAudioConsentPrompt } from '../ThirdPartyAudioConsentPrompt';
import { startLiveAudioCapture, LiveAudioCaptureHandle } from '../../lib/live-audio-capture';
import { connectLiveTranscription, LiveTranscriptionHandle } from '../../lib/live-transcription';
import { haptic } from '../../lib/telegram';
import { startSilenceWatchdog, SilenceWatchdogHandle, SILENCE_AUTO_STOP_MS } from '../../lib/silence-watchdog';

interface Props {
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function VoiceTextInput({ value, onChange, placeholder, disabled }: Props) {
  const [recording, setRecording] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [needsAudioConsent, setNeedsAudioConsent] = useState(false);
  const captureRef = useRef<LiveAudioCaptureHandle | null>(null);
  const wsRef = useRef<LiveTranscriptionHandle | null>(null);
  const silenceRef = useRef<SilenceWatchdogHandle | null>(null);
  const [autoStopped, setAutoStopped] = useState(false);
  const baseRef = useRef(''); // текст до начала записи — финальные фразы дописываются к нему

  function stop() {
    silenceRef.current?.stop(); silenceRef.current = null;
    wsRef.current?.stop(); wsRef.current = null;
    captureRef.current?.stop(); captureRef.current = null;
    setRecording(false);
  }

  useEffect(() => () => stop(), []);

  async function start() {
    setVoiceError(null);
    setAutoStopped(false);
    if (!(await checkThirdPartyAudioConsent())) { setNeedsAudioConsent(true); return; }
    baseRef.current = value;
    const capture = await startLiveAudioCapture((state, msg) => {
      if (state === 'error') { setVoiceError(msg); setRecording(false); }
    });
    if (!capture) return;
    captureRef.current = capture;
    try {
      // Пункт [stt-multi] 2026-09-02: провайдера выбирает язык пользователя.
      const credentials = await mintTranscriptionToken();
      const ctx = capture.getAudioContext();
      const stream = capture.getStream();
      if (!ctx || !stream) throw new Error('Аудиопоток недоступен');
      let partial = '';
      wsRef.current = connectLiveTranscription(
        credentials, ctx, stream,
        (update) => {
          silenceRef.current?.touch(); // текст от провайдера — это речь, даже тихая
          if (update.isFinal) {
            baseRef.current = `${baseRef.current} ${update.text}`.trim();
            partial = '';
            onChange(baseRef.current);
          } else {
            partial = update.text;
            onChange(`${baseRef.current} ${partial}`.trim());
          }
        },
        (message) => { setVoiceError(message); stop(); },
      );
      // 2026-09-02: авто-стоп после 30 с тишины — открытый микрофон и
      // счёт за минуты тишины против обещаний продукта (см. silence-watchdog.ts).
      silenceRef.current = startSilenceWatchdog(capture.getAnalyser(), () => {
        setAutoStopped(true);
        haptic('light');
        stop();
      });
      setRecording(true);
      haptic('light');
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : 'Голосовой ввод недоступен');
      stop();
    }
  }

  return (
    <div className="voice-text-input">
      <textarea rows={3} value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      {needsAudioConsent ? (
        <ThirdPartyAudioConsentPrompt source="voice-text-input" onGranted={() => { setNeedsAudioConsent(false); void start(); }} onCancel={() => setNeedsAudioConsent(false)} />
      ) : (
        <div className="voice-text-input__row">
          <button type="button" className={recording ? 'secondary voice-text-input__mic voice-text-input__mic--on' : 'secondary voice-text-input__mic'} disabled={disabled} onClick={recording ? stop : start}>
            {recording ? '■ Стоп' : '🎤 Голосом'}
          </button>
          {recording && <span className="voice-text-input__hint">Говорите — текст появится в поле, его можно править. Запись остановится сама после {SILENCE_AUTO_STOP_MS / 1000} с тишины</span>}
          {!recording && autoStopped && !voiceError && <span className="voice-text-input__hint">Запись остановлена: {SILENCE_AUTO_STOP_MS / 1000} с тишины. Нажмите «Голосом», чтобы продолжить</span>}
          {voiceError && <span className="voice-text-input__hint">{voiceError} — можно набрать текстом</span>}
        </div>
      )}
    </div>
  );
}

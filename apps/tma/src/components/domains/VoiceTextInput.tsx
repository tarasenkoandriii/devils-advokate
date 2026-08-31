'use client';

// ТЗ §2.2 / §0 — голосовой ввод ответа как равноправный канал рядом с
// текстом. Переиспользует уже существующую live-транскрипцию (Пункты
// 81–82): токен с backend, браузер → AssemblyAI напрямую, аудио никуда
// не сохраняется. Без микрофона — честный текстовый fallback, не ошибка.
import { useEffect, useRef, useState } from 'react';
import { mintTranscriptionToken } from '../../lib/features';
import { checkThirdPartyAudioConsent, ThirdPartyAudioConsentPrompt } from '../ThirdPartyAudioConsentPrompt';
import { startLiveAudioCapture, LiveAudioCaptureHandle } from '../../lib/live-audio-capture';
import { connectLiveTranscription, LiveTranscriptionHandle } from '../../lib/live-transcription';
import { haptic } from '../../lib/telegram';

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
  const baseRef = useRef(''); // текст до начала записи — финальные фразы дописываются к нему

  function stop() {
    wsRef.current?.stop(); wsRef.current = null;
    captureRef.current?.stop(); captureRef.current = null;
    setRecording(false);
  }

  useEffect(() => () => stop(), []);

  async function start() {
    setVoiceError(null);
    if (!(await checkThirdPartyAudioConsent())) { setNeedsAudioConsent(true); return; }
    baseRef.current = value;
    const capture = await startLiveAudioCapture((state, msg) => {
      if (state === 'error') { setVoiceError(msg); setRecording(false); }
    });
    if (!capture) return;
    captureRef.current = capture;
    try {
      const { token } = await mintTranscriptionToken();
      const ctx = capture.getAudioContext();
      const stream = capture.getStream();
      if (!ctx || !stream) throw new Error('Аудиопоток недоступен');
      let partial = '';
      wsRef.current = connectLiveTranscription(
        token, ctx, stream,
        (update) => {
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
        <ThirdPartyAudioConsentPrompt source="voice-text-input" onGranted={() => { setNeedsAudioConsent(false); start(); }} onCancel={() => setNeedsAudioConsent(false)} />
      ) : (
        <div className="voice-text-input__row">
          <button type="button" className={recording ? 'secondary voice-text-input__mic voice-text-input__mic--on' : 'secondary voice-text-input__mic'} disabled={disabled} onClick={recording ? stop : start}>
            {recording ? '■ Стоп' : '🎤 Голосом'}
          </button>
          {recording && <span className="voice-text-input__hint">Говорите — текст появится в поле, его можно править</span>}
          {voiceError && <span className="voice-text-input__hint">{voiceError} — можно набрать текстом</span>}
        </div>
      )}
    </div>
  );
}

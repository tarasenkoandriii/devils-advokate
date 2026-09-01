'use client';

// Пункт [sandbox-voice] 2026-09-01 — голосовой ввод квиза в песочнице,
// «всё как в ТМА»: ТОТ ЖЕ путь, что у VoiceTextInput из TMA — токен с
// backend (продовый mintTranscriptionToken, требует согласия
// THIRD_PARTY_AUDIO_RECORDING), браузер → AssemblyAI напрямую по
// WebSocket, аудио через наш backend не проходит и нигде не
// сохраняется. Библиотеки live-audio-capture/live-transcription
// скопированы из TMA дословно (они без зависимостей — единственный
// способ гарантировать «тот же код, тот же протокол»).
//
// Отличия от TMA-версии — только обвязка платформы: нет Telegram-
// haptic, и вместо отдельного экрана согласия — подсказка нажать
// «Выдать согласия» в чеклисте (отказ 403 — результат прогона).
import { useEffect, useRef, useState } from 'react';
import { sandboxTranscriptionToken } from '../lib/endpoints';
import { startLiveAudioCapture, LiveAudioCaptureHandle } from '../lib/live-audio-capture';
import { connectLiveTranscription, LiveTranscriptionHandle } from '../lib/live-transcription';

interface Props {
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
}

export function VoiceTextInput({ value, onChange, placeholder, disabled, rows = 3 }: Props) {
  const [recording, setRecording] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const captureRef = useRef<LiveAudioCaptureHandle | null>(null);
  const wsRef = useRef<LiveTranscriptionHandle | null>(null);
  // Текст до начала записи — финальные фразы дописываются к нему,
  // partial-фразы показываются поверх и заменяются (как в TMA).
  const baseRef = useRef('');

  function stop() {
    wsRef.current?.stop();
    wsRef.current = null;
    captureRef.current?.stop();
    captureRef.current = null;
    setRecording(false);
  }

  useEffect(() => () => stop(), []);

  async function start() {
    setVoiceError(null);
    baseRef.current = value;
    const capture = await startLiveAudioCapture((state, msg) => {
      if (state === 'error') {
        setVoiceError(msg);
        setRecording(false);
      }
    });
    if (!capture) return;
    captureRef.current = capture;
    try {
      const { token } = await sandboxTranscriptionToken();
      const ctx = capture.getAudioContext();
      const stream = capture.getStream();
      if (!ctx || !stream) throw new Error('Аудиопоток недоступен');
      let partial = '';
      wsRef.current = connectLiveTranscription(
        token,
        ctx,
        stream,
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
        (message) => {
          setVoiceError(message);
          stop();
        },
      );
      setRecording(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Голосовой ввод недоступен';
      setVoiceError(
        /согласи|THIRD_PARTY|403|Forbidden/i.test(message)
          ? 'Нужно согласие на передачу аудио — нажмите «Выдать согласия» в чеклисте готовности'
          : message,
      );
      stop();
    }
  }

  return (
    <div>
      <textarea
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <button type="button" disabled={disabled} onClick={recording ? stop : start}>
          {recording ? '■ Стоп' : '🎤 Голосом'}
        </button>
        {recording && <span className="muted" style={{ fontSize: 12 }}>Говорите — текст появится в поле, его можно править</span>}
        {voiceError && <span className="muted" style={{ fontSize: 12, color: 'var(--signal-critical)' }}>{voiceError} — можно набрать текстом</span>}
      </div>
    </div>
  );
}

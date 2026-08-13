'use client';

// Пункт 71 (backend) → TMA UI: озвучка компромиссного листа
// собственным голосом через текстовый суфлёр (§3.41 ТЗ, пункт 60
// общего списка). Изолированный компонент — вся обработка аудио
// делегирована lib/audio-post-process.ts (протестировано на реальных
// числовых данных, не только скомпилировано).
//
// "Прослушать перед отправкой — обязательный шаг, отправка без
// прослушивания недоступна" (buкально ТЗ) — кнопка сохранения
// заблокирована, пока пользователь не запустит воспроизведение
// обработанной записи хотя бы раз.

import { useState } from 'react';
import { postProcessAudio } from '../lib/audio-post-process';
import { submitCompromiseSheetUserVoice } from '../lib/features';
import { CompromiseSheet } from '../lib/types';
import { haptic } from '../lib/telegram';

interface UserVoiceRecordingSectionProps {
  sheet: CompromiseSheet;
  onSaved: (updated: CompromiseSheet) => void;
  onClose: () => void;
}

type Stage = 'idle' | 'recording' | 'processing' | 'ready' | 'saving';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function UserVoiceRecordingSection({ sheet, onSaved, onClose }: UserVoiceRecordingSectionProps) {
  const [stage, setStage] = useState<Stage>('idle');
  const [normalizeVolume, setNormalizeVolume] = useState(true);
  const [removePauses, setRemovePauses] = useState(true);
  const [removeNoise, setRemoveNoise] = useState(false);
  const [processedBlob, setProcessedBlob] = useState<Blob | null>(null);
  const [processedUrl, setProcessedUrl] = useState<string | null>(null);
  const [hasListened, setHasListened] = useState(false);
  const [scrollIndex, setScrollIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useState<{ current: MediaRecorder | null }>({ current: null })[0];
  const chunksRef = useState<{ current: Blob[] }>({ current: [] })[0];

  const fullText = sheet.items.map((i) => i.argument.text).join('. ');

  async function handleStartRecording() {
    if (!('mediaDevices' in navigator)) {
      setError('Запись голоса недоступна в этом браузере/приложении');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.start();
      mediaRecorderRef.current = recorder;
      setStage('recording');
      setScrollIndex(0);
    } catch {
      setError('Доступ к микрофону не предоставлен');
    }
  }

  function handleStopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    recorder.onstop = async () => {
      recorder.stream.getTracks().forEach((t) => t.stop());
      const rawBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
      await handleProcess(rawBlob);
    };
    recorder.stop();
  }

  async function handleProcess(rawBlob: Blob) {
    setStage('processing');
    setError(null);
    try {
      const processed = await postProcessAudio(rawBlob, { normalizeVolume, removePauses, removeNoise });
      setProcessedBlob(processed);
      setProcessedUrl(URL.createObjectURL(processed));
      setHasListened(false);
      setStage('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось обработать запись');
      setStage('idle');
    }
  }

  function handlePlay() {
    if (!processedUrl) return;
    const audio = new Audio(processedUrl);
    audio.onended = () => setHasListened(true);
    audio.play();
  }

  async function handleSave() {
    if (!processedBlob || !hasListened) return;
    setStage('saving');
    setError(null);
    try {
      const audioBase64 = await blobToBase64(processedBlob);
      const updated = await submitCompromiseSheetUserVoice(sheet.id, {
        audioBase64,
        normalizeVolume,
        removePauses,
        removeNoise,
      });
      onSaved(updated);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить запись');
      setStage('ready');
    }
  }

  return (
    <div className="user-voice-recording">
      <p className="steelman-case__label">Читайте вслух — текст ниже прокручивается</p>

      {stage === 'recording' && (
        <div className="user-voice-recording__teleprompter">
          <p>{fullText}</p>
        </div>
      )}

      {stage === 'idle' && (
        <>
          <div className="user-voice-recording__options">
            <label>
              <input type="checkbox" checked={normalizeVolume} onChange={(e) => setNormalizeVolume(e.target.checked)} />
              Выровнять громкость
            </label>
            <label>
              <input type="checkbox" checked={removePauses} onChange={(e) => setRemovePauses(e.target.checked)} />
              Убрать паузы
            </label>
            <label>
              <input type="checkbox" checked={removeNoise} onChange={(e) => setRemoveNoise(e.target.checked)} />
              Убрать сторонние шумы (фильтр низких частот — не полное шумоподавление)
            </label>
          </div>
          <button type="button" onClick={handleStartRecording}>
            🎤 Начать запись
          </button>
        </>
      )}

      {stage === 'recording' && (
        <button type="button" onClick={handleStopRecording}>
          ⏹ Остановить и обработать
        </button>
      )}

      {stage === 'processing' && <p className="conversations-section__hint">Обрабатываем запись на устройстве…</p>}

      {stage === 'ready' && (
        <>
          <button type="button" onClick={handlePlay}>
            ▶ Прослушать
          </button>
          {!hasListened && (
            <p className="conversations-section__hint">Прослушайте запись целиком, прежде чем сохранить — отправка без прослушивания недоступна.</p>
          )}
          <div className="conversations-section__add-actions">
            <button type="button" onClick={handleSave} disabled={!hasListened}>
              Сохранить как озвучку листа
            </button>
            <button type="button" onClick={onClose}>
              Отмена
            </button>
          </div>
        </>
      )}

      {stage === 'saving' && <p className="conversations-section__hint">Сохраняем…</p>}

      {error && <p className="generation-error">{error}</p>}
    </div>
  );
}

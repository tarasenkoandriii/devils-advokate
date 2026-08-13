'use client';

// Пункт 87 → TMA UI: регистрация голосового отпечатка при онбординге.
// Тот же паттерн записи, что UserVoiceRecordingSection.tsx (Пункт 71,
// суфлёр) — MediaRecorder + decodeToRawAudio() для получения сырых
// сэмплов, дальше извлечение эмбеддинга через WASM (Пункт 87,
// voice-embedding.ts) и отправка ТОЛЬКО вектора на backend.
//
// НАМЕРЕННО ЭКСПЕРИМЕНТАЛЬНАЯ, НЕОБЯЗАТЕЛЬНАЯ СЕКЦИЯ — та же явная
// маркировка, что у всех live-фич проекта (Пункты 81-86). Без
// регистрации детектор прощупывания просто продолжает работать без
// автоматической фильтрации "я/не я" — эта секция не блокирует
// остальной онбординг.

import { useRef, useState } from 'react';
import { decodeToRawAudio } from '../lib/audio-post-process';
import { loadVoiceEmbeddingExtractor, embeddingToArray } from '../lib/voice-embedding';
import { enrollVoiceEmbedding, getVoiceEnrollmentStatus, revokeVoiceEmbedding, listConsents, hasConsent } from '../lib/features';
import { VoiceBiometricConsentPrompt } from './VoiceBiometricConsentPrompt';
import { haptic } from '../lib/telegram';

// Путь к .onnx-модели эмбеддинга — должен быть выложен статически в
// TMA (см. ссылку на релиз sherpa-onnx в /TODO.md). Не проверено в
// этой среде разработки — нет сети для скачивания самой модели.
const EMBEDDING_MODEL_URL = '/models/speaker-embedding.onnx';

type EnrollmentState = 'idle' | 'checking' | 'need-consent' | 'recording' | 'processing' | 'enrolled' | 'error';

export function VoiceEnrollmentSection() {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<EnrollmentState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function handleExpand() {
    setExpanded(true);
    setState('checking');
    try {
      const status = await getVoiceEnrollmentStatus();
      setState(status.enrolled ? 'enrolled' : 'idle');
    } catch {
      setState('idle');
    }
  }

  async function handleStartRecording() {
    // "Один экран согласия... не разрозненные пуш-запросы" — тот же
    // принцип, что у геолокации (Пункт 77), но отдельный тип согласия.
    const consents = await listConsents().catch(() => []);
    if (!hasConsent(consents, 'VOICE_BIOMETRIC')) {
      setState('need-consent');
      return;
    }
    await beginRecording();
  }

  async function beginRecording() {
    if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) {
      setState('error');
      setErrorMessage('Микрофон недоступен в этом браузере/приложении');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState('error');
      setErrorMessage('Доступ к микрофону не предоставлен');
      return;
    }

    chunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      void processRecording();
    };
    mediaRecorderRef.current = recorder;
    recorder.start();
    setState('recording');

    // Короткий образец достаточен для эмбеддинга — не нужна длинная запись.
    setTimeout(() => {
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
    }, 5000);
  }

  async function processRecording() {
    setState('processing');
    try {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      const raw = await decodeToRawAudio(blob);

      const extractor = await loadVoiceEmbeddingExtractor(EMBEDDING_MODEL_URL);
      if (!extractor) {
        setState('error');
        setErrorMessage('Не удалось загрузить модуль извлечения голосового отпечатка');
        return;
      }

      const embedding = extractor.extractEmbedding(raw.channels[0], raw.sampleRate);
      if (!embedding) {
        setState('error');
        setErrorMessage('Не удалось извлечь отпечаток — попробуйте записать образец подлиннее');
        return;
      }

      await enrollVoiceEmbedding(embeddingToArray(embedding));
      setState('enrolled');
      haptic('success');
    } catch {
      setState('error');
      setErrorMessage('Не удалось обработать запись');
      haptic('error');
    }
  }

  async function handleRevoke() {
    try {
      await revokeVoiceEmbedding();
      setState('idle');
      haptic('light');
    } catch {
      haptic('error');
    }
  }

  if (!expanded) {
    return (
      <button type="button" onClick={handleExpand}>
        🧪 Голосовой отпечаток (экспериментально)
      </button>
    );
  }

  return (
    <section className="voice-enrollment-section">
      <p className="steelman-case__label">Голосовой отпечаток</p>

      {state === 'checking' && <p className="conversations-section__hint">Проверяем…</p>}

      {state === 'need-consent' && (
        <VoiceBiometricConsentPrompt onGranted={beginRecording} onCancel={() => setState('idle')} />
      )}

      {state === 'idle' && (
        <>
          <p className="conversations-section__hint">
            Не зарегистрирован. Приложение сможет автоматически отличать вас от собеседника во время живых сессий.
          </p>
          <button type="button" onClick={handleStartRecording}>
            Записать образец голоса
          </button>
        </>
      )}

      {state === 'recording' && <p className="conversations-section__hint">🎙 Говорите — например, назовите своё имя… (5 секунд)</p>}
      {state === 'processing' && <p className="conversations-section__hint">Обрабатываем запись…</p>}

      {state === 'enrolled' && (
        <>
          <p className="conversations-section__hint">✅ Голосовой отпечаток зарегистрирован.</p>
          <button type="button" onClick={handleRevoke}>
            Отозвать
          </button>
        </>
      )}

      {state === 'error' && (
        <>
          <p className="generation-error">{errorMessage}</p>
          <button type="button" onClick={handleStartRecording}>
            Попробовать снова
          </button>
        </>
      )}
    </section>
  );
}
